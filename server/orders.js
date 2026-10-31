// Orders: a quote the user pays in SOL, which the relayer then fills on HyperEVM.
//
//   awaiting_payment ──(finalized SOL deposit with the order's memo, full amount)──▶ paid
//   paid ──(signed tx saved, then broadcast)──▶ processing ──▶ completed
//   any failure after payment ──▶ refunding ──(treasury sends SOL back)──▶ refunded
//   relayer nonce used with no receipt for our tx (should never happen) ──▶ needs_review
//
// Every SOL that should go back (failed order, unused part of a fill,
// overpayment, underpaid or duplicate deposit) becomes one row in `refunds`,
// keyed by its reason, so it can be paid at most once.
//
// The HYPE amount is priced again at execution with fresh prices, and the
// user's slippage limit applies to the tokens they receive. If execution would
// give them less than that, the order fails and the SOL is refunded.
import crypto from 'node:crypto';
import { decodeEventLog } from 'viem';
import { PublicKey } from '@solana/web3.js';
import { config } from './config.js';
import { db, now, tx, kvGet, kvSet } from './db.js';
import { getPrices } from './prices.js';
import * as sol from './solana.js';
import * as evm from './hyperevm.js';
import * as v from './validate.js';
import { log } from './log.js';
import * as slot from './txslot.js';
import * as uploads from './uploads.js';

const MEMO_PREFIX = 'hp1:';
const WEI_PER_LAMPORT = 1_000_000_000n;
const OPEN_STATUSES = ['awaiting_payment', 'paid', 'processing'];
const MAX_ATTEMPTS = 5;
const RELAYER_WAIT_SEC = 15 * 60;
const MAX_OPEN_QUOTES_PER_IP = 5;
// Refunding less than this costs the treasury more in fees than it returns;
// such deposits (spam dust) are recorded and skipped.
const MIN_REFUND_LAMPORTS = 50_000;
const NOT_FOUND_RETRIES = 15;
const UNREADABLE = 'needs_manual_review:not_found';

// ---------------------------------------------------------------- pricing

/** HYPE wei the relayer spends for `lamports` of SOL, after the conversion spread. */
export function hypeForLamports(lamports, solHype, spreadBps = config.fees.conversionSpreadBps) {
    const rate = BigInt(Math.floor(solHype * (1 - spreadBps / 10_000) * 1e12));
    return (BigInt(lamports) * WEI_PER_LAMPORT * rate) / 1_000_000_000_000n;
}

const applySlippage = (amount, bps) => (BigInt(amount) * BigInt(10_000 - bps)) / 10_000n;

// Only paid work reserves relayer HYPE; unpaid quotes are free to create, so
// letting them reserve capacity would let anyone block the launchpad.
async function committedHypeWei() {
    const rows = db.prepare(`SELECT quote_hype_wei FROM orders WHERE status IN ('paid','processing')`).all();
    return rows.reduce((sum, r) => sum + BigInt(r.quote_hype_wei), 0n);
}

function checkOpenQuotes(ip) {
    if (!ip) return;
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE client_ip = ? AND status = 'awaiting_payment' AND expires_at > ?`).get(ip, now());
    if (n >= MAX_OPEN_QUOTES_PER_IP) throw new v.InputError('You have several unpaid quotes open. Pay or wait for one to expire, then try again.', 429);
}

// The factory's settings change rarely; keep the last good read and refresh
// it in the background so a slow or rate-limited RPC never stalls a request.
let factoryStateCache = null;
let factoryStateLoading = null;
function loadFactoryState() {
    factoryStateLoading ||= evm.readFactoryState()
        .then((value) => (factoryStateCache = { at: Date.now(), value }))
        .finally(() => (factoryStateLoading = null));
    return factoryStateLoading;
}
export async function factoryState() {
    if (factoryStateCache) {
        if (Date.now() - factoryStateCache.at > 30_000) loadFactoryState().catch(() => {});
        return factoryStateCache.value;
    }
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('HyperEVM RPC timeout')), 3000));
    return (await Promise.race([loadFactoryState(), timeout])).value;
}

export async function readiness() {
    const reasons = [];
    if (!config.solana.treasury) reasons.push('Treasury not configured');
    if (!evm.factoryAddress) reasons.push('Factory not configured');
    if (!evm.relayer) reasons.push('Relayer not configured');
    let state = null;
    if (evm.factoryAddress) {
        try {
            state = await factoryState();
            if (state.launchesPaused) reasons.push('Launches are paused');
            if (evm.relayer && !state.relayerIsLauncher) reasons.push('Relayer is not an approved launcher');
        } catch (err) {
            reasons.push('HyperEVM RPC unreachable');
        }
    }
    return { ready: reasons.length === 0, reasons, state };
}

async function ensureCapacity(hypeWei) {
    if (hypeWei === 0n) return;
    const [balance, committed] = await Promise.all([evm.relayerBalance(), committedHypeWei()]);
    const reserve = evm.parseEther(String(config.evm.gasReserveHype));
    if (balance - reserve - committed < hypeWei) {
        throw new v.InputError('The launchpad is temporarily at capacity for buys this size. Try a smaller amount or try again shortly.', 503);
    }
}

// ---------------------------------------------------------------- quotes

function newId() {
    return crypto.randomBytes(9).toString('base64url');
}

function insertOrder(o) {
    const t = now();
    db.prepare(`INSERT INTO orders (id, kind, status, memo, recipient_evm, token, payload, lamports_fee, lamports_trade, lamports_total,
        slippage_bps, quote_hype_wei, quote_tokens_wei, quote_sol_usd, quote_hype_usd, client_ip, created_at, expires_at, updated_at)
        VALUES (?, ?, 'awaiting_payment', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        o.id, o.kind, `${MEMO_PREFIX}${o.id}`, o.recipient, o.token ?? null, o.payload ? JSON.stringify(o.payload) : null,
        o.lamportsFee, o.lamportsTrade, o.lamportsFee + o.lamportsTrade, o.slippageBps, o.hypeWei.toString(), o.tokensWei.toString(),
        o.prices.solUsd, o.prices.hypeUsd, o.ip ?? null, t, t + config.limits.quoteTtlSec, t,
    );
    return getOrder(o.id);
}

export async function createLaunchOrder(body, { ip } = {}) {
    const payload = {
        name: v.text(body.name, 'Name', { required: true, max: 32 }),
        symbol: v.symbol(body.symbol),
        description: v.multiline(body.description, 'Description', 500),
        image: v.uploadedImage(body.image),
        twitter: v.twitter(body.twitter),
        telegram: v.telegram(body.telegram),
        website: v.httpsUrl(body.website, 'Website'),
    };
    if (Buffer.byteLength(payload.name) > 32) throw new v.InputError('Name is too long once encoded. Use fewer special characters.');
    const recipient = v.evmAddress(body.recipient);
    const lamportsTrade = v.solAmount(body.initialBuySol, 'Initial buy', { min: config.limits.minBuySol, max: config.limits.maxOrderSol, allowZero: true });
    const slippageBps = v.slippage(body.slippageBps);

    checkOpenQuotes(ip);
    const status = await readiness();
    if (!status.ready) throw new v.InputError(`Launching is unavailable right now (${status.reasons.join(', ')}).`, 503);
    const prices = await getPrices();
    const hypeWei = hypeForLamports(lamportsTrade, prices.solHype);
    await ensureCapacity(hypeWei);
    const tokensWei = hypeWei > 0n ? await evm.quoteLaunchBuy(hypeWei) : 0n;

    uploads.touch(payload.image);
    const order = insertOrder({
        id: newId(), kind: 'launch', recipient, payload, lamportsFee: Math.round(config.fees.launchFeeSol * 1e9),
        lamportsTrade, slippageBps, hypeWei, tokensWei, prices, ip,
    });
    log.info('order.created', { id: order.id, kind: 'launch', lamports: order.lamportsTotal });
    return order;
}

export async function createBuyOrder(body, { ip } = {}) {
    const token = v.evmAddress(body.token, 'Token');
    const row = db.prepare('SELECT address, complete FROM tokens WHERE address = ?').get(token);
    if (!row) throw new v.InputError('Unknown token.', 404);
    if (row.complete) throw new v.InputError('This coin has graduated. Trade it on the DEX.');
    const recipient = v.evmAddress(body.recipient);
    const lamportsTrade = v.solAmount(body.solAmount, 'Amount', { min: config.limits.minBuySol, max: config.limits.maxOrderSol });
    const slippageBps = v.slippage(body.slippageBps);

    checkOpenQuotes(ip);
    const status = await readiness();
    if (!status.ready) throw new v.InputError(`Buying is unavailable right now (${status.reasons.join(', ')}).`, 503);
    const prices = await getPrices();
    const hypeWei = hypeForLamports(lamportsTrade, prices.solHype);
    await ensureCapacity(hypeWei);
    const q = await evm.quoteBuy(token, hypeWei);
    if (q.refund > 0n) {
        throw new v.InputError('That is more than what is left on the bonding curve. Lower the amount.');
    }
    const order = insertOrder({ id: newId(), kind: 'buy', token, recipient, lamportsFee: 0, lamportsTrade, slippageBps, hypeWei, tokensWei: q.tokensOut, prices, ip });
    log.info('order.created', { id: order.id, kind: 'buy', token, lamports: order.lamportsTotal });
    return order;
}

// ---------------------------------------------------------------- reading

function rowToOrder(r) {
    if (!r) return null;
    return {
        id: r.id,
        kind: r.kind,
        status: r.status,
        memo: r.memo,
        treasury: config.solana.treasury,
        recipient: r.recipient_evm,
        token: r.token,
        payload: r.payload ? JSON.parse(r.payload) : null,
        lamportsFee: r.lamports_fee,
        lamportsTrade: r.lamports_trade,
        lamportsTotal: r.lamports_total,
        slippageBps: r.slippage_bps,
        quote: {
            hypeWei: r.quote_hype_wei,
            tokensWei: r.quote_tokens_wei,
            minTokensWei: applySlippage(r.quote_tokens_wei, r.slippage_bps).toString(),
            solUsd: r.quote_sol_usd,
            hypeUsd: r.quote_hype_usd,
            spreadBps: config.fees.conversionSpreadBps,
        },
        payer: r.payer,
        solSignature: r.sol_signature,
        hypeSpentWei: r.hype_spent_wei,
        tokensOutWei: r.tokens_out_wei,
        evmTxHash: r.evm_tx_hash,
        error: r.error,
        refundLamports: r.refund_lamports,
        refundSignature: r.refund_signature,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
        updatedAt: r.updated_at,
    };
}

export function getOrder(id) {
    return rowToOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(id));
}

const setOrder = (id, fields) => {
    const keys = Object.keys(fields);
    db.prepare(`UPDATE orders SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => fields[k]), now(), id);
};

// ---------------------------------------------------------------- refunds queue

/**
 * Queues a refund. `id` names the reason (e.g. `order:<id>`, `deposit:<sig>`)
 * so the same refund can never be queued twice. Must run inside a DB transaction
 * with whatever state change caused it.
 */
function queueRefund({ id, orderId = null, depositSig = null, to, lamports, reason, manual = false }) {
    const status = manual || !to ? 'manual' : lamports < MIN_REFUND_LAMPORTS ? 'skipped' : 'pending';
    const t = now();
    const res = db.prepare(`INSERT OR IGNORE INTO refunds (id, order_id, deposit_sig, to_address, lamports, reason, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, orderId, depositSig, to || '', lamports, reason, status, t, t);
    if (res.changes && orderId) syncOrderRefund(orderId);
    if (res.changes) log[status === 'pending' ? 'info' : 'warn']('refund.queued', { id, lamports, reason, status });
}

function syncOrderRefund(orderId) {
    const r = db.prepare(`SELECT COALESCE(SUM(lamports), 0) AS owed, MAX(sent_sig) AS sig FROM refunds WHERE order_id = ? AND status IN ('pending', 'sent', 'manual')`).get(orderId);
    db.prepare('UPDATE orders SET refund_lamports = ?, refund_signature = COALESCE(?, refund_signature), updated_at = ? WHERE id = ?').run(r.owed || null, r.sig, now(), orderId);
}

// ---------------------------------------------------------------- payments

/**
 * Looks at one treasury signature and, if it pays an order in full, marks it
 * paid. Anything else that brought SOL in (underpaid, duplicate, unreadable)
 * is queued for refund or flagged. Safe to call any number of times.
 * @returns {Promise<{state: 'pending'|'ignored'|'matched', reason?: string, orderId?: string}>}
 */
export async function ingestSignature(signature, fetchDeposit = sol.fetchDeposit) {
    if (typeof signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signature)) {
        throw new v.InputError('Invalid transaction signature.');
    }
    const seenRow = () => db.prepare('SELECT order_id, note FROM sol_deposits WHERE signature = ?').get(signature);
    const seen = seenRow();
    // A signature the RPC could not return earlier is looked up again; anything
    // else already recorded is final.
    if (seen && seen.note !== UNREADABLE) return { state: seen.order_id ? 'matched' : 'ignored', reason: seen.note, orderId: seen.order_id };

    const dep = await fetchDeposit(signature);
    if (!dep.ok && dep.reason === 'not_found') return seen ? { state: 'ignored', reason: seen.note } : { state: 'pending' };

    const orderId = dep.memo?.startsWith(MEMO_PREFIX) ? dep.memo.slice(MEMO_PREFIX.length) : null;
    return tx(() => {
        // Re-check inside the write lock: the browser's report and the treasury
        // watcher can ingest the same signature at the same time.
        const again = seenRow();
        if (again && again.note !== UNREADABLE) return { state: again.order_id ? 'matched' : 'ignored', reason: again.note, orderId: again.order_id };
        if (again) db.prepare('DELETE FROM sol_deposits WHERE signature = ?').run(signature);
        const record = (note, matched = null) => {
            db.prepare('INSERT OR IGNORE INTO sol_deposits (signature, memo, source, lamports, order_id, note, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
                .run(signature, dep.memo, dep.source, dep.lamports, matched, note, now());
            return { state: matched ? 'matched' : 'ignored', reason: note, orderId: matched };
        };
        const row = orderId ? db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) : null;

        if (!dep.ok) {
            if (dep.reason === 'tx_failed') return record('tx_failed'); // nothing moved
            if (row || dep.lamports > 0) {
                // SOL arrived but not in a shape we can safely attribute: a human decides.
                log.warn('payment.unreadable', { signature, reason: dep.reason, orderId, lamports: dep.lamports });
                queueRefund({ id: `deposit:${signature}`, orderId: row?.id ?? null, depositSig: signature, to: null, lamports: dep.lamports, reason: dep.reason, manual: true });
                return record(`needs_manual_refund:${dep.reason}`);
            }
            return record(dep.reason);
        }
        if (!row) {
            if (orderId) {
                queueRefund({ id: `deposit:${signature}`, depositSig: signature, to: dep.source, lamports: dep.lamports, reason: 'unknown_order', manual: true });
                return record('needs_manual_refund:unknown_order');
            }
            if (dep.lamports >= MIN_REFUND_LAMPORTS) {
                // Could be a customer who forgot the memo, or the operator topping
                // up the treasury; never refunded automatically, always listed.
                log.warn('payment.no_memo', { signature, lamports: dep.lamports, source: dep.source });
                queueRefund({ id: `deposit:${signature}`, depositSig: signature, to: dep.source, lamports: dep.lamports, reason: 'no_memo', manual: true });
                return record('needs_manual_refund:no_memo');
            }
            return record('no_memo');
        }
        if (row.sol_signature === signature) return record('ok', row.id);
        if (row.sol_signature) {
            log.warn('payment.duplicate', { signature, orderId, lamports: dep.lamports });
            queueRefund({ id: `deposit:${signature}`, depositSig: signature, to: dep.source, lamports: dep.lamports, reason: 'duplicate_payment' });
            return record('refund:duplicate_payment');
        }
        if (dep.lamports < row.lamports_total) {
            // Not bound to the order: anyone can copy a memo, and a short
            // payment must not block the real one. Refund it on its own.
            log.warn('payment.underpaid', { signature, orderId, lamports: dep.lamports, quote: row.lamports_total });
            queueRefund({ id: `deposit:${signature}`, depositSig: signature, to: dep.source, lamports: dep.lamports, reason: 'underpaid' });
            return record('refund:underpaid');
        }
        setOrder(row.id, { payer: dep.source, sol_signature: signature, lamports_paid: dep.lamports, paid_at: now(), status: 'paid', error: null });
        if (row.kind === 'launch' && !uploads.keep(JSON.parse(row.payload).image)) log.warn('uploads.missing_on_pay', { orderId: row.id });
        if (dep.lamports > row.lamports_total) {
            queueRefund({ id: `excess:${row.id}`, orderId: row.id, depositSig: signature, to: dep.source, lamports: dep.lamports - row.lamports_total, reason: 'overpayment' });
        }
        log.info('payment.matched', { orderId: row.id, signature, lamports: dep.lamports });
        return record('ok', row.id);
    });
}

/**
 * Walks the treasury's history from the last fully handled signature,
 * oldest first, and saves progress after each one. Nothing is skipped: a
 * signature the RPC cannot return yet stops the walk until the next tick.
 */
export async function pollTreasury() {
    if (!config.solana.treasury) return;
    const cursorKey = `sol_cursor:${config.solana.cluster}:${config.solana.treasury}`;
    const cursor = kvGet(cursorKey); // null = never polled; '' = treasury had no history when we started
    const conn = sol.solConnection();
    const treasury = new PublicKey(config.solana.treasury);

    const fresh = [];
    let before;
    for (;;) {
        const batch = await conn.getSignaturesForAddress(treasury, { limit: 1000, until: cursor || undefined, before }, 'finalized');
        fresh.push(...batch);
        if (cursor === null || batch.length < 1000) break;
        before = batch[batch.length - 1].signature;
    }
    if (cursor === null) {
        // First start: begin from now. A treasury with existing history is
        // not backfilled; an empty one is marked so its first deposit counts.
        kvSet(cursorKey, fresh[0]?.signature ?? '');
        return;
    }
    for (const s of fresh.reverse()) {
        if (!s.err && (!s.memo || s.memo.includes(MEMO_PREFIX) || true)) {
            const r = await ingestSignature(s.signature);
            if (r.state === 'pending') {
                const tries = Number(kvGet(`sol_retry:${s.signature}`) || 0) + 1;
                if (tries < NOT_FOUND_RETRIES) {
                    kvSet(`sol_retry:${s.signature}`, tries);
                    return; // retry from here next tick
                }
                db.prepare('INSERT OR IGNORE INTO sol_deposits (signature, note, seen_at) VALUES (?, ?, ?)').run(s.signature, UNREADABLE, now());
                log.error('payment.unreadable_signature', { signature: s.signature });
            }
            db.prepare('DELETE FROM kv WHERE key = ?').run(`sol_retry:${s.signature}`);
        }
        kvSet(cursorKey, s.signature);
    }
}

// ---------------------------------------------------------------- execution

function decodeFactoryLogs(receipt) {
    const out = [];
    for (const l of receipt.logs) {
        if (l.address.toLowerCase() !== evm.factoryAddress.toLowerCase()) continue;
        try {
            out.push(decodeEventLog({ abi: evm.factoryAbi, data: l.data, topics: l.topics }));
        } catch { /* not ours */ }
    }
    return out;
}

function failOrder(row, reason) {
    log.warn('order.failed', { id: row.id, reason });
    tx(() => {
        setOrder(row.id, { status: 'refunding', error: String(reason).slice(0, 500) });
        queueRefund({ id: `order:${row.id}`, orderId: row.id, depositSig: row.sol_signature, to: row.payer, lamports: row.lamports_total, reason: 'order_failed' });
    });
}

function finalize(row, receipt) {
    if (receipt.status !== 'success') return failOrder(row, 'HyperEVM transaction reverted');
    const events = decodeFactoryLogs(receipt);
    const trade = events.find((e) => e.eventName === 'Trade');
    const created = events.find((e) => e.eventName === 'TokenCreated');
    const fields = { status: 'completed', error: null, evm_tx_hash: receipt.transactionHash };
    let token = row.token;

    tx(() => {
        if (row.kind === 'launch') {
            if (!created) {
                setOrder(row.id, { status: 'needs_review', error: 'Launch transaction had no TokenCreated event', evm_tx_hash: receipt.transactionHash });
                return;
            }
            token = created.args.token;
            fields.token = token;
            const p = JSON.parse(row.payload);
            const launchPrice = Number(created.args.virtualHype) / Number(created.args.virtualToken);
            // The indexer adds the same row from the event; whichever runs first
            // creates it, and this fills in the off-chain metadata either way.
            db.prepare(`INSERT INTO tokens (address, name, symbol, uri, description, image, twitter, telegram, website, creator, launcher, order_id, pair,
                    create_tx, created_block, created_at, total_supply, curve_supply, virtual_hype, virtual_token, real_token, price_hype, launch_price)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(address) DO UPDATE SET description = excluded.description, image = excluded.image, twitter = excluded.twitter,
                    telegram = excluded.telegram, website = excluded.website, order_id = excluded.order_id`).run(
                token, created.args.name, created.args.symbol, created.args.uri, p.description, p.image, p.twitter, p.telegram, p.website,
                created.args.creator, created.args.launcher, row.id, created.args.pair, receipt.transactionHash, Number(receipt.blockNumber), now(),
                created.args.totalSupply.toString(), created.args.curveSupply.toString(), created.args.virtualHype.toString(),
                created.args.virtualToken.toString(), created.args.curveSupply.toString(), launchPrice, launchPrice,
            );
        }
        if (trade) {
            fields.tokens_out_wei = trade.args.tokenAmount.toString();
            fields.hype_spent_wei = trade.args.hypeAmount.toString();
            // If the curve sold out mid-order the factory refunded part of the
            // HYPE; hand back the same share of the SOL.
            const sent = BigInt(row.hype_sent_wei || 0);
            if (sent > 0n && trade.args.hypeAmount < sent) {
                const extra = Number((BigInt(row.lamports_trade) * (sent - trade.args.hypeAmount)) / sent);
                if (extra > 0) queueRefund({ id: `fill:${row.id}`, orderId: row.id, to: row.payer, lamports: extra, reason: 'partial_fill' });
            }
        }
        setOrder(row.id, fields);
    });
    log.info('order.completed', { id: row.id, token, tx: receipt.transactionHash });
}

async function buildCall(row) {
    const prices = await getPrices({ fresh: true });
    const value = hypeForLamports(row.lamports_trade, prices.solHype);
    const minOut = applySlippage(row.quote_tokens_wei, row.slippage_bps);
    if (row.kind === 'launch') {
        const p = JSON.parse(row.payload);
        const uri = `${config.publicUrl}/api/metadata/${row.id}`;
        return { value, functionName: 'createToken', args: [p.name, p.symbol, uri, row.recipient_evm, row.recipient_evm, value > 0n ? minOut : 0n] };
    }
    return { value, functionName: 'buy', args: [row.token, minOut, row.recipient_evm] };
}

const REVERT_MESSAGES = {
    Slippage: 'The price moved more than your slippage setting before the order filled.',
    CurveIsComplete: 'The coin graduated before the order filled.',
    LaunchesPaused: 'Launches were paused before the order filled.',
    NotLauncher: 'The relayer is not authorized to launch.',
    InvalidMetadata: 'The coin name, ticker or metadata was rejected on-chain.',
    InvalidAddress: 'The receiving address was rejected on-chain.',
    UnknownToken: 'Unknown token.',
};
function revertReason(err) {
    let e = err;
    while (e) {
        const name = e.data?.errorName;
        if (name) return REVERT_MESSAGES[name] || `Reverted: ${name}`;
        e = e.cause;
    }
    return err.shortMessage || err.message;
}
const isRevert = (err) => /ContractFunctionRevertedError|ContractFunctionExecutionError/.test(`${err?.name} ${err?.cause?.name}`) || /reverted/i.test(err?.shortMessage || '');

/** Applies a mined relayer transaction to whatever it was for. */
function onMined(s, receipt) {
    if (s.purpose === 'order') {
        const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(s.ref);
        if (row && row.status === 'processing') {
            // Our cancel took the nonce, so the order's own call never ran.
            if (s.cancelHash && receipt.transactionHash.toLowerCase() === s.cancelHash.toLowerCase()) failOrder(row, 'The price moved past your slippage limit before the order could fill.');
            else finalize(row, receipt);
        }
    } else if (s.purpose === 'migrate') {
        log.info('migrate.mined', { token: s.ref, tx: receipt.transactionHash, status: receipt.status });
    }
    slot.clearSlot(evm.relayer.address);
}

function onGone(s) {
    if (s.purpose === 'order') {
        setOrder(s.ref, { status: 'needs_review', error: `Relayer nonce ${s.nonce} was used but none of this order's transactions (${s.hashes.join(', ')}) has a receipt.` });
    }
    slot.clearSlot(evm.relayer.address);
}

let executing = false;
export async function runExecutor() {
    if (executing || !evm.relayer || !evm.factoryAddress) return;
    executing = true;
    try {
        for (let i = 0; i < 20; i++) {
            const progressed = await evm.serial(async () => {
                // 1. Finish whatever is in flight before starting anything new.
                const r = await slot.reconcile(evm.relayer);
                if (r.state === 'mined') onMined(r.slot, r.receipt);
                else if (r.state === 'gone') onGone(r.slot);
                else if (r.state === 'pending') return false;
                // 2. Start the oldest paid order the relayer can afford right now.
                return startNext();
            });
            if (!progressed) return;
        }
    } finally {
        executing = false;
    }
}

async function startNext() {
    const balance = await evm.relayerBalance();
    const reserve = evm.parseEther(String(config.evm.gasReserveHype));
    const rows = db.prepare(`SELECT * FROM orders WHERE status = 'paid' ORDER BY paid_at, created_at LIMIT 25`).all();
    for (const row of rows) {
        let call;
        try {
            call = await buildCall(row);
        } catch (err) {
            noteError(row, err);
            return false;
        }
        if (balance < call.value + reserve) {
            if (now() - row.paid_at > RELAYER_WAIT_SEC) failOrder(row, 'The relayer could not fund this order in time');
            else if (row.error !== 'Waiting for relayer liquidity') {
                setOrder(row.id, { error: 'Waiting for relayer liquidity' });
                log.error('relayer.low_balance', { balance: evm.formatEther(balance), needed: evm.formatEther(call.value) });
            }
            continue; // a smaller order behind it may still fit
        }
        try {
            await slot.send(evm.relayer, {
                purpose: 'order',
                ref: row.id,
                call,
                onSaved: (s) => setOrder(row.id, {
                    status: 'processing', evm_tx_hash: s.hashes[0], evm_raw_tx: s.raw, evm_nonce: s.nonce,
                    evm_sent_at: s.sentAt, hype_sent_wei: call.value.toString(), error: null,
                }),
            });
        } catch (err) {
            if (isRevert(err)) {
                failOrder(row, revertReason(err));
                return true;
            }
            if (err.rejected) setOrder(row.id, { status: 'paid', evm_tx_hash: null, evm_raw_tx: null, evm_nonce: null });
            noteError(row, err);
            return false;
        }
        // Fast path: most transactions land within a couple of blocks.
        const r = await slot.settle(evm.relayer);
        if (r.state === 'mined') onMined(r.slot, r.receipt);
        return r.state === 'mined';
    }
    return false;
}

function noteError(row, err) {
    const cur = db.prepare('SELECT * FROM orders WHERE id = ?').get(row.id);
    const attempts = cur.attempts + 1;
    const message = String(err.shortMessage || err.message).slice(0, 300);
    log.error('order.execute_error', { id: row.id, attempts, err: message });
    // Only an order with no transaction in flight may be failed and refunded.
    const inFlight = slot.getSlot(evm.relayer.address)?.ref === row.id;
    if (attempts >= MAX_ATTEMPTS && cur.status === 'paid' && !inFlight) failOrder(cur, message);
    else db.prepare('UPDATE orders SET attempts = ?, error = ? WHERE id = ?').run(attempts, message, row.id);
}

// ---------------------------------------------------------------- migrations

/** Sends migrate() for graduated curves, one at a time, from the migrator key. */
export async function runMigration(token) {
    const account = evm.migrator;
    if (!account) return;
    const r = await slot.reconcile(account);
    if (r.state === 'pending') return;
    if (r.state === 'mined' || r.state === 'gone') {
        if (r.slot.purpose !== 'migrate') {
            // Shared key and the slot holds an order: settle it exactly as the
            // executor would, so the order is never left behind.
            if (r.state === 'mined') onMined(r.slot, r.receipt);
            else onGone(r.slot);
            return;
        }
        if (r.state === 'mined') log.info('migrate.mined', { token: r.slot.ref, tx: r.receipt.transactionHash, status: r.receipt.status });
        slot.clearSlot(account.address);
        if (r.state === 'gone') return;
    }
    const curve = await evm.readCurve(token);
    if (curve.migrated || !curve.complete) return;
    await slot.send(account, { purpose: 'migrate', ref: token, call: { functionName: 'migrate', args: [token], useMigrator: true } });
    const s = await slot.settle(account, 15_000);
    if (s.state === 'mined') {
        log.info('migrate.mined', { token, tx: s.receipt.transactionHash, status: s.receipt.status });
        slot.clearSlot(account.address);
    }
}

// ---------------------------------------------------------------- refunds

let refunding = false;
export async function runRefunds() {
    if (refunding || !sol.treasurySigner()) return;
    refunding = true;
    try {
        const rows = db.prepare(`SELECT * FROM refunds WHERE status = 'pending' ORDER BY created_at LIMIT 20`).all();
        for (const row of rows) {
            try {
                await refundOne(row);
            } catch (err) {
                log.error('refund.error', { id: row.id, err: err.message });
            }
        }
    } finally {
        refunding = false;
    }
}

const setRefund = (id, fields) => {
    const keys = Object.keys(fields);
    db.prepare(`UPDATE refunds SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => fields[k]), now(), id);
};

function markRefundSent(row, signature) {
    tx(() => {
        setRefund(row.id, { status: 'sent', sent_sig: signature, raw: null });
        if (row.order_id) {
            syncOrderRefund(row.order_id);
            if (row.id === `order:${row.order_id}`) setOrder(row.order_id, { status: 'refunded' });
        }
    });
    log.info('refund.sent', { id: row.id, signature, lamports: row.lamports });
}

async function refundOne(row) {
    if (row.pending_sig) {
        const state = await sol.signatureState(row.pending_sig);
        if (state === 'confirmed') return markRefundSent(row, row.pending_sig);
        if (state === 'unknown') {
            if ((await sol.blockHeight()) <= row.valid_height) {
                await sol.broadcastRaw(row.raw).catch(() => {});
                return;
            }
            // The blockhash has expired, so it can no longer land. Wait a
            // minute and re-check finalized history before signing a new one,
            // in case a lagging RPC node simply had not seen it.
            if (!row.expired_seen_at) return setRefund(row.id, { expired_seen_at: now() });
            if (now() - row.expired_seen_at < 60) return;
            if (await sol.isFinalized(row.pending_sig)) return markRefundSent(row, row.pending_sig);
            if ((await sol.signatureState(row.pending_sig)) !== 'unknown') return;
        }
        // 'failed' or expired-and-absent: nothing moved, safe to sign again.
    }
    // A brand-new or emptied wallet can only receive at least the rent-exempt minimum.
    if (row.lamports < (await sol.rentExemptMinimum()) && (await sol.solBalance(row.to_address)) === 0) {
        setRefund(row.id, { status: 'manual', note: 'Below the rent-exempt minimum for an empty wallet' });
        return log.warn('refund.below_rent', { id: row.id, lamports: row.lamports });
    }
    const signed = await sol.signRefund(row.to_address, row.lamports, `hp1-refund:${row.order_id || row.deposit_sig?.slice(0, 16) || row.id}`);
    setRefund(row.id, { pending_sig: signed.signature, raw: signed.raw, valid_height: signed.lastValidBlockHeight, expired_seen_at: null });
    await sol.broadcastRaw(signed.raw);
}

export function expireStale() {
    db.prepare(`UPDATE orders SET status = 'expired', updated_at = ? WHERE status = 'awaiting_payment' AND expires_at < ?`)
        // Keep a grace window: a payment can still land after expiry and is then
        // picked up from the treasury history and processed normally.
        .run(now(), now() - 24 * 3600);
}

export { MEMO_PREFIX, OPEN_STATUSES };
