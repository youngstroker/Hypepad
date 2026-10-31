// All runtime configuration comes from environment variables (see .env.example).
// Anything the browser may see is exposed through publicConfig(); secrets never are.
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

const root = path.resolve(import.meta.dirname, '..');
dotenv.config({ path: path.join(root, '.env') });

const env = process.env;
const num = (name, fallback) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
    return n;
};
const bool = (name, fallback = false) => (env[name] === undefined ? fallback : ['1', 'true', 'yes'].includes(env[name].toLowerCase()));

const SOLANA_RPC_DEFAULTS = {
    'mainnet-beta': 'https://api.mainnet-beta.solana.com',
    devnet: 'https://api.devnet.solana.com',
};
const HYPEREVM_DEFAULTS = {
    999: { rpc: 'https://rpc.hyperliquid.xyz/evm', explorer: 'https://hyperevmscan.io', name: 'HyperEVM' },
    998: { rpc: 'https://rpc.hyperliquid-testnet.xyz/evm', explorer: 'https://testnet.purrsec.com', name: 'HyperEVM Testnet' },
    31337: { rpc: 'http://127.0.0.1:8545', explorer: '', name: 'Local HyperEVM (Hardhat)' },
};

const solanaCluster = env.SOLANA_CLUSTER || 'mainnet-beta';
if (!SOLANA_RPC_DEFAULTS[solanaCluster]) throw new Error('SOLANA_CLUSTER must be mainnet-beta or devnet');

const chainId = num('HYPEREVM_CHAIN_ID', 999);
const evmDefaults = HYPEREVM_DEFAULTS[chainId] || { rpc: '', explorer: '', name: `Chain ${chainId}` };

// A local deployment file lets `npm run setup:local` skip copying addresses by hand.
function deploymentFor(id) {
    const file = { 31337: 'localhost', 998: 'hyperevmTestnet', 999: 'hyperevm' }[id];
    try {
        return JSON.parse(fs.readFileSync(path.join(root, 'contracts/deployments', `${file}.json`), 'utf8'));
    } catch {
        return null;
    }
}
const deployment = deploymentFor(chainId);

export const config = {
    root,
    port: num('PORT', 4191),
    host: env.HOST || '127.0.0.1',
    publicUrl: (env.PUBLIC_URL || `http://127.0.0.1:${num('PORT', 4191)}`).replace(/\/$/, ''),
    // Number of proxies in front of the app: 1 behind Caddy, 2 behind Vercel + Caddy.
    // 'true' means 1. Each hop's X-Forwarded-For entry is trusted, so never set it higher than reality.
    trustProxy: /^\d+$/.test(env.TRUST_PROXY || '') ? Number(env.TRUST_PROXY) : bool('TRUST_PROXY') ? 1 : 0,
    siteName: env.SITE_NAME || 'HyperPump',
    // Shared with the Vercel project (PROXY_SECRET there too): requests that
    // carry it may tell us the visitor's real IP.
    proxySecret: env.PROXY_SECRET || '',
    dataDir: path.resolve(root, env.DATA_DIR || 'data'),

    solana: {
        cluster: solanaCluster,
        rpcUrl: env.SOLANA_RPC_URL || SOLANA_RPC_DEFAULTS[solanaCluster],
        treasury: env.TREASURY_PUBLIC_KEY || '',
        treasurySecret: env.TREASURY_SECRET_KEY || '',
        pollMs: num('SOLANA_POLL_MS', 8000),
    },

    evm: {
        chainId,
        chainName: evmDefaults.name,
        rpcUrl: env.HYPEREVM_RPC_URL || evmDefaults.rpc,
        // Visitor-driven reads (quotes, balances); defaults to the main RPC.
        readRpcUrl: env.HYPEREVM_READ_RPC_URL || env.HYPEREVM_RPC_URL || evmDefaults.rpc,
        // What browsers and wallets are told to use. Never a keyed private URL.
        publicRpcUrl: env.PUBLIC_HYPEREVM_RPC_URL || evmDefaults.rpc,
        explorer: (env.HYPEREVM_EXPLORER ?? evmDefaults.explorer).replace(/\/$/, ''),
        factory: env.FACTORY_ADDRESS || deployment?.factory || '',
        deployBlock: BigInt(env.FACTORY_DEPLOY_BLOCK || deployment?.deployBlock || 0),
        relayerKey: env.RELAYER_PRIVATE_KEY || '',
        migratorKey: env.MIGRATOR_PRIVATE_KEY || '',
        logChunk: BigInt(num('HYPEREVM_LOG_CHUNK', 500)),
        pollMs: num('HYPEREVM_POLL_MS', 3000),
        gasReserveHype: num('RELAYER_GAS_RESERVE_HYPE', 0.5),
    },

    fees: {
        launchFeeSol: num('LAUNCH_FEE_SOL', 0.05),
        conversionSpreadBps: num('CONVERSION_SPREAD_BPS', 100),
    },
    limits: {
        minBuySol: num('MIN_BUY_SOL', 0.01),
        maxOrderSol: num('MAX_ORDER_SOL', 25),
        maxSlippageBps: 5000,
        quoteTtlSec: num('QUOTE_TTL_SECONDS', 600),
        maxUploadBytes: num('MAX_UPLOAD_BYTES', 2 * 1024 * 1024),
    },

    prices: {
        // Fixed prices are for a local chain only: the server refuses them on mainnet.
        fixedSolUsd: num('PRICE_FIXED_SOL_USD', 0),
        fixedHypeUsd: num('PRICE_FIXED_HYPE_USD', 0),
        maxDivergenceBps: num('PRICE_MAX_DIVERGENCE_BPS', 300),
        cacheMs: num('PRICE_CACHE_MS', 15000),
    },
};

export const isMainnet = config.solana.cluster === 'mainnet-beta' || config.evm.chainId === 999;

export function validateConfig() {
    const problems = [];
    if (!config.solana.treasury) problems.push('TREASURY_PUBLIC_KEY is not set: payments are disabled.');
    if (!config.evm.factory) problems.push('FACTORY_ADDRESS is not set: launches are disabled.');
    if (!config.evm.relayerKey) problems.push('RELAYER_PRIVATE_KEY is not set: launches are disabled.');
    if (!config.solana.treasurySecret) problems.push('TREASURY_SECRET_KEY is not set: refunds will wait for manual processing (npm run admin).');
    if (isMainnet && (config.prices.fixedSolUsd || config.prices.fixedHypeUsd)) {
        throw new Error('PRICE_FIXED_* is only allowed on a local/test setup, never on mainnet.');
    }
    if (config.evm.chainId === 999 && config.evm.factory && config.evm.deployBlock === 0n) {
        throw new Error('FACTORY_DEPLOY_BLOCK must be set on mainnet (the block the factory was deployed in), or the indexer scans from genesis.');
    }
    if (isMainnet && (config.solana.cluster !== 'mainnet-beta' || config.evm.chainId !== 999)) {
        throw new Error('Mixing a mainnet chain with a test chain would let test SOL buy real HYPE (or the reverse). Use mainnet-beta with 999, or devnet with 998/31337.');
    }
    return problems;
}

export function publicConfig() {
    return {
        siteName: config.siteName,
        solana: { cluster: config.solana.cluster, treasury: config.solana.treasury },
        evm: {
            chainId: config.evm.chainId,
            chainName: config.evm.chainName,
            rpcUrl: config.evm.publicRpcUrl,
            explorer: config.evm.explorer,
            factory: config.evm.factory,
        },
        fees: config.fees,
        limits: {
            minBuySol: config.limits.minBuySol,
            maxOrderSol: config.limits.maxOrderSol,
            maxSlippageBps: config.limits.maxSlippageBps,
            quoteTtlSec: config.limits.quoteTtlSec,
            maxUploadBytes: config.limits.maxUploadBytes,
        },
    };
}
