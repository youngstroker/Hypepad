// SQLite through Node's built-in driver: no native modules to build.
// Wei amounts are stored as decimal TEXT because they overflow 64-bit integers.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
export const db = new DatabaseSync(process.env.DB_FILE || path.join(config.dataDir, 'hyperpump.sqlite'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS orders (
    id               TEXT PRIMARY KEY,
    kind             TEXT NOT NULL CHECK (kind IN ('launch', 'buy')),
    status           TEXT NOT NULL,
    memo             TEXT NOT NULL UNIQUE,
    recipient_evm    TEXT NOT NULL,
    token            TEXT,
    payload          TEXT,
    lamports_fee     INTEGER NOT NULL,
    lamports_trade   INTEGER NOT NULL,
    lamports_total   INTEGER NOT NULL,
    slippage_bps     INTEGER NOT NULL,
    quote_hype_wei   TEXT NOT NULL,
    quote_tokens_wei TEXT NOT NULL,
    quote_sol_usd    REAL,
    quote_hype_usd   REAL,
    payer            TEXT,
    sol_signature    TEXT UNIQUE,
    lamports_paid    INTEGER,
    paid_at          INTEGER,
    hype_sent_wei    TEXT,
    hype_spent_wei   TEXT,
    tokens_out_wei   TEXT,
    evm_tx_hash      TEXT,
    evm_raw_tx       TEXT,
    evm_nonce        INTEGER,
    attempts         INTEGER NOT NULL DEFAULT 0,
    error            TEXT,
    refund_lamports  INTEGER,
    refund_signature TEXT,
    refund_pending_sig    TEXT,
    refund_raw            TEXT,
    refund_valid_height   INTEGER,
    created_at       INTEGER NOT NULL,
    expires_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_status ON orders(status, created_at);

CREATE TABLE IF NOT EXISTS tokens (
    address        TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    symbol         TEXT NOT NULL,
    uri            TEXT,
    description    TEXT,
    image          TEXT,
    twitter        TEXT,
    telegram       TEXT,
    website        TEXT,
    creator        TEXT NOT NULL,
    launcher       TEXT,
    order_id       TEXT,
    pair           TEXT,
    create_tx      TEXT NOT NULL,
    created_block  INTEGER NOT NULL,
    created_at     INTEGER NOT NULL,
    total_supply   TEXT NOT NULL,
    curve_supply   TEXT NOT NULL,
    virtual_hype   TEXT NOT NULL,
    virtual_token  TEXT NOT NULL,
    real_hype      TEXT NOT NULL DEFAULT '0',
    real_token     TEXT NOT NULL,
    launch_price   REAL NOT NULL DEFAULT 0,
    price_hype     REAL NOT NULL DEFAULT 0,
    volume_hype    REAL NOT NULL DEFAULT 0,
    trade_count    INTEGER NOT NULL DEFAULT 0,
    last_trade_at  INTEGER,
    complete       INTEGER NOT NULL DEFAULT 0,
    migrated       INTEGER NOT NULL DEFAULT 0,
    migrate_tx     TEXT,
    hidden         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS tokens_created ON tokens(created_at DESC);

CREATE TABLE IF NOT EXISTS trades (
    tx_hash       TEXT NOT NULL,
    log_index     INTEGER NOT NULL,
    token         TEXT NOT NULL REFERENCES tokens(address),
    trader        TEXT NOT NULL,
    recipient     TEXT NOT NULL,
    is_buy        INTEGER NOT NULL,
    hype_amount   REAL NOT NULL,
    token_amount  REAL NOT NULL,
    price_hype    REAL NOT NULL,
    block_number  INTEGER NOT NULL,
    timestamp     INTEGER NOT NULL,
    PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS trades_token_time ON trades(token, timestamp);
CREATE INDEX IF NOT EXISTS trades_time ON trades(timestamp DESC);

-- Every treasury signature the watcher has looked at, matched or not, so
-- nothing is processed twice and unmatched deposits can be reviewed.
CREATE TABLE IF NOT EXISTS sol_deposits (
    signature   TEXT PRIMARY KEY,
    memo        TEXT,
    source      TEXT,
    lamports    INTEGER,
    order_id    TEXT,
    note        TEXT,
    seen_at     INTEGER NOT NULL
);

-- Every SOL refund the treasury owes, whether for a failed order, the unused
-- part of a fill, or a deposit that could not be matched. One row per reason
-- (the id), so the same refund can never be queued twice.
CREATE TABLE IF NOT EXISTS refunds (
    id              TEXT PRIMARY KEY,
    order_id        TEXT,
    deposit_sig     TEXT,
    to_address      TEXT NOT NULL,
    lamports        INTEGER NOT NULL,
    reason          TEXT NOT NULL,
    status          TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'manual', 'skipped')),
    pending_sig     TEXT,
    raw             TEXT,
    valid_height    INTEGER,
    expired_seen_at INTEGER,
    sent_sig        TEXT,
    note            TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS refunds_status ON refunds(status, created_at);

CREATE TABLE IF NOT EXISTS kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`);

// Columns added after the first release.
for (const [table, column, ddl] of [
    ['tokens', 'hidden', 'INTEGER NOT NULL DEFAULT 0'],
    ['orders', 'client_ip', 'TEXT'],
    ['orders', 'evm_tx_hashes', 'TEXT'], // JSON: every signed candidate for this order's nonce (fee bumps)
    ['orders', 'evm_sent_at', 'INTEGER'],
    ['orders', 'evm_max_fee', 'TEXT'],
    ['orders', 'evm_priority_fee', 'TEXT'],
    ['orders', 'evm_bumps', 'INTEGER NOT NULL DEFAULT 0'],
    ['orders', 'nonce_gone_at', 'INTEGER'],
    ['sol_deposits', 'attempts', 'INTEGER NOT NULL DEFAULT 0'],
]) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

export const now = () => Math.floor(Date.now() / 1000);

export function kvGet(key) {
    return db.prepare('SELECT value FROM kv WHERE key = ?').get(key)?.value ?? null;
}

export function kvSet(key, value) {
    db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

export function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
        const out = fn();
        db.exec('COMMIT');
        return out;
    } catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }
}
