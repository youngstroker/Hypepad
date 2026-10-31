// Runs the order engine against the local Hardhat chain (start it and deploy
// first: see README). Solana deposits are injected through ingestSignature's
// fetcher; everything on the HyperEVM side is real.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hp-')), 'test.sqlite');
process.env.NO_JOBS = '1';

const { config } = await import('../config.js');
const orders = await import('../orders.js');
const { runIndexer, runMigrations } = await import('../indexer.js');
const evm = await import('../hyperevm.js');
const { db } = await import('../db.js');
const { createWalletClient, http, parseEther } = await import('viem');
const { privateKeyToAccount } = await import('viem/accounts');

const PAYER = 'FYo836JE7Sg3VBFzq8tbdA1wXFRrWfhbyUuF9JQboyh6';
const RECIPIENT = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const whale = createWalletClient({
    account: privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'), // hardhat #3
    chain: evm.chain,
    transport: http(config.evm.rpcUrl),
});

let chainUp = false;
let image;
before(async () => {
    try {
        chainUp = config.evm.chainId === 31337 && (await evm.publicClient.getChainId()) === 31337;
    } catch { /* not running */ }
    const png = fs.readFileSync(path.join(config.root, 'public/assets/sample-coin.png'));
    const name = `${crypto.createHash('sha256').update(png).digest('hex')}.png`;
    fs.mkdirSync(path.join(config.dataDir, 'uploads'), { recursive: true });
    fs.writeFileSync(path.join(config.dataDir, 'uploads', name), png);
    image = `/uploads/${name}`;
});

const fakeSig = () => crypto.randomBytes(64).toString('base64').replace(/[^1-9A-HJ-NP-Za-km-z]/g, 'x').slice(0, 87);
const deposit = (memo, lamports, source = PAYER) => async () => ({ ok: true, memo, source, lamports });
const row = (id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
const refund = (id) => db.prepare('SELECT * FROM refunds WHERE id = ?').get(id);
const slotMod = await import('../txslot.js');

async function pay(order, lamports = order.lamportsTotal) {
    const sig = fakeSig();
    const r = await orders.ingestSignature(sig, deposit(order.memo, lamports));
    return { sig, r };
}

async function whaleBuy(token, hype) {
    const hash = await whale.writeContract({ address: evm.factoryAddress, abi: evm.factoryAbi, functionName: 'buy', args: [token, 0n, whale.account.address], value: parseEther(String(hype)) });
    await evm.waitForReceipt(hash);
}

let token;

test('launch: quote, pay, deploy, index', async (t) => {
    if (!chainUp) return t.skip('local chain not running');
    const order = await orders.createLaunchOrder({
        name: 'Purple Frog', symbol: '$pfrog', description: 'test', image, twitter: '@purplefrog', recipient: RECIPIENT, initialBuySol: 0.05, slippageBps: 500,
    });
    assert.equal(order.status, 'awaiting_payment');
    assert.equal(order.payload.symbol, 'PFROG');
    assert.equal(order.lamportsTotal, Math.round((config.fees.launchFeeSol + 0.05) * 1e9));
    assert.ok(BigInt(order.quote.tokensWei) > 0n);

    const { sig, r } = await pay(order);
    assert.equal(r.state, 'matched');
    assert.equal(row(order.id).status, 'paid');
    // the same signature again is a no-op
    assert.equal((await orders.ingestSignature(sig, deposit(order.memo, order.lamportsTotal))).state, 'matched');

    await orders.runExecutor();
    const done = orders.getOrder(order.id);
    assert.equal(done.status, 'completed', done.error);
    assert.ok(done.token);
    assert.ok(BigInt(done.tokensOutWei) >= BigInt(done.quote.minTokensWei));
    token = done.token;

    const bal = await evm.evmBalances(RECIPIENT, token);
    assert.equal(bal.token.toString(), done.tokensOutWei);

    await runIndexer();
    const t1 = db.prepare('SELECT * FROM tokens WHERE address = ?').get(token);
    assert.equal(t1.symbol, 'PFROG');
    assert.equal(t1.image, image);
    assert.equal(t1.twitter, 'https://x.com/purplefrog');
    assert.equal(t1.trade_count, 1);
    assert.ok(t1.price_hype > t1.launch_price);
});

test('second payment for a paid order is refunded on its own, not double-spent', async (t) => {
    if (!chainUp) return t.skip('local chain not running');
    const done = db.prepare(`SELECT * FROM orders WHERE kind = 'launch' AND status = 'completed' LIMIT 1`).get();
    const sig = fakeSig();
    const r = await orders.ingestSignature(sig, deposit(done.memo, 200_000));
    assert.equal(r.state, 'ignored');
    assert.equal(refund(`deposit:${sig}`).status, 'pending');
    assert.equal(refund(`deposit:${sig}`).lamports, 200_000);
    assert.equal(row(done.id).status, 'completed');
});

test('buy with SOL', async (t) => {
    if (!chainUp) return t.skip('local chain not running');
    const order = await orders.createBuyOrder({ token, solAmount: 0.2, recipient: RECIPIENT, slippageBps: 300 });
    const before = (await evm.evmBalances(RECIPIENT, token)).token;
    await pay(order);
    await orders.runExecutor();
    const done = orders.getOrder(order.id);
    assert.equal(done.status, 'completed', done.error);
    assert.equal((await evm.evmBalances(RECIPIENT, token)).token - before, BigInt(done.tokensOutWei));
});

test('an underpayment is refunded without blocking the real payment', async (t) => {
    if (!chainUp) return t.skip('local chain not running');
    const order = await orders.createBuyOrder({ token, solAmount: 0.1, recipient: RECIPIENT, slippageBps: 300 });
    const { sig } = await pay(order, order.lamportsTotal - 1);
    assert.equal(row(order.id).status, 'awaiting_payment');
    assert.equal(refund(`deposit:${sig}`).lamports, order.lamportsTotal - 1);
    // dust is recorded but not worth a refund transaction
    const dust = fakeSig();
    await orders.ingestSignature(dust, deposit(order.memo, 1));
    assert.equal(refund(`deposit:${dust}`).status, 'skipped');
    // the real payment still goes through
    await pay(order);
    await orders.runExecutor();
    assert.equal(row(order.id).status, 'completed');
});

test('overpayment fills the order and refunds the excess', async (t) => {
    if (!chainUp) return t.skip('local chain not running');
    const order = await orders.createBuyOrder({ token, solAmount: 0.1, recipient: RECIPIENT, slippageBps: 300 });
    await pay(order, order.lamportsTotal + 70_000);
    await orders.runExecutor();
    const r = row(order.id);
    assert.equal(r.status, 'completed');
    assert.equal(r.refund_lamports, 70_000);
    assert.equal(refund(`excess:${order.id}`).status, 'pending');
});

test('price moving past slippage refunds instead of filling', async (t) => {
    if (!chainUp) return t.skip('local chain not running');
    const order = await orders.createBuyOrder({ token, solAmount: 0.5, recipient: RECIPIENT, slippageBps: 0 });
    await whaleBuy(token, 2); // someone buys first
    await pay(order);
    await orders.runExecutor();
    const r = row(order.id);
    assert.equal(r.status, 'refunding');
    assert.match(r.error, /slippage/i);
    assert.equal(r.refund_lamports, order.lamportsTotal);
    assert.equal(refund(`order:${order.id}`).lamports, order.lamportsTotal);
});

test('a transaction mined just before a crash is finalized once, never re-sent', async (t) => {
    if (!chainUp) return t.skip('local chain not running');
    const order = await orders.createBuyOrder({ token, solAmount: 0.1, recipient: RECIPIENT, slippageBps: 500 });
    await pay(order);
    await orders.runExecutor();
    const done = row(order.id);
    assert.equal(done.status, 'completed');
    const nonceAfter = await evm.confirmedNonce(evm.relayer.address);
    // Rewind to the moment after the tx mined but before we recorded it.
    const { kvSet } = await import('../db.js');
    kvSet(`evm_slot:${evm.relayer.address.toLowerCase()}`, JSON.stringify({
        purpose: 'order', ref: order.id, call: { functionName: 'buy', args: [], value: { $bigint: '0' } },
        nonce: done.evm_nonce, hashes: [done.evm_tx_hash], raw: done.evm_raw_tx, sentAt: done.evm_sent_at, bumps: 0, fees: {},
    }));
    db.prepare(`UPDATE orders SET status = 'processing', tokens_out_wei = NULL WHERE id = ?`).run(order.id);
    await orders.runExecutor();
    assert.equal(row(order.id).status, 'completed');
    assert.equal(row(order.id).tokens_out_wei, done.tokens_out_wei);
    assert.equal(await evm.confirmedNonce(evm.relayer.address), nonceAfter, 'no second transaction was sent');
    assert.equal(slotMod.getSlot(evm.relayer.address), null);
});

test('unpaid quotes do not use up relayer capacity, but are capped per visitor', async (t) => {
    if (!chainUp) return t.skip('local chain not running');
    for (let i = 0; i < 5; i++) await orders.createBuyOrder({ token, solAmount: 20, recipient: RECIPIENT }, { ip: '203.0.113.9' });
    await assert.rejects(orders.createBuyOrder({ token, solAmount: 0.1, recipient: RECIPIENT }, { ip: '203.0.113.9' }), /unpaid quotes/);
    await orders.createBuyOrder({ token, solAmount: 0.1, recipient: RECIPIENT }, { ip: '198.51.100.7' });
});

test('curve fills, indexer marks it complete, migration runs', async (t) => {
    if (!chainUp) return t.skip('local chain not running');
    await whaleBuy(token, 60);
    await runIndexer();
    assert.equal(db.prepare('SELECT complete FROM tokens WHERE address = ?').get(token).complete, 1);
    await assert.rejects(orders.createBuyOrder({ token, solAmount: 0.1, recipient: RECIPIENT }), /graduated/);
    await runMigrations();
    await runIndexer();
    const t2 = db.prepare('SELECT migrated, migrate_tx FROM tokens WHERE address = ?').get(token);
    assert.equal(t2.migrated, 1);
    assert.ok(t2.migrate_tx);
    assert.equal((await evm.readCurve(token)).migrated, true);
});

test('the same payment ingested twice at once fills the order once and refunds nothing', async (t) => {
    if (!chainUp) return t.skip('local chain not running');
    const order = await orders.createLaunchOrder({ name: 'Race', symbol: 'RACE', image, recipient: RECIPIENT, initialBuySol: 0 });
    const sig = fakeSig();
    const slow = async () => { await new Promise((r) => setTimeout(r, 50)); return { ok: true, memo: order.memo, source: PAYER, lamports: order.lamportsTotal }; };
    const [a, b] = await Promise.all([orders.ingestSignature(sig, slow), orders.ingestSignature(sig, slow)]);
    assert.equal(a.state, 'matched');
    assert.equal(b.state, 'matched');
    assert.equal(row(order.id).status, 'paid');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM refunds WHERE deposit_sig = ?').get(sig).n, 0);
    await orders.runExecutor();
    assert.equal(row(order.id).status, 'completed');
});

const rpc = (method, params = []) => evm.publicClient.request({ method, params });

test('a stuck order whose call would now revert is cancelled at its nonce and refunded', async (t) => {
    if (!chainUp) return t.skip('local chain not running');
    const live = db.prepare('SELECT address FROM tokens WHERE complete = 0 ORDER BY created_at DESC LIMIT 1').get();
    const order = await orders.createBuyOrder({ token: live.address, solAmount: 0.3, recipient: RECIPIENT, slippageBps: 0 });
    await pay(order);
    await rpc('evm_setAutomine', [false]);
    try {
        await orders.runExecutor(); // signs and broadcasts, nothing mines
        const s = slotMod.getSlot(evm.relayer.address);
        assert.equal(s.ref, order.id);
        await rpc('hardhat_dropTransaction', [s.hashes[0]]); // as if the node lost it
        await whale.writeContract({ address: evm.factoryAddress, abi: evm.factoryAbi, functionName: 'buy', args: [live.address, 0n, whale.account.address], value: parseEther('1') });
        await rpc('evm_mine'); // only the whale's buy: the price is now past 0% slippage
        const { kvSet } = await import('../db.js');
        kvSet(`evm_slot:${evm.relayer.address.toLowerCase()}`, JSON.stringify({ ...JSON.parse(JSON.stringify(s, (_, v) => (typeof v === 'bigint' ? { $bigint: v.toString() } : v))), sentAt: 0 }));
        await orders.runExecutor(); // re-pricing reverts -> cancel at the same nonce
        const c = slotMod.getSlot(evm.relayer.address);
        assert.ok(c.cancelHash, 'a cancel replaced the stuck call');
        await rpc('evm_mine');
        await orders.runExecutor();
    } finally {
        await rpc('evm_setAutomine', [true]);
    }
    const r = row(order.id);
    assert.equal(r.status, 'refunding');
    assert.equal(refund(`order:${order.id}`).lamports, order.lamportsTotal);
    assert.equal(slotMod.getSlot(evm.relayer.address), null);
    // the relayer is free again
    const next = await orders.createBuyOrder({ token: live.address, solAmount: 0.1, recipient: RECIPIENT, slippageBps: 500 });
    await pay(next);
    await orders.runExecutor();
    assert.equal(row(next.id).status, 'completed');
});

test('the migration loop settles an order it finds in the shared slot', async (t) => {
    if (!chainUp) return t.skip('local chain not running');
    assert.equal(evm.sharedKey, true, 'local setup uses one key for both roles');
    const live = db.prepare('SELECT address FROM tokens WHERE complete = 0 ORDER BY created_at DESC LIMIT 1').get();
    const done = db.prepare('SELECT address FROM tokens WHERE complete = 1 LIMIT 1').get();
    const order = await orders.createBuyOrder({ token: live.address, solAmount: 0.1, recipient: RECIPIENT, slippageBps: 500 });
    await pay(order);
    await rpc('evm_setAutomine', [false]);
    try {
        await orders.runExecutor();
        await rpc('evm_mine');
    } finally {
        await rpc('evm_setAutomine', [true]);
    }
    assert.equal(row(order.id).status, 'processing');
    await orders.runMigration(done.address); // sees the mined ORDER tx first
    assert.equal(row(order.id).status, 'completed');
    assert.equal(slotMod.getSlot(evm.relayer.address), null);
});

test('rejects bad input', async (t) => {
    if (!chainUp) return t.skip('local chain not running');
    const base = { name: 'X', symbol: 'X', image, recipient: RECIPIENT };
    await assert.rejects(orders.createLaunchOrder({ ...base, symbol: 'BAD TICKER' }), /Ticker/);
    await assert.rejects(orders.createLaunchOrder({ ...base, recipient: '0x0000000000000000000000000000000000000000' }), /zero/);
    await assert.rejects(orders.createLaunchOrder({ ...base, image: '/uploads/nope.png' }), /image/i);
    await assert.rejects(orders.createLaunchOrder({ ...base, website: 'javascript:alert(1)' }), /https/);
    await assert.rejects(orders.createLaunchOrder({ ...base, name: 'a‮b' }), /control/);
    await assert.rejects(orders.createLaunchOrder({ ...base, initialBuySol: 9999 }), /at most/);
});

test('coin page endpoints work for a traded coin (detail, chart, quote)', async (t) => {
    if (!chainUp) return t.skip('local chain not running');
    process.env.NO_JOBS = '1';
    const express = (await import('express')).default;
    const { api } = await import('../routes.js');
    const app = express().use('/api', api);
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}/api`;
    try {
        const coin = db.prepare('SELECT address FROM tokens WHERE trade_count > 1 LIMIT 1').get();
        assert.ok(coin, 'a traded coin exists');
        const detail = await fetch(`${base}/tokens/${coin.address}`);
        assert.equal(detail.status, 200);
        const chart = await fetch(`${base}/tokens/${coin.address}/chart`);
        assert.equal(chart.status, 200, await chart.clone().text());
        const points = await chart.json();
        assert.ok(points.length >= 2);
        assert.ok(points.every((p) => p.t > 0 && p.p > 0));
        for (let i = 1; i < points.length; i++) assert.ok(points[i].t >= points[i - 1].t);
    } finally {
        server.close();
    }
});
