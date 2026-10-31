// Shared app state: server config and the latest prices.
import { api } from './api.js';

// comingSoon: the API answers 404, i.e. the site is deployed but its backend
// is not yet (see middleware.js). Any other API failure is a real outage.
export const store = { config: null, prices: null, comingSoon: false };
const listeners = new Set();
export const onStore = (fn) => listeners.add(fn);
const emit = () => listeners.forEach((fn) => fn(store));

export async function loadConfig() {
    try {
        store.config = await api('/config');
    } catch (err) {
        if (err.status === 404) markComingSoon();
        throw err;
    }
    emit();
    return store.config;
}

export function markComingSoon() {
    if (store.comingSoon) return;
    store.comingSoon = true;
    emit();
}

export async function refreshPrices() {
    try {
        store.prices = await api('/prices');
        emit();
    } catch { /* keep the last prices */ }
    return store.prices;
}

/** HYPE the relayer would spend for `sol` SOL, after the disclosed spread. Display estimate only. */
export function solToHype(sol) {
    const p = store.prices;
    const spread = store.config?.fees.conversionSpreadBps ?? 0;
    return p ? sol * p.solHype * (1 - spread / 10_000) : NaN;
}

export function explorerUrl(kind, id) {
    const base = store.config?.evm.explorer;
    return base ? `${base}/${kind}/${id}` : null;
}

export function solscanUrl(kind, id) {
    const c = store.config?.solana.cluster;
    return `https://solscan.io/${kind}/${id}${c === 'devnet' ? '?cluster=devnet' : ''}`;
}
