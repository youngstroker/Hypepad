// Go/no-go check for a production deployment. Reads .env, touches nothing,
// sends no transactions. Run it on the server before opening the site:
//   npm run preflight
process.env.NO_JOBS = '1';
import fs from 'node:fs';
import path from 'node:path';
import { getAddress, keccak256, encodePacked, getContractAddress, formatEther, parseAbi } from 'viem';

const { config, isMainnet, validateConfig } = await import('../server/config.js');
const sol = await import('../server/solana.js');
const evm = await import('../server/hyperevm.js');
const { getPrices } = await import('../server/prices.js');

const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const WHYPE_MAINNET = '0x5555555555555555555555555555555555555555';
const HYPERSWAP_V2 = '0x724412C00059bf7d6ee7d4a1d0D5cd4de3ea1C48';
const results = [];
const add = (level, check, detail = '') => results.push({ level, check, detail });
const pass = (c, d) => add('PASS', c, d);
const warn = (c, d) => add('WARN', c, d);
const fail = (c, d) => add('FAIL', c, d);

async function step(name, fn) {
    try {
        await fn();
    } catch (err) {
        fail(name, err.shortMessage || err.message);
    }
}

// ---------------------------------------------------------------- config
await step('config', async () => {
    for (const p of validateConfig()) warn('config', p);
    if (!isMainnet) fail('networks', `Not a mainnet config (Solana ${config.solana.cluster}, HyperEVM ${config.evm.chainId}).`);
    else pass('networks', 'Solana mainnet-beta + HyperEVM 999');
    const url = new URL(config.publicUrl);
    if (url.protocol !== 'https:' || /^(localhost|127\.|0\.0\.0\.0)/.test(url.hostname)) fail('PUBLIC_URL', `${config.publicUrl} must be your public https:// domain (it is written into every coin's on-chain metadata).`);
    else pass('PUBLIC_URL', config.publicUrl);
    if (/api\.mainnet-beta\.solana\.com/.test(config.solana.rpcUrl)) warn('SOLANA_RPC_URL', 'Public Solana RPC is heavily rate-limited; use a paid provider for launch.');
    if (!config.trustProxy) warn('TRUST_PROXY', 'Not set: behind Caddy/nginx all visitors share one IP for rate limiting.');
});

// ---------------------------------------------------------------- Solana
await step('solana', async () => {
    const conn = sol.solConnection();
    const genesis = await conn.getGenesisHash();
    if (isMainnet && genesis !== MAINNET_GENESIS) fail('Solana RPC', `RPC genesis ${genesis} is not mainnet-beta.`);
    else pass('Solana RPC', `${config.solana.rpcUrl} (slot ${await conn.getSlot()})`);
    if (!sol.isSolAddress(config.solana.treasury)) return fail('Treasury', 'TREASURY_PUBLIC_KEY is not a valid wallet address.');
    const bal = await sol.solBalance(config.solana.treasury);
    pass('Treasury', `${config.solana.treasury} holds ${(bal / 1e9).toFixed(4)} SOL`);
    if (!config.solana.treasurySecret) warn('Refunds', 'No TREASURY_SECRET_KEY: refunds queue for manual processing.');
    else {
        sol.treasurySigner(); // throws if it does not match the public key
        if (bal < 0.05e9) warn('Refunds', 'Treasury holds under 0.05 SOL; automatic refunds need SOL for fees.');
        else pass('Refunds', 'Treasury key matches; automatic refunds on');
    }
});

// ---------------------------------------------------------------- HyperEVM
await step('hyperevm', async () => {
    const chainId = await evm.publicClient.getChainId();
    if (chainId !== config.evm.chainId) return fail('HyperEVM RPC', `RPC reports chain ${chainId}, expected ${config.evm.chainId}.`);
    pass('HyperEVM RPC', `${config.evm.rpcUrl} (block ${await evm.publicClient.getBlockNumber()})`);

    if (/rpc\.hyperliquid\.xyz/.test(config.evm.rpcUrl)) warn('HYPEREVM_RPC_URL', 'Public HyperEVM RPC allows ~100 requests/min per IP; the relayer and indexer need a dedicated RPC for launch traffic.');
    if (!evm.factoryAddress) return fail('Factory', 'FACTORY_ADDRESS not set.');
    if (config.evm.deployBlock === 0n) fail('FACTORY_DEPLOY_BLOCK', 'Not set; the indexer would scan HyperEVM from genesis.');
    const code = await evm.publicClient.getCode({ address: evm.factoryAddress });
    if (!code || code === '0x') return fail('Factory', `No contract at ${evm.factoryAddress}.`);
    const read = (functionName, args = []) => evm.publicClient.readContract({ address: evm.factoryAddress, abi: evm.factoryAbi, functionName, args });
    const [owner, pending, whype, v2Factory, initHash, feeRecipient, state] = await Promise.all([
        read('owner'), read('pendingOwner'), read('whype'), read('v2Factory'), read('pairInitCodeHash'), read('feeRecipient'), evm.readFactoryState(),
    ]);
    pass('Factory', `${evm.factoryAddress}, owner ${owner}${pending !== '0x0000000000000000000000000000000000000000' ? ` (pending ${pending} must acceptOwnership)` : ''}`);
    if (pending !== '0x0000000000000000000000000000000000000000') warn('Ownership', `Transfer to ${pending} not accepted yet.`);
    const ownerCode = await evm.publicClient.getCode({ address: owner });
    if (!ownerCode || ownerCode === '0x') warn('Ownership', 'Factory owner is a plain wallet; use a multisig for launch.');
    pass('Fees', `trade ${(state.protocolFeeBps + state.creatorFeeBps) / 100}% (creator ${state.creatorFeeBps / 100}%), migration ${state.migrationFeeBps / 100}%, to ${feeRecipient}`);
    if (state.launchesPaused) fail('Launches', 'Launches are paused on the factory.');
    if (!evm.relayer) fail('Relayer', 'RELAYER_PRIVATE_KEY not set.');
    else if (!state.relayerIsLauncher) fail('Relayer', `${evm.relayer.address} is not an approved launcher (owner must call setLauncher).`);
    else pass('Relayer', `${evm.relayer.address} is an approved launcher`);

    if (isMainnet && getAddress(whype) !== WHYPE_MAINNET) fail('WHYPE', `Factory uses ${whype}, expected ${WHYPE_MAINNET}.`);
    else pass('WHYPE', whype);

    // Prove the DEX settings on live data: recompute an existing pair's
    // address from the factory's init-code hash. A mismatch would make every
    // graduation revert.
    const dex = parseAbi(['function allPairsLength() view returns (uint256)', 'function allPairs(uint256) view returns (address)']);
    const pairAbi = parseAbi(['function token0() view returns (address)', 'function token1() view returns (address)']);
    const n = await evm.publicClient.readContract({ address: v2Factory, abi: dex, functionName: 'allPairsLength' });
    if (isMainnet && getAddress(v2Factory) !== HYPERSWAP_V2) warn('DEX', `Factory migrates into ${v2Factory}, not HyperSwap V2 (${HYPERSWAP_V2}), the DEX this launchpad was tested against.`);
    if (n === 0n) return warn('DEX', `${v2Factory} has no pairs yet; cannot cross-check the init-code hash.`);
    let ok = 0;
    const sample = [0n, n - 1n, n / 2n].filter((v, i, a) => a.indexOf(v) === i);
    for (const i of sample) {
        const pair = await evm.publicClient.readContract({ address: v2Factory, abi: dex, functionName: 'allPairs', args: [i] });
        const [t0, t1] = await Promise.all([
            evm.publicClient.readContract({ address: pair, abi: pairAbi, functionName: 'token0' }),
            evm.publicClient.readContract({ address: pair, abi: pairAbi, functionName: 'token1' }),
        ]);
        const predicted = getContractAddress({ opcode: 'CREATE2', from: v2Factory, salt: keccak256(encodePacked(['address', 'address'], [t0, t1])), bytecodeHash: initHash });
        if (getAddress(predicted) === getAddress(pair)) ok++;
    }
    if (ok === sample.length) pass('DEX', `${v2Factory}: init-code hash matches ${ok}/${sample.length} live pairs (${n} pairs total)`);
    else fail('DEX', `init-code hash matched only ${ok}/${sample.length} live pairs on ${v2Factory}; graduations would revert.`);

    // Relayer inventory
    if (evm.relayer) {
        const bal = await evm.relayerBalance();
        const min = config.evm.gasReserveHype + 5;
        const msg = `${formatEther(bal)} HYPE`;
        if (Number(formatEther(bal)) < config.evm.gasReserveHype) fail('Relayer balance', `${msg}: below the gas reserve; every order would wait.`);
        else if (Number(formatEther(bal)) < min) warn('Relayer balance', `${msg}: only enough for small initial buys.`);
        else pass('Relayer balance', msg);
    }
    if (evm.migrator) {
        const bal = await evm.publicClient.getBalance({ address: evm.migrator.address });
        if (evm.sharedKey) (isMainnet ? fail : warn)('Migrator', 'Set MIGRATOR_PRIVATE_KEY to a separate key on big blocks. The relayer must stay on small blocks or every launch waits up to a minute.');
        if (bal < 10n ** 17n) warn('Migrator balance', `${formatEther(bal)} HYPE; keep ~0.1+ HYPE for migration gas.`);
        else pass('Migrator balance', `${evm.migrator.address}: ${formatEther(bal)} HYPE`);
        await checkBigBlocks(evm.migrator.address);
    }
});

async function checkBigBlocks(address) {
    try {
        await evm.publicClient.request({ method: 'eth_bigBlockGasPrice', params: [] }); // every migration is priced with this
        if (await evm.usingBigBlocks(address)) pass('Big blocks', `${address} sends in big blocks (needed: migration uses ~3.7M gas, small blocks hold 3M)`);
        else (isMainnet ? fail : warn)('Big blocks', `${address} is not on big blocks, so graduated coins cannot migrate. Run: npm run big-blocks -- on (with MIGRATOR_PRIVATE_KEY).`);
    } catch (err) {
        (isMainnet ? fail : warn)('Big blocks', `HYPEREVM_RPC_URL does not answer HyperEVM big-block methods (${err.shortMessage || err.message}); migrations cannot be sent through it.`);
    }
}

// ---------------------------------------------------------------- prices & storage
await step('prices', async () => {
    const p = await getPrices({ fresh: true });
    pass('Prices', `SOL $${p.solUsd}, HYPE $${p.hypeUsd} (${p.source})`);
});
await step('storage', async () => {
    const dir = path.join(config.dataDir, 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.write-test');
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe);
    pass('Storage', `${config.dataDir} is writable`);
});

const width = Math.max(...results.map((r) => r.check.length));
for (const r of results) console.log(`${r.level.padEnd(4)}  ${r.check.padEnd(width)}  ${r.detail}`);
const fails = results.filter((r) => r.level === 'FAIL').length;
const warns = results.filter((r) => r.level === 'WARN').length;
console.log(`\n${fails ? 'NO-GO' : 'GO'}: ${fails} failing, ${warns} warnings`);
process.exit(fails ? 1 : 0);
