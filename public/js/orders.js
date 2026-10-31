import { h, $, openModal, copyText, toast, coinImage } from './dom.js';
import { api } from './api.js';
import { sol, tokens, short, tinyNumber } from './format.js';
import { payOrder, wallets, walletErrorMessage } from './wallets.js';
import { rememberOrder } from './settings.js';
import { store, explorerUrl, solscanUrl } from './store.js';

const SIG_KEY = 'hp.sigs.v1';
const FINAL = ['completed', 'refunded', 'expired', 'needs_review'];
const DROPPED = 'Your payment did not go through. Nothing was charged; you can pay again.';
const HEIGHT_EVERY = 4; // polls between block-height checks
const HEIGHT_MARGIN = 64; // blocks; a payment that landed just in time still needs to finalize
let active = null; // { id, timer }: the one polling loop allowed to run
let viewing = null; // the order currently shown in the modal

function sigs() {
    try { return JSON.parse(localStorage.getItem(SIG_KEY) || '{}'); } catch { return {}; }
}
function saveSig(id, signature, lastValidBlockHeight) {
    try { localStorage.setItem(SIG_KEY, JSON.stringify({ ...sigs(), [id]: { signature, lastValidBlockHeight } })); } catch { /* ignore */ }
}
function savedSig(id) {
    const s = sigs()[id];
    if (!s) return null;
    return typeof s === 'string' ? { signature: s, lastValidBlockHeight: null } : s; // older entries were bare signatures
}
function clearSig(id) {
    try {
        const all = sigs();
        delete all[id];
        localStorage.setItem(SIG_KEY, JSON.stringify(all));
    } catch { /* ignore */ }
}

function stopPolling() {
    clearTimeout(active?.timer);
    active = null;
}

const link = (href, text) => (href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text) : text);
const kv = (rows) => h('dl.kv', rows.filter(Boolean).map(([k, v, cls]) => h(`div${cls ? `.${cls}` : ''}`, h('dt', k), h('dd', v))));

function title(order) {
    const sym = order.payload?.symbol || order.symbol || '';
    return order.kind === 'launch' ? `Launch $${sym}` : `Buy ${sym ? `$${sym}` : 'coin'}`;
}

function stepsFor(order, { sending, signature }) {
    const s = order.status;
    const failed = ['refunding', 'refunded'].includes(s);
    const paidish = ['paid', 'processing', 'completed', 'refunding', 'refunded'].includes(s);
    const steps = [
        { label: 'Approve in your wallet', state: signature || paidish ? 'done' : sending ? 'active' : '' },
        { label: 'Finalizing on Solana', note: '~15s', state: paidish ? 'done' : signature ? 'active' : '' },
        { label: order.kind === 'launch' ? 'Creating coin on HyperEVM' : 'Buying on HyperEVM', state: s === 'completed' ? 'done' : failed ? 'fail' : paidish ? 'active' : '' },
        { label: failed ? (s === 'refunded' ? 'SOL refunded' : 'Refunding SOL') : order.kind === 'launch' ? 'Coin is live' : 'Tokens delivered', state: s === 'completed' || s === 'refunded' ? 'done' : s === 'refunding' ? 'active' : '' },
    ];
    return h('ol.order-steps', steps.map((st) => h(`li${st.state ? `.${st.state}` : ''}`, h('span.dot'), st.label, st.note && h('small', st.note))));
}

function render(order, ui) {
    if (viewing !== order.id) return; // a timer from an earlier order
    const body = $('#orderBody');
    const sym = order.payload?.symbol || ui.symbol || '';
    const head = h('div.order-head',
        coinImage({ image: order.payload?.image || ui.image, symbol: sym || '?' }),
        h('div', h('h2#orderTitle', title({ ...order, symbol: sym })), h('p.eyebrow', `Order ${order.id}`)));

    const quoteRows = [
        order.lamportsFee > 0 && ['Launch fee', sol(order.lamportsFee)],
        order.lamportsTrade > 0 && [order.kind === 'launch' ? 'Initial buy' : 'Buy', sol(order.lamportsTrade)],
        ['Total', sol(order.lamportsTotal), 'total'],
    ];
    const detailRows = [
        order.lamportsTrade > 0 && ['You receive (est.)', `${tokens(order.quote.tokensWei)} $${sym}`],
        order.lamportsTrade > 0 && ['Minimum after slippage', `${tokens(order.quote.minTokensWei)} $${sym}`],
        order.quote.solUsd && ['Rate at quote', `1 SOL → ${tinyNumber((order.quote.solUsd / order.quote.hypeUsd) * (1 - order.quote.spreadBps / 10_000))} HYPE (after ${order.quote.spreadBps / 100}% spread)`],
        ['Pay to', h('span', link(solscanUrl('account', order.treasury), short(order.treasury, 6)), ' ', h('button.copy', { type: 'button', onclick: () => copyText(order.treasury, 'Treasury address copied') }, 'copy'))],
        ['Memo', h('span.mono', order.memo)],
        ['Coins go to', h('span.mono', short(order.recipient, 6))],
    ];

    const parts = [head];
    if (order.status === 'awaiting_payment' && !ui.signature) {
        const left = Math.max(0, order.expiresAt - Math.floor(Date.now() / 1000));
        parts.push(
            h('p.eyebrow', 'Quote'), kv(quoteRows), h('dl.kv.muted', detailRows.filter(Boolean).map(([k, v]) => h('div', h('dt', k), h('dd', v)))),
            h('p.hint', { style: { marginTop: '14px' } }, `Quote valid for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}. Your wallet will show this exact amount and destination. The HYPE amount is re-priced when your order fills; if you would get less than the minimum above, you are refunded.`),
            ui.error && h('div.callout.err', ui.error),
            h('div.actions',
                h('button.btn.btn-ghost', { type: 'button', 'data-close': true }, 'Cancel'),
                h(`button.btn.btn-primary${ui.sending ? '.loading' : ''}`, { type: 'button', disabled: ui.sending || left === 0 || !wallets().sol, onclick: () => pay(order, ui) },
                    !wallets().sol ? 'Connect wallet first' : left === 0 ? 'Quote expired' : `Pay ${sol(order.lamportsTotal)}`)),
        );
    } else {
        parts.push(kv(quoteRows), stepsFor(order, ui));
        if (order.status === 'awaiting_payment' && ui.signature) {
            parts.push(ui.notice
                ? h('div.callout.warn', ui.notice)
                : h('div.callout', 'Payment sent. Waiting for Solana to finalize it. You can close this window: your order keeps going and is listed under Settings → My orders.'));
        }
        if (order.status === 'paid' || order.status === 'processing') {
            parts.push(h('div.callout', order.error === 'Waiting for relayer liquidity'
                ? 'Payment received. The relayer is topping up HYPE; your order fills automatically, or is refunded if that takes more than 15 minutes.'
                : 'Payment received. Filling your order on HyperEVM…'));
        }
        if (order.status === 'completed') {
            const tokenAddr = order.token;
            parts.push(
                h('div.callout.ok', order.kind === 'launch' ? `$${sym} is live on HyperEVM.` : `Bought ${tokens(order.tokensOutWei)} $${sym}.`,
                    order.refundLamports ? ` ${sol(order.refundLamports)} of unused SOL is being returned to you.` : ''),
                kv([
                    order.tokensOutWei && ['Tokens received', `${tokens(order.tokensOutWei)} $${sym}`],
                    tokenAddr && ['Contract', h('span', link(explorerUrl('address', tokenAddr), short(tokenAddr, 6)), ' ', h('button.copy', { type: 'button', onclick: () => copyText(tokenAddr, 'Contract copied') }, 'copy'))],
                    order.evmTxHash && ['HyperEVM tx', link(explorerUrl('tx', order.evmTxHash), short(order.evmTxHash, 6))],
                    order.solSignature && ['Solana payment', link(solscanUrl('tx', order.solSignature), short(order.solSignature, 6))],
                ]),
                h('div.actions',
                    h('button.btn.btn-ghost', { type: 'button', 'data-close': true }, 'Close'),
                    tokenAddr && h('button.btn.btn-primary', { type: 'button', onclick: () => { $('#orderModal').close(); ui.onOpenToken?.(tokenAddr); } }, 'View coin ↗')),
            );
        }
        if (order.status === 'refunding' || order.status === 'refunded') {
            parts.push(
                h('div.callout.err', `This order could not be filled: ${order.error || 'unknown error'}`),
                kv([
                    ['Refund', order.refundLamports ? sol(order.refundLamports) : '—'],
                    ['To', h('span.mono', short(order.payer || '', 6))],
                    order.refundSignature ? ['Refund tx', link(solscanUrl('tx', order.refundSignature), short(order.refundSignature, 6))] : ['Status', 'Refund queued'],
                ]),
            );
        }
        if (order.status === 'expired') parts.push(h('div.callout.warn', 'This quote expired without a payment. Nothing was charged.'));
        if (order.status === 'needs_review') {
            parts.push(h('div.callout.warn', `Your payment arrived, but this order needs a manual check before it can finish. Nothing is lost: it will either be completed or refunded to the wallet that paid. Keep this order number for support: ${order.id}.`));
        }
    }
    body.replaceChildren(...parts.filter(Boolean));
}

async function pay(order, ui) {
    if (ui.sending) return;
    ui.sending = true;
    ui.error = null;
    render(order, ui);
    try {
        const { signature, lastValidBlockHeight } = await payOrder(order);
        Object.assign(ui, { signature, lastValidBlockHeight, matched: false });
        saveSig(order.id, signature, lastValidBlockHeight);
        toast('Payment sent. Waiting for Solana to finalize.', 'ok');
    } catch (err) {
        ui.error = walletErrorMessage(err);
    } finally {
        ui.sending = false;
        render(order, ui);
    }
    if (ui.signature) poll(order.id, ui);
}

/**
 * True only when the sent payment provably cannot land: Solana says it failed,
 * or its blockhash expired AND Solana has no record of the signature.
 */
async function dropped(result, signature, lastValidBlockHeight, checkHeight) {
    if (result?.state === 'ignored') return result.reason === 'tx_failed';
    if (result?.state !== 'pending' || !lastValidBlockHeight || !checkHeight) return false;
    try {
        const { blockHeight } = await api('/solana/blockheight');
        if (blockHeight <= lastValidBlockHeight + HEIGHT_MARGIN) return false;
        const { state } = await api(`/solana/signature/${signature}`);
        return state === 'unknown' || state === 'failed';
    } catch {
        return false;
    }
}

/** What to tell the user when SOL arrived but could not be applied to this order. */
function notApplied(result, order) {
    const r = result?.reason || '';
    if (r === 'refund:underpaid') return 'Your payment was less than the quoted amount, so it was not applied to this order. It is being refunded to the wallet that paid.';
    if (r === 'refund:duplicate_payment') return 'This order was already paid. This extra payment is being refunded to the wallet that paid.';
    return `Your payment arrived but needs a manual check before it can be applied. Nothing is lost: it will be applied or refunded. Order number for support: ${order.id}.`;
}

function poll(id, ui) {
    stopPolling();
    const me = active = { id, timer: null };
    let ticks = 0;
    let busySince = 0;
    const later = (ms) => { me.timer = setTimeout(tick, ms); };
    const tick = async () => {
        if (active !== me) return;
        ticks += 1;
        let order = null;
        let result = null;
        try {
            if (ui.signature && !ui.matched) ({ result, order } = await api(`/orders/${id}/payment`, { method: 'POST', body: { signature: ui.signature } }));
            else order = await api(`/orders/${id}`);
        } catch (err) {
            if (active !== me) return;
            if (err.status === 429) return later(6000);
        }
        if (active !== me) return;
        if (!order) return later(2500);

        if (result?.state === 'matched' || order.status !== 'awaiting_payment') ui.matched = true;
        if (order.status === 'awaiting_payment' && result?.state === 'ignored' && result.reason !== 'tx_failed') {
            stopPolling();
            ui.notice = notApplied(result, order);
            render(order, ui);
            return;
        }
        const gone = order.status === 'awaiting_payment' && ui.signature && !ui.matched
            && await dropped(result, ui.signature, ui.lastValidBlockHeight, ticks % HEIGHT_EVERY === 0);
        if (active !== me) return;
        if (gone) {
            stopPolling();
            clearSig(id);
            Object.assign(ui, { signature: null, lastValidBlockHeight: null, error: DROPPED });
            render(order, ui);
            countdown(order, ui);
            return;
        }

        if ($('#orderModal').open) render(order, ui);
        if (order.status === 'completed' && !ui.notified) {
            ui.notified = true;
            ui.onComplete?.(order);
        }
        if (FINAL.includes(order.status)) {
            active = null;
            return;
        }
        // Back off while the relayer works on a slow fill.
        if (order.status === 'paid' || order.status === 'processing') busySince ||= Date.now();
        else busySince = 0;
        const busy = busySince ? Date.now() - busySince : 0;
        later(order.status === 'refunding' ? 8000 : busy > 180_000 ? 10_000 : busy > 60_000 ? 5000 : 2500);
    };
    tick();
}

// Re-renders every second so the quote timer counts down while the user decides.
function countdown(order, ui) {
    clearInterval(ui.countdown);
    ui.countdown = setInterval(() => {
        if (viewing !== order.id || !$('#orderModal').open || ui.signature || order.status !== 'awaiting_payment') return clearInterval(ui.countdown);
        if (!ui.sending) render(order, ui);
    }, 1000);
}

/** Shows a fresh quote and walks the user through paying it. */
export function startOrder(order, ui = {}) {
    rememberOrder(order);
    stopPolling();
    viewing = order.id;
    render(order, ui);
    openModal('orderModal');
    countdown(order, ui);
}

/** Re-opens an earlier order, e.g. from Settings → My orders. */
export async function resumeOrder(id, ui = {}) {
    const order = await api(`/orders/${id}`);
    const saved = savedSig(id);
    if (!ui.signature && saved) Object.assign(ui, { signature: saved.signature, lastValidBlockHeight: saved.lastValidBlockHeight });
    ui.signature ||= null;
    stopPolling();
    viewing = id;
    render(order, ui);
    openModal('orderModal');
    if (!FINAL.includes(order.status) && (ui.signature || order.status !== 'awaiting_payment')) poll(id, ui);
    if (order.status === 'awaiting_payment' && !ui.signature) startOrder(order, ui);
}

export function statusLabel(s) {
    return {
        awaiting_payment: 'Awaiting payment', paid: 'Paid', processing: 'Filling', completed: 'Completed',
        refunding: 'Refunding', refunded: 'Refunded', expired: 'Expired', needs_review: 'Under review',
    }[s] || s;
}

export const configReady = () => Boolean(store.config?.ready);
