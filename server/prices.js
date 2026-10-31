// SOL/USD and HYPE/USD. Primary source is Hyperliquid's own mid prices; the
// second source is CoinGecko. When both answer and disagree by more than
// PRICE_MAX_DIVERGENCE_BPS, quoting stops rather than guessing.
import { config } from './config.js';

let cache = null;
let inflight = null;

async function fetchJson(url, init) {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    return res.json();
}

async function fromHyperliquid() {
    const mids = await fetchJson('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'allMids' }),
    });
    return { solUsd: Number(mids.SOL), hypeUsd: Number(mids.HYPE) };
}

async function fromCoinGecko() {
    const data = await fetchJson('https://api.coingecko.com/api/v3/simple/price?ids=solana,hyperliquid&vs_currencies=usd');
    return { solUsd: Number(data.solana?.usd), hypeUsd: Number(data.hyperliquid?.usd) };
}

const valid = (p) => p && p.solUsd > 0 && p.hypeUsd > 0 && Number.isFinite(p.solUsd) && Number.isFinite(p.hypeUsd);
const diffBps = (a, b) => (Math.abs(a - b) / Math.min(a, b)) * 10_000;

async function load() {
    const { fixedSolUsd, fixedHypeUsd, maxDivergenceBps } = config.prices;
    if (fixedSolUsd && fixedHypeUsd) {
        return { solUsd: fixedSolUsd, hypeUsd: fixedHypeUsd, source: 'fixed (local only)' };
    }
    const [hl, cg] = await Promise.allSettled([fromHyperliquid(), fromCoinGecko()]);
    const a = hl.status === 'fulfilled' && valid(hl.value) ? hl.value : null;
    const b = cg.status === 'fulfilled' && valid(cg.value) ? cg.value : null;
    if (!a && !b) throw new Error('No price source is reachable right now.');
    if (a && b && (diffBps(a.solUsd, b.solUsd) > maxDivergenceBps || diffBps(a.hypeUsd, b.hypeUsd) > maxDivergenceBps)) {
        throw new Error('Price sources disagree; quoting is paused until they agree again.');
    }
    const p = a || b;
    return { ...p, source: a ? (b ? 'hyperliquid+coingecko' : 'hyperliquid') : 'coingecko' };
}

/** @returns {Promise<{solUsd:number, hypeUsd:number, solHype:number, source:string, at:number}>} */
export async function getPrices({ fresh = false } = {}) {
    if (!fresh && cache && Date.now() - cache.at < config.prices.cacheMs) return cache;
    inflight ||= load()
        .then((p) => (cache = { ...p, solHype: p.solUsd / p.hypeUsd, at: Date.now() }))
        .finally(() => (inflight = null));
    return inflight;
}

/** Cached prices for display only; never use for quoting. */
export function lastPrices() {
    return cache;
}
