// HyperEVM side: contract reads, and relayer transactions that survive a crash.
// Each relayer transaction is signed first, its hash and raw bytes saved by the
// caller, and only then broadcast, so after a restart we can always tell
// whether it landed instead of sending a second one.
import fs from 'node:fs';
import path from 'node:path';
import {
    createPublicClient, createWalletClient, http, defineChain, getAddress, isAddress,
    keccak256, formatEther, parseEther, encodeFunctionData,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { config } from './config.js';

const abiDir = path.join(config.root, 'server/abi');
export const factoryAbi = JSON.parse(fs.readFileSync(path.join(abiDir, 'HyperPumpFactory.json'), 'utf8'));
export const tokenAbi = JSON.parse(fs.readFileSync(path.join(abiDir, 'HyperPumpToken.json'), 'utf8'));

export const chain = defineChain({
    id: config.evm.chainId,
    name: config.evm.chainName,
    nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
    rpcUrls: { default: { http: [config.evm.rpcUrl] } },
});

export const publicClient = createPublicClient({ chain, transport: http(config.evm.rpcUrl, { timeout: 15_000, retryCount: 2 }) });
// Reads triggered by visitors (quotes, balances) can use a separate RPC so they
// never eat the rate limit the relayer and indexer depend on.
export const readClient = config.evm.readRpcUrl === config.evm.rpcUrl
    ? publicClient
    : createPublicClient({ chain, transport: http(config.evm.readRpcUrl, { timeout: 10_000, retryCount: 1 }) });

const accountFor = (key) => (key ? privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`) : null);
export const relayer = accountFor(config.evm.relayerKey);
// Migration creates a DEX pair, which needs more gas than a HyperEVM small
// block allows. Give it its own key with big blocks enabled so launches from
// the relayer key keep landing in fast small blocks.
const migratorOwn = accountFor(config.evm.migratorKey);
// The same key in both settings must be the same account object: code below
// compares by identity to decide whether the two share one nonce stream.
export const migrator = migratorOwn && relayer && migratorOwn.address.toLowerCase() === relayer.address.toLowerCase()
    ? relayer
    : migratorOwn || relayer;
export const sharedKey = Boolean(migrator && migrator === relayer);

const walletFor = (account) => (account ? createWalletClient({ account, chain, transport: http(config.evm.rpcUrl, { timeout: 20_000 }) }) : null);
const relayerWallet = walletFor(relayer);
const migratorWallet = walletFor(migrator);

export const factoryAddress = config.evm.factory && isAddress(config.evm.factory) ? getAddress(config.evm.factory) : null;

export const isEvmAddress = (v) => typeof v === 'string' && isAddress(v, { strict: false });
export const toChecksum = (v) => getAddress(v);
export { formatEther, parseEther };

const factoryRead = (functionName, args = []) => publicClient.readContract({ address: factoryAddress, abi: factoryAbi, functionName, args });
const factoryReadPublic = (functionName, args = []) => readClient.readContract({ address: factoryAddress, abi: factoryAbi, functionName, args });

export async function readFactoryState() {
    const [params, protocolFeeBps, creatorFeeBps, migrationFeeBps, launchesPaused, isLauncher] = await Promise.all([
        factoryRead('params'),
        factoryRead('protocolFeeBps'),
        factoryRead('creatorFeeBps'),
        factoryRead('migrationFeeBps'),
        factoryRead('launchesPaused'),
        relayer ? factoryRead('launchers', [relayer.address]) : false,
    ]);
    const [virtualHype, virtualToken, curveSupply, totalSupply] = params;
    return {
        params: { virtualHype, virtualToken, curveSupply, totalSupply },
        protocolFeeBps: Number(protocolFeeBps),
        creatorFeeBps: Number(creatorFeeBps),
        migrationFeeBps: Number(migrationFeeBps),
        launchesPaused,
        relayerIsLauncher: Boolean(isLauncher),
    };
}

export const quoteLaunchBuy = (hypeWei) => factoryRead('quoteLaunchBuy', [hypeWei]);

export async function quoteBuy(token, hypeWei, { visitor = false } = {}) {
    const [tokensOut, fee, refund] = await (visitor ? factoryReadPublic : factoryRead)('quoteBuy', [token, hypeWei]);
    return { tokensOut, fee, refund };
}

export async function quoteSell(token, tokenWei) {
    const [hypeOut, fee] = await factoryReadPublic('quoteSell', [token, tokenWei]);
    return { hypeOut, fee };
}

export async function readCurve(token) {
    const c = await factoryRead('curves', [token]);
    const [virtualHype, virtualToken, realHype, realToken, liquidityTokens, creator, complete, migrated] = c;
    return { virtualHype, virtualToken, realHype, realToken, liquidityTokens, creator, complete, migrated };
}

export async function relayerBalance() {
    return relayer ? publicClient.getBalance({ address: relayer.address }) : 0n;
}

export async function evmBalances(owner, token) {
    const [hype, tokenBal, allowance] = await Promise.all([
        readClient.getBalance({ address: owner }),
        token ? readClient.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [owner] }) : 0n,
        token ? readClient.readContract({ address: token, abi: tokenAbi, functionName: 'allowance', args: [owner, factoryAddress] }) : 0n,
    ]);
    return { hype, token: tokenBal, allowance };
}

export class NonceConflictError extends Error {}

/**
 * Builds and signs (but does not send) a factory call.
 * `nonce` comes from the caller's own bookkeeping (see orders.js), never from
 * the RPC's view of the mempool, which a load-balanced endpoint can get wrong.
 * `minFees` lets a stuck transaction be replaced at the same nonce with
 * higher fees (each bump must beat the previous fees by >10%).
 * @returns {Promise<{ hash: `0x${string}`, raw: `0x${string}`, nonce: number, maxFeePerGas: bigint, maxPriorityFeePerGas: bigint }>}
 */
export async function signFactoryCall({ functionName, args, value = 0n, useMigrator = false, nonce, minFees }) {
    const wallet = useMigrator ? migratorWallet : relayerWallet;
    if (!wallet) throw new Error('No relayer key configured');
    const account = wallet.account;
    // Simulate first: a revert here costs nothing and gives a readable reason.
    await publicClient.simulateContract({ account, address: factoryAddress, abi: factoryAbi, functionName, args, value });
    const data = encodeFunctionData({ abi: factoryAbi, functionName, args });
    const gas = await publicClient.estimateGas({ account, to: factoryAddress, data, value });
    const block = await publicClient.getBlock({ blockTag: 'latest' });
    const tip = await publicClient.estimateMaxPriorityFeePerGas().catch(() => 0n);
    // A transaction only ever pays base fee + tip; the 2x base-fee cap is
    // headroom so a fee spike does not strand it.
    let maxPriorityFeePerGas = tip;
    let maxFeePerGas = (block.baseFeePerGas ?? 0n) * 2n + tip;
    if (useMigrator && config.evm.chainId !== 31337) {
        // Migration needs ~3.7M gas, more than a small block holds, so the
        // migrator account is on big blocks, which have their own gas price.
        const big = BigInt(await publicClient.request({ method: 'eth_bigBlockGasPrice', params: [] }));
        if (maxFeePerGas < big * 2n) maxFeePerGas = big * 2n;
    }
    if (minFees) {
        const bump = (x) => (x * 125n) / 100n + 1n;
        maxPriorityFeePerGas = maxPriorityFeePerGas > bump(minFees.maxPriorityFeePerGas) ? maxPriorityFeePerGas : bump(minFees.maxPriorityFeePerGas);
        maxFeePerGas = maxFeePerGas > bump(minFees.maxFeePerGas) ? maxFeePerGas : bump(minFees.maxFeePerGas);
    }
    if (maxFeePerGas < maxPriorityFeePerGas) maxFeePerGas = maxPriorityFeePerGas;
    const raw = await wallet.signTransaction({
        account, chain, to: factoryAddress, data, value, type: 'eip1559', nonce,
        gas: (gas * 13n) / 10n, maxFeePerGas, maxPriorityFeePerGas,
    });
    return { hash: keccak256(raw), raw, nonce, maxFeePerGas, maxPriorityFeePerGas };
}

/**
 * Signs a 0-value transfer to self at `nonce`, priced above `minFees`, to
 * replace (cancel) a stuck transaction that would now revert.
 */
export async function signCancel({ useMigrator = false, nonce, minFees }) {
    const wallet = useMigrator ? migratorWallet : relayerWallet;
    const account = wallet.account;
    const block = await publicClient.getBlock({ blockTag: 'latest' });
    const bump = (x) => (x * 125n) / 100n + 1n;
    const maxPriorityFeePerGas = bump(minFees.maxPriorityFeePerGas);
    let maxFeePerGas = (block.baseFeePerGas ?? 0n) * 2n + maxPriorityFeePerGas;
    if (maxFeePerGas < bump(minFees.maxFeePerGas)) maxFeePerGas = bump(minFees.maxFeePerGas);
    const raw = await wallet.signTransaction({
        account, chain, to: account.address, value: 0n, data: '0x', type: 'eip1559', nonce, gas: 21_000n, maxFeePerGas, maxPriorityFeePerGas,
    });
    return { hash: keccak256(raw), raw, maxFeePerGas, maxPriorityFeePerGas };
}

/** Sends a signed transaction. Throws NonceConflictError if the nonce was used by something that is not this transaction. */
export async function broadcast(raw) {
    const hash = keccak256(raw);
    try {
        return await publicClient.sendRawTransaction({ serializedTransaction: raw });
    } catch (err) {
        const msg = `${err.message} ${err.details || ''}`;
        if (/already known|known transaction|already imported/i.test(msg)) return hash;
        if (/nonce too low|nonce has already been used|replacement transaction underpriced/i.test(msg)) {
            // Fine if it is our own transaction that already landed or is pending.
            if ((await getReceipt(hash)) || (await getTransaction(hash))) return hash;
            throw new NonceConflictError(msg.slice(0, 200));
        }
        throw err;
    }
}

const isNotFound = (err) => /NotFound/.test(err?.name || '') || /could not be found|not found/i.test(err?.shortMessage || '');

/** The receipt, or null only when the node says the transaction has none. Any other RPC error throws. */
export async function getReceipt(hash) {
    try {
        return await publicClient.getTransactionReceipt({ hash });
    } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
    }
}

export async function getTransaction(hash) {
    try {
        return await publicClient.getTransaction({ hash });
    } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
    }
}

export function waitForReceipt(hash, timeout = 60_000) {
    return publicClient.waitForTransactionReceipt({ hash, timeout, pollingInterval: 1000 });
}

/** HyperEVM-specific: whether an address sends its transactions in big blocks. */
export async function usingBigBlocks(address) {
    return Boolean(await publicClient.request({ method: 'eth_usingBigBlocks', params: [address] }));
}

export async function confirmedNonce(address) {
    return publicClient.getTransactionCount({ address, blockTag: 'latest' });
}

// All relayer/migrator transactions go through one queue so two jobs never
// race for the same nonce.
let queue = Promise.resolve();
export function serial(fn) {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
}
