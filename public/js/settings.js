// Per-browser preferences. Storage can be unavailable (private mode), so every
// access is guarded and the defaults always work.
const KEY = 'hp.settings.v1';
const ORDERS_KEY = 'hp.orders.v1';

export const DEFAULTS = Object.freeze({
    currency: 'usd',
    slippageBps: '300',
    priority: 'normal',
    defaultRecipient: '',
    autoRefresh: true,
    reduceMotion: false,
});

// microLamports per compute unit; payment txs use ~600 CU so even turbo costs well under 0.0001 SOL.
export const PRIORITY = { off: 0, normal: 20_000, fast: 200_000, turbo: 1_000_000 };

function read(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch {
        return fallback;
    }
}
function write(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch { /* storage unavailable: settings last for this visit only */ }
}

let current = { ...DEFAULTS, ...read(KEY, {}) };
const listeners = new Set();

export const settings = () => current;
export function updateSettings(patch) {
    current = { ...current, ...patch };
    write(KEY, current);
    listeners.forEach((fn) => fn(current));
}
export function resetSettings() {
    current = { ...DEFAULTS };
    write(KEY, current);
    listeners.forEach((fn) => fn(current));
}
export const onSettings = (fn) => listeners.add(fn);

export function savedOrders() {
    return read(ORDERS_KEY, []);
}
export function rememberOrder(order) {
    const list = savedOrders().filter((o) => o.id !== order.id);
    list.unshift({ id: order.id, kind: order.kind, label: order.payload?.symbol || order.label || '', createdAt: order.createdAt });
    write(ORDERS_KEY, list.slice(0, 30));
}
