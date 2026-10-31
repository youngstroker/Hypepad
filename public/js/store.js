// Shared app state: server config and the latest prices.
import { api } from './api.js';

export const store = { config: null, prices: null };
const listeners = new Set();
export const onStore = (fn) => listeners.add(fn);
const emit = () => listeners.forEach((fn) => fn(store));

export async function loadConfig() {
    store.config = await api('/config');
    emit();
    return store.config;
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
