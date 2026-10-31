import { formatUnits } from '/vendor/libs.js';

const SUBSCRIPT = '₀₁₂₃₄₅₆₇₈₉';

/** Very small prices: $0.0₅1234 (5 zeros after the point). */
export function tinyNumber(n, sig = 4) {
    if (!Number.isFinite(n) || n === 0) return '0';
    if (n >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: n >= 1000 ? 0 : 4 });
    if (n >= 0.001) return n.toPrecision(sig).replace(/0+$/, '').replace(/\.$/, '');
    const s = n.toExponential(sig - 1); // e.g. 1.234e-7
    const [mant, exp] = s.split('e');
    const zeros = -Number(exp) - 1;
    const digits = mant.replace('.', '').replace(/0+$/, '');
    return `0.0${[...String(zeros)].map((d) => SUBSCRIPT[d]).join('')}${digits}`;
}

export function compact(n, digits = 2) {
    if (!Number.isFinite(n)) return '—';
    return Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: digits }).format(n);
}

export const usd = (n) => (Number.isFinite(n) ? `$${n >= 1000 ? compact(n) : n.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: n < 1 && n > 0 ? 2 : 0 })}` : '—');
export const usdPrice = (n) => (Number.isFinite(n) && n > 0 ? `$${tinyNumber(n)}` : '—');
export const hype = (n) => (Number.isFinite(n) ? `${n >= 1000 ? compact(n) : n.toLocaleString(undefined, { maximumFractionDigits: n < 1 ? 4 : 2 })} HYPE` : '—');
export const hypePrice = (n) => (Number.isFinite(n) && n > 0 ? `${tinyNumber(n)} HYPE` : '—');
export const sol = (lamports) => `${(Number(lamports) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 4 })} SOL`;
export const tokens = (wei) => compact(Number(formatUnits(BigInt(wei || 0), 18)));
export const short = (addr, n = 4) => (addr ? `${addr.slice(0, n + (addr.startsWith('0x') ? 2 : 0))}…${addr.slice(-n)}` : '');

export function pct(n) {
    if (!Number.isFinite(n)) return { text: '—', cls: 'flat' };
    const sign = n > 0 ? '+' : '';
    return { text: `${sign}${n.toFixed(Math.abs(n) >= 100 ? 0 : 1)}%`, cls: n > 0.05 ? 'up' : n < -0.05 ? 'down' : 'flat' };
}

export function ago(ts) {
    if (!ts) return '';
    const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
}
