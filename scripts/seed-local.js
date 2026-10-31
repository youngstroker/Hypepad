// LOCAL ONLY. Fills a local stack with demo coins so the UI has something to show.
// Launch orders go through the real order engine; Solana deposits are injected
// (devnet has no faucet API), and the running server's relayer fills them.
// Then a few Hardhat accounts trade directly on the curves.
//   node scripts/seed-local.js <dir-with-coin0.png...>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

process.env.NO_JOBS = '1';
const { config } = await import('../server/config.js');
if (config.evm.chainId !== 31337) throw new Error('seed-local only runs against the local Hardhat chain');
const orders = await import('../server/orders.js');
const evm = await import('../server/hyperevm.js');
const { createWalletClient, http, parseEther } = await import('viem');
const { privateKeyToAccount } = await import('viem/accounts');

const BASE = `http://127.0.0.1:${config.port}`;
const dir = process.argv[2];
const COINS = [
    ['Purple Haze', 'HAZE', 'The calmest coin on HyperEVM.'],
    ['Mint Condition', 'MINT', 'Fresh, green, and never minted again.'],
    ['Red Diamond', 'RDMD', 'Diamond hands only.'],
    ['Blue Ring', 'RING', 'Round number go up.'],
    ['Volt', 'VOLT', 'Charged up and ready.'],
    ['Zebra Crossing', 'ZEBRA', 'Stripes for everyone.'],
    ['Pink Pal', 'PAL', 'Your friendly pink pal.'],
    ['Teal Deal', 'TEAL', 'A very good deal.'],
];
const KEYS = [
    '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
    '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
    '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e',
    '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356',
    '0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97',
];
const traders = KEYS.map((k) => createWalletClient({ account: privateKeyToAccount(k), chain: evm.chain, transport: http(config.evm.rpcUrl) }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const launched = [];
for (let i = 0; i < COINS.length; i++) {
    const [name, symbol, description] = COINS[i];
    const res = await fetch(`${BASE}/api/upload`, { method: 'POST', body: fs.readFileSync(path.join(dir, `coin${i}.png`)) });
    const { image } = await res.json();
    const order = await orders.createLaunchOrder({
        name, symbol, description, image, recipient: traders[i % traders.length].account.address,
        twitter: `@${symbol.toLowerCase()}coin`, initialBuySol: [0.5, 1, 0, 2, 0.2, 0.1, 3, 0][i], slippageBps: 500,
    });
    const sig = crypto.randomBytes(64).toString('base64').replace(/[^1-9A-HJ-NP-Za-km-z]/g, 'x').slice(0, 87);
    await orders.ingestSignature(sig, async () => ({ ok: true, memo: order.memo, source: 'FYo836JE7Sg3VBFzq8tbdA1wXFRrWfhbyUuF9JQboyh6', lamports: order.lamportsTotal }));
    for (let n = 0; n < 30; n++) {
        const o = orders.getOrder(order.id);
        if (o.status === 'completed') { launched.push(o.token); console.log('launched', symbol, o.token); break; }
        if (o.status === 'refunding') { console.log('failed', symbol, o.error); break; }
        await sleep(1000);
    }
}

for (let round = 0; round < 40; round++) {
    const token = launched[Math.floor(Math.random() * launched.length)];
    const w = traders[Math.floor(Math.random() * traders.length)];
    try {
        const curve = await evm.readCurve(token);
        if (curve.complete) continue;
        const bal = (await evm.evmBalances(w.account.address, token)).token;
        if (Math.random() < 0.3 && bal > 0n) {
            const amt = bal / BigInt(2 + Math.floor(Math.random() * 4));
            await w.writeContract({ address: token, abi: evm.tokenAbi, functionName: 'approve', args: [evm.factoryAddress, amt] });
            await w.writeContract({ address: evm.factoryAddress, abi: evm.factoryAbi, functionName: 'sell', args: [token, amt, 0n, w.account.address] });
        } else {
            const v = parseEther((Math.random() * (round % 7 === 0 ? 8 : 1.2) + 0.05).toFixed(3));
            await w.writeContract({ address: evm.factoryAddress, abi: evm.factoryAbi, functionName: 'buy', args: [token, 0n, w.account.address], value: v });
        }
    } catch (err) {
        console.log('trade skipped:', err.shortMessage || err.message);
    }
}
console.log('seeded', launched.length, 'coins');
process.exit(0);
