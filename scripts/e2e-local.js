// End-to-end check against a running local stack (npm run setup:local, server running):
// funds a throwaway devnet wallet, launches a coin paying real devnet SOL, buys
// it with SOL, and confirms both orders complete on the local HyperEVM chain.
//   node scripts/e2e-local.js [payerSecretBase58]
import fs from 'node:fs';
import path from 'node:path';
import bs58 from 'bs58';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4191';
const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const conn = new Connection(process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed');
const RECIPIENT = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'; // hardhat account #2

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(p, init) {
    const res = await fetch(`${BASE}${p}`, init);
    const body = await res.json();
    if (!res.ok) throw new Error(`${p}: ${body.error}`);
    return body;
}

async function fundedPayer() {
    if (process.argv[2]) return Keypair.fromSecretKey(bs58.decode(process.argv[2]));
    const kp = Keypair.generate();
    console.log('payer', kp.publicKey.toBase58(), 'requesting devnet airdrop…');
    const sig = await conn.requestAirdrop(kp.publicKey, LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, 'confirmed');
    return kp;
}

async function pay(payer, order) {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight })
        .add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: new PublicKey(order.treasury), lamports: order.lamportsTotal }))
        .add(new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from(order.memo) }));
    tx.sign(payer);
    const sig = await conn.sendRawTransaction(tx.serialize());
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    return sig;
}

async function settle(order, sig) {
    for (let i = 0; i < 90; i++) {
        const { order: o } = await api(`/api/orders/${order.id}/payment`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signature: sig }),
        });
        if (['completed', 'refunding', 'refunded'].includes(o.status)) return o;
        process.stdout.write(`  ${o.status}…\r`);
        await sleep(2000);
    }
    throw new Error('timed out');
}

const payer = await fundedPayer();
const png = fs.readFileSync(path.join(import.meta.dirname, '../public/assets/sample-coin.png'));
const { image } = await api('/api/upload', { method: 'POST', body: png });

const launch = await api('/api/orders/launch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Purple Frog', symbol: 'PFROG', description: 'End-to-end test coin', image, recipient: RECIPIENT, initialBuySol: 0.05, slippageBps: 500 }),
});
console.log('launch order', launch.id, launch.lamportsTotal / 1e9, 'SOL');
const done = await settle(launch, await pay(payer, launch));
console.log('launch', done.status, 'token', done.token, 'tokensOut', done.tokensOutWei, done.error || '');
if (done.status !== 'completed') process.exit(1);

const buy = await api('/api/orders/buy', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: done.token, solAmount: 0.1, recipient: RECIPIENT, slippageBps: 300 }),
});
const bought = await settle(buy, await pay(payer, buy));
console.log('buy', bought.status, 'tokensOut', bought.tokensOutWei, bought.error || '');

await sleep(4000);
const token = await api(`/api/tokens/${done.token}`);
console.log('token', token.symbol, 'priceUsd', token.priceUsd, 'mcapUsd', token.marketCapUsd, 'progress', token.progress.toFixed(3), 'trades', token.recentTrades.length);
