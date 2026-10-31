// Follows factory events on HyperEVM and keeps the tokens/trades tables in sync,
// whether the trade came through the SOL relayer or straight from a HyperEVM wallet.
// It also calls migrate() for any curve that has sold out.
import { config } from './config.js';
import { db, now, kvGet, kvSet, tx } from './db.js';
import * as evm from './hyperevm.js';
import { log } from './log.js';
import { runMigration } from './orders.js';

const EVENTS = ['TokenCreated', 'Trade', 'CurveCompleted', 'Migrated'];
const eventAbis = evm.factoryAbi.filter((x) => x.type === 'event' && EVENTS.includes(x.name));
const cursorKey = () => `evm_cursor:${config.evm.chainId}:${evm.factoryAddress}`;
const toFloat = (wei) => Number(wei) / 1e18;
const priceOf = (virtualHype, virtualToken) => Number(virtualHype) / Number(virtualToken);

const blockTimes = new Map();
async function blockTime(blockNumber) {
    const key = blockNumber.toString();
    if (!blockTimes.has(key)) {
        const block = await evm.publicClient.getBlock({ blockNumber });
        blockTimes.set(key, Number(block.timestamp));
        if (blockTimes.size > 5000) blockTimes.delete(blockTimes.keys().next().value);
    }
    return blockTimes.get(key);
}

function applyCreated(l, ts) {
    const a = l.args;
    db.prepare(`INSERT INTO tokens (address, name, symbol, uri, creator, launcher, pair, create_tx, created_block, created_at,
            total_supply, curve_supply, virtual_hype, virtual_token, real_token, price_hype, launch_price)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(address) DO UPDATE SET created_block = excluded.created_block, created_at = excluded.created_at, pair = excluded.pair,
            launch_price = excluded.launch_price`).run(
        a.token, a.name, a.symbol, a.uri, a.creator, a.launcher, a.pair, l.transactionHash, Number(l.blockNumber), ts,
        a.totalSupply.toString(), a.curveSupply.toString(), a.virtualHype.toString(), a.virtualToken.toString(), a.curveSupply.toString(),
        priceOf(a.virtualHype, a.virtualToken), priceOf(a.virtualHype, a.virtualToken),
    );
    // Link metadata from the launch order, if the relayer sent this one.
    const order = db.prepare(`SELECT id, payload FROM orders WHERE kind = 'launch' AND evm_tx_hash = ?`).get(l.transactionHash);
    if (order) {
        const p = JSON.parse(order.payload);
        db.prepare(`UPDATE tokens SET order_id = ?, description = ?, image = ?, twitter = ?, telegram = ?, website = ? WHERE address = ?`)
            .run(order.id, p.description, p.image, p.twitter, p.telegram, p.website, a.token);
    }
}

function applyTrade(l, ts) {
    const a = l.args;
    const price = priceOf(a.virtualHype, a.virtualToken);
    const res = db.prepare(`INSERT OR IGNORE INTO trades (tx_hash, log_index, token, trader, recipient, is_buy, hype_amount, token_amount, price_hype, block_number, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        l.transactionHash, l.logIndex, a.token, a.trader, a.recipient, a.isBuy ? 1 : 0, toFloat(a.hypeAmount), toFloat(a.tokenAmount),
        price, Number(l.blockNumber), ts,
    );
    if (!res.changes) return;
    db.prepare(`UPDATE tokens SET virtual_hype = ?, virtual_token = ?, real_hype = ?, real_token = ?, price_hype = ?,
            volume_hype = volume_hype + ?, trade_count = trade_count + 1, last_trade_at = ? WHERE address = ?`).run(
        a.virtualHype.toString(), a.virtualToken.toString(), a.realHype.toString(), a.realToken.toString(), price,
        toFloat(a.hypeAmount), ts, a.token,
    );
}

async function applyLog(l) {
    const ts = await blockTime(l.blockNumber);
    tx(() => {
        if (l.eventName === 'TokenCreated') applyCreated(l, ts);
        else if (l.eventName === 'Trade') applyTrade(l, ts);
        else if (l.eventName === 'CurveCompleted') db.prepare('UPDATE tokens SET complete = 1 WHERE address = ?').run(l.args.token);
        else if (l.eventName === 'Migrated') db.prepare('UPDATE tokens SET complete = 1, migrated = 1, migrate_tx = ? WHERE address = ?').run(l.transactionHash, l.args.token);
    });
}

let running = false;
// HyperEVM nodes cap getLogs by block range (docs: 50, observed: 1000) and by
// response size; shrink the window when a node refuses, grow it back slowly.
let chunk = config.evm.logChunk;
const MIN_CHUNK = 50n;
const isRangeError = (err) => /block range|too big|exceeds|limit|-32602|-32008/i.test(`${err?.shortMessage} ${err?.details} ${err?.message}`);

export async function runIndexer() {
    if (running || !evm.factoryAddress) return;
    running = true;
    try {
        const head = await evm.publicClient.getBlockNumber({ cacheTime: 0 });
        let from = BigInt(kvGet(cursorKey()) ?? config.evm.deployBlock);
        while (from <= head) {
            const to = from + chunk - 1n < head ? from + chunk - 1n : head;
            let logs;
            try {
                logs = await evm.publicClient.getLogs({ address: evm.factoryAddress, events: eventAbis, fromBlock: from, toBlock: to, strict: true });
            } catch (err) {
                if (!isRangeError(err) || chunk <= MIN_CHUNK) throw err;
                chunk = chunk / 2n > MIN_CHUNK ? chunk / 2n : MIN_CHUNK;
                log.warn('indexer.chunk_reduced', { chunk: Number(chunk) });
                continue;
            }
            if (chunk < config.evm.logChunk) chunk += MIN_CHUNK;
            logs.sort((x, y) => (x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : Number(x.blockNumber - y.blockNumber)));
            for (const l of logs) await applyLog(l);
            from = to + 1n;
            kvSet(cursorKey(), from.toString());
        }
    } catch (err) {
        log.error('indexer.error', { err: err.shortMessage || err.message });
    } finally {
        running = false;
    }
}

let migrating = false;
export async function runMigrations() {
    if (migrating || !evm.migrator || !evm.factoryAddress) return;
    migrating = true;
    try {
        const rows = db.prepare('SELECT address FROM tokens WHERE complete = 1 AND migrated = 0 ORDER BY created_at').all();
        for (const { address } of rows) {
            try {
                // migrate() is idempotent on-chain (a second call reverts in
                // simulation), and the migrator key has its own in-flight slot.
                await (evm.sharedKey ? evm.serial : (fn) => fn())(() => runMigration(address));
            } catch (err) {
                log.error('migrate.error', { token: address, err: err.shortMessage || err.message });
            }
        }
    } finally {
        migrating = false;
    }
}

export function indexerLag() {
    return kvGet(cursorKey());
}

export { now };
