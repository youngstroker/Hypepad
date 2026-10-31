import express from 'express';
import { config, publicConfig } from './config.js';
import { db, now } from './db.js';
import { getPrices, lastPrices } from './prices.js';
import * as orders from './orders.js';
import * as sol from './solana.js';
import * as evm from './hyperevm.js';
import { InputError, evmAddress } from './validate.js';
import { indexerLag } from './indexer.js';
import * as uploads from './uploads.js';
import { log } from './log.js';

export const api = express.Router();

// ---------------------------------------------------------------- helpers

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// IPv6 users usually control a whole /64, so limit by that prefix (of the
// fully expanded address, so '::' shorthand cannot produce many keys).
function clientKey(ip = '') {
    if (!ip.includes(':') || ip.startsWith('::ffff:')) return ip;
    const [head, tail = ''] = ip.split('%')[0].split('::');
    const a = head ? head.split(':') : [];
    const b = tail ? tail.split(':') : [];
    const full = ip.includes('::') ? [...a, ...Array(8 - a.length - b.length).fill('0'), ...b] : a;
    return full.slice(0, 4).map((g) => g.padStart(4, '0').toLowerCase()).join(':');
}

function rateLimit({ windowMs, max }) {
    const hits = new Map();
    setInterval(() => hits.clear(), windowMs).unref();
    return (req, res, next) => {
        const key = clientKey(req.ip);
        const n = (hits.get(key) || 0) + 1;
        if (hits.size < 200_000 || hits.has(key)) hits.set(key, n);
        if (n > max) return res.status(429).json({ error: 'Too many requests. Slow down a little.' });
        next();
    };
}

const writeLimit = rateLimit({ windowMs: 60_000, max: 40 });
const paymentLimit = rateLimit({ windowMs: 60_000, max: 120 });
const uploadLimit = rateLimit({ windowMs: 10 * 60_000, max: 20 });
const chainLimit = rateLimit({ windowMs: 60_000, max: 90 }); // endpoints that cost an RPC call
const readLimit = rateLimit({ windowMs: 60_000, max: 600 });
api.use(readLimit);

/** Tiny TTL cache so repeated identical reads cost one RPC call, not one per visitor. */
function cached(ttlMs, max = 5000) {
    const store = new Map();
    return async (key, load) => {
        const hit = store.get(key);
        if (hit && Date.now() - hit.at < ttlMs) return hit.value;
        const value = await load();
        if (store.size >= max) store.delete(store.keys().next().value);
        store.set(key, { at: Date.now(), value });
        return value;
    };
}
const quoteCache = cached(3000);
const chartCache = cached(5000, 2000);
const chainCache = cached(2000, 20000);

const TOTAL_SUPPLY_TOKENS = 1e9;

function tokenView(t, prices, extra = {}) {
    const hypeUsd = prices?.hypeUsd || 0;
    const curveSupply = Number(t.curve_supply);
    const sold = curveSupply - Number(t.real_token);
    return {
        address: t.address,
        name: t.name,
        symbol: t.symbol,
        description: t.description || '',
        image: t.image || null,
        twitter: t.twitter || null,
        telegram: t.telegram || null,
        website: t.website || null,
        creator: t.creator,
        pair: t.pair,
        createTx: t.create_tx,
        createdAt: t.created_at,
        priceHype: t.price_hype,
        priceUsd: t.price_hype * hypeUsd,
        marketCapHype: t.price_hype * (Number(t.total_supply) / 1e18 || TOTAL_SUPPLY_TOKENS),
        marketCapUsd: t.price_hype * (Number(t.total_supply) / 1e18 || TOTAL_SUPPLY_TOKENS) * hypeUsd,
        raisedHype: Number(t.real_hype) / 1e18,
        progress: curveSupply > 0 ? Math.min(100, (sold / curveSupply) * 100) : 0,
        volumeHype: t.volume_hype,
        trades: t.trade_count,
        lastTradeAt: t.last_trade_at,
        complete: Boolean(t.complete),
        migrated: Boolean(t.migrated),
        change24h: t.price_24h ? ((t.price_hype - t.price_24h) / t.price_24h) * 100 : null,
        volume24hHype: t.volume_24h ?? null,
        ...extra,
    };
}

const TOKEN_SELECT = `
    SELECT t.*,
        (SELECT price_hype FROM trades WHERE token = t.address AND timestamp <= ?1 ORDER BY timestamp DESC, log_index DESC LIMIT 1) AS price_before,
        (SELECT COALESCE(SUM(hype_amount), 0) FROM trades WHERE token = t.address AND timestamp > ?1) AS volume_24h
    FROM tokens t`;

// The reference price for "24h change" is the last trade before the cutoff,
// or the launch price for coins with no trade that old.
const withChange = (row) => ({ ...row, price_24h: row.price_before ?? row.launch_price });

// ---------------------------------------------------------------- config & market data

api.get('/config', wrap(async (req, res) => {
    const status = await orders.readiness();
    const s = status.state;
    res.json({
        ...publicConfig(),
        ready: status.ready,
        notReadyReasons: status.reasons,
        curve: s ? {
            virtualHype: s.params.virtualHype.toString(),
            virtualToken: s.params.virtualToken.toString(),
            curveSupply: s.params.curveSupply.toString(),
            totalSupply: s.params.totalSupply.toString(),
            tradeFeeBps: s.protocolFeeBps + s.creatorFeeBps,
            creatorFeeBps: s.creatorFeeBps,
            migrationFeeBps: s.migrationFeeBps,
        } : null,
    });
}));

api.get('/prices', wrap(async (req, res) => {
    try {
        const p = await getPrices();
        res.json({ solUsd: p.solUsd, hypeUsd: p.hypeUsd, solHype: p.solHype, source: p.source, at: p.at });
    } catch (err) {
        const p = lastPrices();
        if (!p) throw new InputError(err.message, 503);
        res.json({ solUsd: p.solUsd, hypeUsd: p.hypeUsd, solHype: p.solHype, source: p.source, at: p.at, stale: true });
    }
}));

api.get('/stats', (req, res) => {
    const s = db.prepare(`SELECT COUNT(*) AS tokens, COALESCE(SUM(volume_hype), 0) AS volume, COALESCE(SUM(complete), 0) AS graduated FROM tokens`).get();
    const day = db.prepare(`SELECT COUNT(*) AS trades, COALESCE(SUM(hype_amount), 0) AS volume FROM trades WHERE timestamp > ?`).get(now() - 86400);
    const p = lastPrices();
    res.json({ tokens: s.tokens, graduated: s.graduated, volumeHype: s.volume, volume24hHype: day.volume, trades24h: day.trades, hypeUsd: p?.hypeUsd || null });
});

api.get('/activity', (req, res) => {
    const rows = db.prepare(`SELECT tr.*, t.symbol, t.image FROM trades tr JOIN tokens t ON t.address = tr.token WHERE t.hidden = 0 ORDER BY tr.timestamp DESC, tr.log_index DESC LIMIT 30`).all();
    res.json(rows.map((r) => ({ token: r.token, symbol: r.symbol, image: r.image, isBuy: Boolean(r.is_buy), hype: r.hype_amount, trader: r.trader, timestamp: r.timestamp })));
});

const SORTS = {
    new: 't.created_at DESC',
    trending: 'volume_24h DESC, t.last_trade_at DESC',
    mcap: 't.price_hype DESC',
    active: 't.last_trade_at DESC NULLS LAST',
    graduated: 't.created_at DESC',
};

api.get('/tokens', (req, res) => {
    const sort = SORTS[req.query.sort] ? req.query.sort : 'new';
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 24, 1), 60);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 64) : '';

    const where = ['t.hidden = 0'];
    const params = [now() - 86400];
    if (sort === 'graduated') where.push('t.complete = 1');
    if (q) {
        if (/^0x[0-9a-fA-F]{40}$/.test(q)) {
            where.push('LOWER(t.address) = LOWER(?)');
            params.push(q);
        } else {
            where.push(`(t.name LIKE ? ESCAPE '\\' OR t.symbol LIKE ? ESCAPE '\\')`);
            const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
            params.push(like, like);
        }
    }
    const sql = `${TOKEN_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${SORTS[sort]} LIMIT ${limit + 1} OFFSET ${offset}`;
    const rows = db.prepare(sql).all(...params).map(withChange);
    const prices = lastPrices();
    res.json({ tokens: rows.slice(0, limit).map((r) => tokenView(r, prices)), hasMore: rows.length > limit });
});

api.get('/tokens/:address', (req, res) => {
    const address = evmAddress(req.params.address, 'Token');
    const row = db.prepare(`${TOKEN_SELECT} WHERE t.address = ?2 AND t.hidden = 0`).get(now() - 86400, address);
    if (!row) throw new InputError('Token not found.', 404);
    const trades = db.prepare('SELECT * FROM trades WHERE token = ? ORDER BY timestamp DESC, log_index DESC LIMIT 50').all(address);
    const holders = db.prepare(`SELECT COUNT(DISTINCT recipient) AS n FROM trades WHERE token = ? AND is_buy = 1`).get(address).n;
    res.json(tokenView(withChange(row), lastPrices(), {
        holdersApprox: holders,
        recentTrades: trades.map((t) => ({
            tx: t.tx_hash, isBuy: Boolean(t.is_buy), trader: t.is_buy ? t.recipient : t.trader,
            hype: t.hype_amount, tokens: t.token_amount, price: t.price_hype, timestamp: t.timestamp,
        })),
    }));
});

api.get('/tokens/:address/chart', wrap(async (req, res) => {
    const address = evmAddress(req.params.address, 'Token');
    const points = await chartCache(address, async () => {
        const token = db.prepare('SELECT created_at, launch_price FROM tokens WHERE address = ? AND hidden = 0').get(address);
        if (!token) return null;
        // At most ~400 buckets, each the last trade price in its time slice,
        // computed in SQL so a coin with a long history stays cheap.
        const span = db.prepare('SELECT MIN(timestamp) AS a, MAX(timestamp) AS b FROM trades WHERE token = ?').get(address);
        const width = Math.max(1, Math.ceil(((span.b ?? 0) - (span.a ?? 0) + 1) / 400));
        const rows = db.prepare(`SELECT b.t AS t,
                (SELECT price_hype FROM trades t2 WHERE t2.token = ?1 AND t2.timestamp <= b.t
                    ORDER BY t2.timestamp DESC, t2.log_index DESC LIMIT 1) AS p
            FROM (SELECT MAX(timestamp) AS t FROM trades WHERE token = ?1
                  GROUP BY CAST((timestamp - ?2) / ?3 AS INTEGER)) b
            ORDER BY b.t`).all(address, BigInt(span.a ?? 0), BigInt(width));
        // Seed with the launch price so a fresh coin still draws a line.
        return [{ t: token.created_at, p: token.launch_price }, ...rows];
    });
    if (!points) throw new InputError('Token not found.', 404);
    res.json(points);
}));

api.get('/tokens/:address/quote', chainLimit, wrap(async (req, res) => {
    const address = evmAddress(req.params.address, 'Token');
    const amount = String(req.query.amount || '');
    if (!/^\d{1,40}$/.test(amount) || amount === '0') throw new InputError('amount must be a positive integer in wei.');
    if (!db.prepare('SELECT 1 FROM tokens WHERE address = ? AND complete = 0').get(address)) throw new InputError('Not trading on the curve.', 404);
    const side = req.query.side === 'sell' ? 'sell' : 'buy';
    res.json(await quoteCache(`${address}:${side}:${amount}`, async () => {
        if (side === 'sell') {
            const q = await evm.quoteSell(address, BigInt(amount));
            return { hypeOut: q.hypeOut.toString(), fee: q.fee.toString() };
        }
        const q = await evm.quoteBuy(address, BigInt(amount), { visitor: true });
        return { tokensOut: q.tokensOut.toString(), fee: q.fee.toString(), refund: q.refund.toString() };
    }));
}));

// Standard token metadata (the on-chain `uri` points here).
api.get('/metadata/:orderId', (req, res) => {
    const row = db.prepare(`SELECT payload, token FROM orders WHERE id = ? AND kind = 'launch'`).get(req.params.orderId);
    if (!row) throw new InputError('Not found.', 404);
    const p = JSON.parse(row.payload);
    res.set('cache-control', 'public, max-age=3600').json({
        name: p.name,
        symbol: p.symbol,
        description: p.description,
        image: `${config.publicUrl}${p.image}`,
        external_url: row.token ? `${config.publicUrl}/coin/${row.token}` : config.publicUrl,
        twitter: p.twitter || undefined,
        telegram: p.telegram || undefined,
        website: p.website || undefined,
    });
});

// ---------------------------------------------------------------- uploads

const IMAGE_TYPES = [
    { ext: 'png', test: (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47 },
    { ext: 'jpg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
    { ext: 'gif', test: (b) => b.length > 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1')) },
    { ext: 'webp', test: (b) => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];

api.post('/upload', uploadLimit, express.raw({ type: () => true, limit: config.limits.maxUploadBytes }), (req, res) => {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || !buf.length) throw new InputError('No image received.');
    const type = IMAGE_TYPES.find((t) => t.test(buf));
    if (!type) throw new InputError('Use a PNG, JPG, GIF, or WEBP image.');
    try {
        res.json({ image: uploads.save(buf, type.ext, clientKey(req.ip)) });
    } catch (err) {
        if (err instanceof uploads.UploadRefused) throw new InputError(err.message, 503);
        throw err;
    }
});

// ---------------------------------------------------------------- orders

api.post('/orders/launch', writeLimit, express.json({ limit: '16kb' }), wrap(async (req, res) => {
    res.status(201).json(await orders.createLaunchOrder(req.body || {}, { ip: clientKey(req.ip) }));
}));

api.post('/orders/buy', writeLimit, express.json({ limit: '4kb' }), wrap(async (req, res) => {
    res.status(201).json(await orders.createBuyOrder(req.body || {}, { ip: clientKey(req.ip) }));
}));

api.get('/orders/:id', (req, res) => {
    const order = orders.getOrder(req.params.id);
    if (!order) throw new InputError('Order not found.', 404);
    res.json(order);
});

// The client reports its signature right away; the treasury watcher would
// find it anyway, this only makes it faster.
api.post('/orders/:id/payment', paymentLimit, express.json({ limit: '2kb' }), wrap(async (req, res) => {
    const order = orders.getOrder(req.params.id);
    if (!order) throw new InputError('Order not found.', 404);
    const result = await orders.ingestSignature(req.body?.signature);
    if (result.state === 'matched' && result.orderId === order.id) orders.runExecutor().catch(() => {});
    res.json({ result, order: orders.getOrder(order.id) });
}));

// ---------------------------------------------------------------- chain helpers for the browser

// Lets the browser tell when an unconfirmed payment's blockhash expired, so
// it can safely offer to pay again.
api.get('/solana/blockheight', chainLimit, wrap(async (req, res) => {
    const blockHeight = await chainCache('blockheight', () => sol.blockHeight());
    res.set('cache-control', 'no-store').json({ blockHeight });
}));

// Whether Solana knows a signature: lets the browser confirm a payment really
// vanished before offering to pay again.
api.get('/solana/signature/:sig', chainLimit, wrap(async (req, res) => {
    if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(req.params.sig)) throw new InputError('Invalid signature.');
    res.set('cache-control', 'no-store').json({ state: await chainCache(`sig:${req.params.sig}`, () => sol.signatureState(req.params.sig)) });
}));

api.get('/solana/blockhash', chainLimit, wrap(async (req, res) => {
    const { blockhash, lastValidBlockHeight } = await sol.latestBlockhash();
    res.set('cache-control', 'no-store').json({ blockhash, lastValidBlockHeight });
}));

// For wallets that can sign but not send: forwards an already-signed
// transaction to the RPC. The server cannot alter a signed transaction.
api.post('/solana/broadcast', writeLimit, express.json({ limit: '4kb' }), wrap(async (req, res) => {
    const raw = req.body?.transaction;
    if (typeof raw !== 'string' || !/^[A-Za-z0-9+/=]{100,2000}$/.test(raw)) throw new InputError('Invalid transaction.');
    try {
        res.json({ signature: await sol.broadcastRaw(raw) });
    } catch (err) {
        throw new InputError(`Solana rejected the transaction: ${err.message.slice(0, 200)}`);
    }
}));

api.get('/solana/balance/:address', chainLimit, wrap(async (req, res) => {
    if (!sol.isSolAddress(req.params.address)) throw new InputError('Invalid Solana address.');
    res.json({ lamports: await chainCache(`sol:${req.params.address}`, () => sol.solBalance(req.params.address)) });
}));

api.get('/evm/balances', chainLimit, wrap(async (req, res) => {
    const owner = evmAddress(req.query.owner, 'owner');
    const token = req.query.token ? evmAddress(req.query.token, 'token') : null;
    const b = await chainCache(`evm:${owner}:${token}`, () => evm.evmBalances(owner, token));
    res.json({ hype: b.hype.toString(), token: b.token.toString(), allowance: b.allowance.toString() });
}));

api.get('/health', wrap(async (req, res) => {
    const status = await orders.readiness();
    const pending = db.prepare(`SELECT status, COUNT(*) AS n FROM orders WHERE status IN ('paid','processing','refunding','needs_review') GROUP BY status`).all();
    const refunds = db.prepare(`SELECT status, COUNT(*) AS n FROM refunds WHERE status IN ('pending','manual') GROUP BY status`).all();
    res.json({ ok: true, ready: status.ready, reasons: status.reasons, indexedThroughBlock: indexerLag(), pending, refunds });
}));

// ---------------------------------------------------------------- errors

api.use((req, res) => res.status(404).json({ error: 'Not found.' }));

// eslint-disable-next-line no-unused-vars
api.use((err, req, res, next) => {
    if (err instanceof InputError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That file is too large.' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON.' });
    log.error('api.error', { path: req.path, err: err.shortMessage || err.message });
    res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
});
