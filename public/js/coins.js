import { h, $, $$, openModal, copyText, toast, coinImage } from './dom.js';
import { api } from './api.js';
import { usd, usdPrice, hype, hypePrice, pct, ago, short, compact, tokens as fmtTokens } from './format.js';
import { settings } from './settings.js';
import { store, explorerUrl, solToHype, markComingSoon } from './store.js';
import { wallets, onWallets, connectEvm, sendEvmTx, hasEvmWallet, walletErrorMessage } from './wallets.js';
import { encodeFunctionData, parseEther, parseUnits, formatUnits, maxUint256, isAddress } from '/vendor/libs.js';

const PAGE = 24;
// loading: false | 'quiet' (background refresh) | 'user'. seq: only the newest request may write.
const feed = { sort: 'new', q: '', offset: 0, items: [], loading: false, hasMore: false, seq: 0 };
let openToken = null; // address of the coin in the modal
let tradeMode = 'sol'; // trade tab, kept across auto-refreshes of the same coin
let tradeModeToken = null;
let trading = 0; // trades in flight; auto-refresh waits for them
let hooks = {};

const FACTORY_ABI = [
    { type: 'function', name: 'buy', stateMutability: 'payable', inputs: [{ name: 'token', type: 'address' }, { name: 'minTokensOut', type: 'uint256' }, { name: 'recipient', type: 'address' }], outputs: [{ type: 'uint256' }] },
    { type: 'function', name: 'sell', stateMutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }, { name: 'tokenAmount', type: 'uint256' }, { name: 'minHypeOut', type: 'uint256' }, { name: 'recipient', type: 'address' }], outputs: [{ type: 'uint256' }] },
];
const ERC20_ABI = [{ type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] }];

// ---------------------------------------------------------------- formatting by preference

const inUsd = () => settings().currency === 'usd' && store.prices;
export const showPrice = (t) => (inUsd() ? usdPrice(t.priceUsd) : hypePrice(t.priceHype));
export const showCap = (t) => (inUsd() ? usd(t.marketCapUsd) : hype(t.marketCapHype));
const showHype = (n) => (inUsd() ? usd(n * store.prices.hypeUsd) : hype(n));

// ---------------------------------------------------------------- cards

export function coinCard(t, { interactive = true } = {}) {
    const chg = pct(t.change24h);
    const card = h(interactive ? 'button.coin-card' : 'div.coin-card.static', interactive ? { type: 'button', 'aria-label': `${t.name} ($${t.symbol})`, onclick: () => openTokenModal(t.address) } : {},
        h('div.coin-top',
            coinImage(t),
            h('div.coin-meta',
                h('div.coin-name', t.name || 'Your coin'),
                h('div.coin-sym', `$${t.symbol || 'TICKER'}`, t.complete ? [' ', h('span.badge', t.migrated ? 'On DEX' : 'Graduating')] : ''),
                h('div.coin-desc', t.description || ''))),
        h('div.coin-stats',
            h('div', h('span.lbl', 'Market cap'), h('span.mc', showCap(t))),
            h('div', { style: { textAlign: 'right' } }, h('span.lbl', 'Price'), h('span', showPrice(t)), ' ', h(`span.${chg.cls}`, chg.text))),
        h('div.progress', { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(t.progress || 0), 'aria-label': 'Bonding curve progress' },
            h('span', { style: { width: `${Math.max(t.progress || 0, 0.8)}%` } })),
        h('div.coin-foot', h('span', `${(t.progress || 0).toFixed(1)}% bonded`), h('span', t.createdAt ? ago(t.createdAt) : 'just now')));
    return card;
}

// ---------------------------------------------------------------- feed

function renderGrid() {
    const grid = $('#coinGrid');
    if (feed.loading && !feed.items.length) {
        grid.replaceChildren(...Array.from({ length: 8 }, () => h('div.skeleton')));
        return;
    }
    if (!feed.items.length && store.comingSoon) {
        grid.replaceChildren(h('div.empty.soon',
            h('span.pill-label', 'Launching soon'),
            h('h3', 'Coins appear here at launch'),
            h('p', 'Every coin launched on HyperPump shows up here with its price, market cap and bonding progress.')));
    } else if (!feed.items.length) {
        grid.replaceChildren(h('div.empty',
            h('h3', feed.q ? 'No coins match that search' : feed.sort === 'graduated' ? 'No coin has graduated yet' : 'No coins yet'),
            h('p', feed.q ? 'Try a different name, ticker or contract address.' : 'Be the first: launch one above.')));
    } else {
        grid.replaceChildren(...feed.items.map((t) => coinCard(t)));
    }
    $('#loadMore').hidden = !feed.hasMore;
}

export async function loadFeed({ append = false, quiet = false } = {}) {
    if (quiet && feed.loading) return;
    if (append && feed.loading === 'user') return;
    const my = ++feed.seq;
    feed.loading = quiet ? 'quiet' : 'user';
    if (!quiet) renderGrid();
    try {
        const params = new URLSearchParams({ sort: feed.sort, limit: String(PAGE), offset: String(append ? feed.offset : 0) });
        if (feed.q) params.set('q', feed.q);
        const res = await api(`/tokens?${params}`);
        if (my !== feed.seq) return;
        if (append) {
            const have = new Set(feed.items.map((t) => t.address));
            feed.items = [...feed.items, ...res.tokens.filter((t) => !have.has(t.address))];
            feed.offset += res.tokens.length;
            feed.hasMore = res.hasMore;
        } else if (quiet) {
            // Refresh the first page only and keep whatever was scrolled in below it.
            const fresh = new Map(res.tokens.map((t) => [t.address, t]));
            const have = new Set(feed.items.map((t) => t.address));
            const added = res.tokens.filter((t) => !have.has(t.address));
            feed.items = [...added, ...feed.items.map((t) => fresh.get(t.address) || t)];
            feed.offset += added.length;
            feed.hasMore ||= res.hasMore;
        } else {
            feed.items = res.tokens;
            feed.offset = res.tokens.length;
            feed.hasMore = res.hasMore;
        }
    } catch (err) {
        if (err.status === 404) markComingSoon();
        else if (!quiet && my === feed.seq) toast(err.message, 'err');
    } finally {
        if (my === feed.seq) {
            feed.loading = false;
            renderGrid();
        }
    }
}

export function wireFeed(opts) {
    hooks = opts;
    $$('#sortTabs button').forEach((b) => b.addEventListener('click', () => {
        feed.sort = b.dataset.sort;
        $$('#sortTabs button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
        loadFeed();
    }));
    let timer;
    $('#search').addEventListener('input', (e) => {
        clearTimeout(timer);
        timer = setTimeout(() => { feed.q = e.target.value.trim(); loadFeed(); }, 250);
    });
    $('#loadMore').addEventListener('click', () => loadFeed({ append: true }));
    onWallets((s) => $$('[data-sol-buy]').forEach((b) => (b.textContent = s.sol ? 'Buy' : 'Connect wallet to buy')));
}

export const rerenderFeed = () => renderGrid();

// ---------------------------------------------------------------- chart

function chart(points, up) {
    const W = 800, H = 240, P = 8;
    const wrap = h('div.chart');
    if (points.length < 2) {
        wrap.append(h('div.chart-tip', 'Chart appears after the first trade'));
        return wrap;
    }
    const xs = points.map((p) => p.t), ys = points.map((p) => p.p);
    const x0 = Math.min(...xs), x1 = Math.max(...xs) || x0 + 1;
    let y0 = Math.min(...ys), y1 = Math.max(...ys);
    if (y0 === y1) { y0 *= 0.95; y1 *= 1.05; }
    const X = (t) => P + ((t - x0) / (x1 - x0 || 1)) * (W - P * 2);
    const Y = (p) => H - P - ((p - y0) / (y1 - y0)) * (H - P * 2);
    // Step line: price holds until the next trade.
    let d = `M${X(xs[0])},${Y(ys[0])}`;
    for (let i = 1; i < points.length; i++) d += ` H${X(xs[i])} V${Y(ys[i])}`;
    const color = up ? 'var(--up)' : 'var(--down)';
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Price chart');
    const mk = (tag, attrs) => { const el = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); return el; };
    const gid = `g${Math.random().toString(36).slice(2)}`;
    const defs = mk('defs', {});
    const grad = mk('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 });
    grad.append(mk('stop', { offset: '0%', 'stop-color': up ? '#5ee6a0' : '#ff6b81', 'stop-opacity': '0.22' }), mk('stop', { offset: '100%', 'stop-color': up ? '#5ee6a0' : '#ff6b81', 'stop-opacity': '0' }));
    defs.append(grad);
    for (let i = 1; i < 4; i++) svg.append(mk('line', { x1: 0, x2: W, y1: (H / 4) * i, y2: (H / 4) * i, stroke: '#1d1d22', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }));
    svg.append(defs, mk('path', { d: `${d} V${H} H${X(xs[0])} Z`, fill: `url(#${gid})` }), mk('path', { d, fill: 'none', stroke: color, 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' }));
    const cross = mk('line', { y1: 0, y2: H, stroke: '#5d5a66', 'stroke-dasharray': '3 3', 'vector-effect': 'non-scaling-stroke', visibility: 'hidden' });
    svg.append(cross);
    const tip = h('div.chart-tip', `${points.length - 1} trades`);
    wrap.append(svg, tip);
    wrap.addEventListener('pointermove', (e) => {
        const r = wrap.getBoundingClientRect();
        const t = x0 + ((e.clientX - r.left) / r.width) * (x1 - x0);
        let i = points.findIndex((p) => p.t > t) - 1;
        if (i < 0) i = t < x0 ? 0 : points.length - 1;
        const p = points[i];
        cross.setAttribute('x1', X(t)); cross.setAttribute('x2', X(t)); cross.setAttribute('visibility', 'visible');
        tip.textContent = `${new Date(p.t * 1000).toLocaleString()} · ${inUsd() ? usdPrice(p.p * store.prices.hypeUsd) : hypePrice(p.p)}`;
    });
    wrap.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); tip.textContent = `${points.length - 1} trades`; });
    return wrap;
}

// ---------------------------------------------------------------- token modal

export async function openTokenModal(address) {
    openToken = address;
    if (tradeModeToken !== address) {
        tradeModeToken = address;
        tradeMode = 'sol';
    }
    const body = $('#tokenBody');
    body.replaceChildren(h('div', { style: { padding: '60px', textAlign: 'center', color: 'var(--muted)' } }, 'Loading…'));
    openModal('tokenModal');
    try {
        history.replaceState(null, '', `/coin/${address}`);
    } catch { /* ignore */ }
    await renderToken(address);
}

export async function refreshOpenToken() {
    if (trading || !openToken || !$('#tokenModal').open || $('#tokenModal').contains(document.activeElement?.closest('input'))) return;
    await renderToken(openToken, { quiet: true });
}

async function renderToken(address, { quiet = false } = {}) {
    let t, points;
    try {
        [t, points] = await Promise.all([api(`/tokens/${address}`), api(`/tokens/${address}/chart`).catch(() => [])]);
    } catch (err) {
        if (!quiet) $('#tokenBody').replaceChildren(h('div.empty', h('h3', 'Coin not found'), h('p', err.message)));
        return;
    }
    if (openToken !== address) return;
    document.title = `${t.name} ($${t.symbol}) · ${store.config?.siteName || 'HyperPump'}`;
    const chg = pct(t.change24h);
    const ex = (kind, id) => explorerUrl(kind, id);
    const lnk = (href, text) => (href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer nofollow' }, text) : null);
    const raiseTarget = store.config?.curve ? Number(store.config.curve.virtualHype) / 1e18 * (Number(store.config.curve.curveSupply) / (Number(store.config.curve.virtualToken) - Number(store.config.curve.curveSupply))) : null;

    const main = h('div.tk-main',
        h('div.tk-head',
            coinImage(t),
            h('div', { style: { minWidth: 0 } },
                h('h2#tokenTitle', t.name, h('small', `$${t.symbol}`), t.complete ? h('span.badge', t.migrated ? 'On DEX' : 'Graduating') : h('span.badge.live', 'Bonding')),
                h('div.tk-links',
                    h('button.copy', { type: 'button', onclick: () => copyText(t.address, 'Contract address copied') }, `CA ${short(t.address, 5)} ⧉`),
                    lnk(ex('address', t.address), 'Explorer ↗'),
                    lnk(t.twitter, 'X ↗'), lnk(t.telegram, 'Telegram ↗'), lnk(t.website, 'Website ↗'),
                    h('button.copy', { type: 'button', onclick: () => copyText(`${location.origin}/coin/${t.address}`, 'Link copied') }, 'Share ⧉')))),
        t.description && h('p.tk-desc', t.description),
        h('div.tk-price', h('span.big', showPrice(t)), h(`span.chg.${chg.cls}`, `${chg.text} 24h`)),
        chart(points, !(t.change24h < 0)),
        h('dl.tk-stats',
            h('div', h('dt', 'Market cap'), h('dd', showCap(t))),
            h('div', h('dt', '24h volume'), h('dd', showHype(t.volume24hHype || 0))),
            h('div', h('dt', 'Trades'), h('dd', compact(t.trades, 1))),
            h('div', h('dt', 'Buyers'), h('dd', compact(t.holdersApprox, 1)))),
        h('div.curve',
            h('div.curve-row', h('span', t.complete ? 'Bonding curve complete' : 'Bonding curve'), h('span', `${t.progress.toFixed(2)}% · ${hype(t.raisedHype)}${raiseTarget ? ` of ~${hype(raiseTarget)}` : ''}`)),
            h('div.progress', h('span', { style: { width: `${Math.max(t.progress, 0.8)}%` } })),
            h('p.hint', { style: { marginTop: '8px' } }, t.migrated
                ? h('span', 'Liquidity moved to the DEX and the LP tokens were burned. ', t.pair && lnk(ex('address', t.pair), 'View pool ↗'))
                : t.complete ? 'Sold out. Liquidity is moving to the DEX now.'
                    : 'When the curve sells out, the raised HYPE and the remaining 20% of supply seed a DEX pool and the LP is burned.')),
        h('div.trades',
            h('p.eyebrow', 'Recent trades'),
            t.recentTrades.length
                ? h('div.scroll', h('table',
                    h('thead', h('tr', h('th', 'Type'), h('th', 'Trader'), h('th', 'HYPE'), h('th', `$${t.symbol}`), h('th', 'When'))),
                    h('tbody', t.recentTrades.map((r) => h('tr',
                        h(`td.${r.isBuy ? 'up' : 'down'}`, r.isBuy ? 'Buy' : 'Sell'),
                        h('td', lnk(ex('address', r.trader), short(r.trader)) || short(r.trader)),
                        h('td', r.hype.toLocaleString(undefined, { maximumFractionDigits: 4 })),
                        h('td', compact(r.tokens)),
                        h('td', lnk(ex('tx', r.tx), ago(r.timestamp)) || ago(r.timestamp)))))))
                : h('p.hint', { style: { marginTop: '10px' } }, 'No trades yet.')));

    // A quiet refresh keeps the trade box (tab, typed values, results) unless what it shows changed.
    const body = $('#tokenBody');
    const key = `${Boolean(t.complete)}:${wallets().evm || ''}`;
    const kept = quiet && body.querySelector('.tk-side');
    if (kept && (kept.dataset.key === key || trading)) {
        body.querySelector('.tk-main').replaceWith(main);
        return;
    }
    const side = h('div.tk-side', { dataset: { key } }, tradeBox(t));
    body.replaceChildren(h('div.tk', main, side));
}

// ---------------------------------------------------------------- trading

function tradeBox(t) {
    const box = h('div.trade-box');
    if (t.complete) {
        box.append(h('p.eyebrow', 'Trade'), h('div.callout', t.migrated
            ? 'This coin graduated and now trades on the HyperEVM DEX. Use the contract address above in any HyperEVM DEX.'
            : 'The curve sold out. Liquidity is being moved to the DEX; trading resumes there shortly.'));
        return box;
    }
    const tabs = h('div.tabs', { role: 'tablist' },
        h('button', { role: 'tab', 'aria-selected': 'true', 'data-m': 'sol' }, 'Buy with SOL'),
        h('button', { role: 'tab', 'aria-selected': 'false', 'data-m': 'evm' }, 'HYPE wallet'));
    const pane = h('div');
    const draw = () => {
        [...tabs.children].forEach((b) => b.setAttribute('aria-selected', String(b.dataset.m === tradeMode)));
        pane.replaceChildren(tradeMode === 'sol' ? solPane(t) : evmPane(t));
    };
    tabs.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { tradeMode = b.dataset.m; draw(); } });
    box.append(h('p.eyebrow', { style: { marginBottom: '12px' } }, 'Trade'), tabs, pane);
    draw();
    return box;
}

// Spot-price estimate shown while the server quote (which walks the curve) loads.
function curveEstimate(t, hypeIn) {
    const fee = (store.config?.curve?.tradeFeeBps ?? 100) / 10_000;
    return (hypeIn * (1 - fee)) / t.priceHype;
}

function solPane(t) {
    const amount = h('input', { type: 'number', min: '0', step: '0.01', inputmode: 'decimal', placeholder: '0.00', 'aria-label': 'Amount in SOL' });
    const recipient = h('input.mono', { placeholder: '0x…', value: settings().defaultRecipient || wallets().evm || '', 'aria-label': 'HyperEVM address', spellcheck: 'false' });
    const est = h('b', '—');
    const quote = h('div.quote', h('div', h('span', 'You receive (est.)'), est), h('div', h('span', 'Slippage'), h('span', `${Number(settings().slippageBps) / 100}%`)), h('div', h('span', 'Conversion spread'), h('span', { 'data-spread': '' }, store.config ? `${store.config.fees.conversionSpreadBps / 100}%` : '…')));
    let seq = 0;
    let timer;
    // Local estimate right away; the server quote once typing pauses.
    const update = (delay = 300) => {
        clearTimeout(timer);
        const n = Number(amount.value);
        const my = ++seq;
        if (!(n > 0)) { est.textContent = '—'; return; }
        const h2 = solToHype(n);
        est.textContent = `~${compact(curveEstimate(t, h2))} $${t.symbol}`;
        timer = setTimeout(async () => {
            try {
                const q = await api(`/tokens/${t.address}/quote?side=buy&amount=${parseEther(h2.toFixed(18)).toString()}`);
                if (my === seq) est.textContent = `${fmtTokens(q.tokensOut)} $${t.symbol}`;
            } catch { /* keep the local estimate */ }
        }, delay);
    };
    amount.addEventListener('input', () => update());
    const chips = h('div.chips', ['0.1', '0.5', '1', '2', '5'].map((v) => h('button', { type: 'button', onclick: () => { amount.value = v; update(0); } }, `${v} SOL`)));
    const btn = h('button.btn.btn-primary.btn-block', { type: 'button', 'data-sol-buy': true }, wallets().sol ? 'Buy' : 'Connect wallet to buy');
    const err = h('p.form-error', { hidden: true, role: 'alert' });
    let busy = false;
    btn.addEventListener('click', async () => {
        if (busy) return;
        err.hidden = true;
        if (!wallets().sol) return hooks.connectSolana?.();
        if (!isAddress(recipient.value.trim())) { err.textContent = 'Enter the HyperEVM address that should receive the coins.'; err.hidden = false; return; }
        busy = true;
        trading += 1;
        btn.disabled = true;
        btn.classList.add('loading');
        try {
            const order = await api('/orders/buy', { method: 'POST', body: { token: t.address, solAmount: Number(amount.value), recipient: recipient.value.trim(), slippageBps: Number(settings().slippageBps) } });
            hooks.startOrder?.(order, { symbol: t.symbol, image: t.image });
        } catch (e) {
            err.textContent = e.message;
            err.hidden = false;
        } finally {
            busy = false;
            trading -= 1;
            btn.disabled = false;
            btn.classList.remove('loading');
        }
    });
    return h('div',
        h('div.field', h('label', 'Amount'), h('div.input-affix.right', amount, h('span', 'SOL')), chips),
        h('div.field', h('label', 'Send coins to (HyperEVM)'), recipient),
        quote, err, btn,
        h('p.hint', { style: { marginTop: '10px' } }, 'Paid in SOL, filled on HyperEVM within ~20 seconds. Refunded automatically if it cannot fill within your slippage.'));
}

function evmPane(t) {
    const cfg = store.config.evm;
    const w = wallets();
    if (!hasEvmWallet()) return h('div.callout', 'Install a HyperEVM wallet such as MetaMask or Rabby to trade with HYPE directly. You can still buy with SOL.');
    if (!w.evm) {
        return h('div', { style: { marginTop: '16px' } },
            h('p.hint', 'Buy and sell on the curve directly with HYPE from your HyperEVM wallet.'),
            h('button.btn.btn-primary.btn-block', { type: 'button', style: { marginTop: '14px' }, onclick: async () => {
                try { await connectEvm(cfg); renderToken(t.address); } catch (e) { toast(walletErrorMessage(e), 'err'); }
            } }, 'Connect HyperEVM wallet'));
    }
    let side = 'buy';
    let bal = null;
    const sideToggle = h('div.side-toggle', h('button', { type: 'button', 'data-side': 'buy', 'aria-pressed': 'true' }, 'Buy'), h('button', { type: 'button', 'data-side': 'sell', 'aria-pressed': 'false' }, 'Sell'));
    const unit = h('span', 'HYPE');
    const amount = h('input', { type: 'number', min: '0', step: 'any', inputmode: 'decimal', placeholder: '0.00', 'aria-label': 'Amount' });
    const balLine = h('div.bal', 'Balance: …');
    const est = h('b', '—');
    const btn = h('button.btn.btn-primary.btn-block', { type: 'button' }, 'Buy');
    const err = h('p.form-error', { hidden: true, role: 'alert' });
    let lastQuote = null;
    let seq = 0;
    let timer;
    let busy = false;

    const loadBal = async () => {
        try {
            bal = await api(`/evm/balances?owner=${w.evm}&token=${t.address}`);
            const shown = side === 'buy' ? `${Number(formatUnits(BigInt(bal.hype), 18)).toFixed(4)} HYPE` : `${fmtTokens(bal.token)} $${t.symbol}`;
            balLine.replaceChildren(`Balance: ${shown} `, h('button', { type: 'button', onclick: () => {
                if (side === 'sell') amount.value = formatUnits(BigInt(bal.token), 18);
                else amount.value = Math.max(0, Number(formatUnits(BigInt(bal.hype), 18)) - 0.01).toFixed(4);
                clearTimeout(timer);
                update();
            } }, 'Max'));
        } catch { balLine.textContent = 'Balance unavailable'; }
    };
    const update = async () => {
        const my = ++seq;
        lastQuote = null;
        const v = amount.value.trim();
        if (!(Number(v) > 0)) { est.textContent = '—'; return; }
        let wei;
        try { wei = parseUnits(v, 18); } catch { est.textContent = '—'; return; }
        try {
            const q = await api(`/tokens/${t.address}/quote?side=${side}&amount=${wei}`);
            if (my !== seq) return;
            lastQuote = { wei, q };
            est.textContent = side === 'buy' ? `${fmtTokens(q.tokensOut)} $${t.symbol}` : `${Number(formatUnits(BigInt(q.hypeOut), 18)).toFixed(6)} HYPE`;
        } catch (e) { if (my === seq) est.textContent = e.message; }
    };
    sideToggle.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        side = b.dataset.side;
        clearTimeout(timer);
        seq += 1;
        lastQuote = null;
        [...sideToggle.children].forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        unit.textContent = side === 'buy' ? 'HYPE' : t.symbol;
        btn.textContent = side === 'buy' ? 'Buy' : 'Sell';
        amount.value = '';
        est.textContent = '—';
        loadBal();
    });
    amount.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(update, 300);
    });
    btn.addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        trading += 1;
        btn.disabled = true;
        btn.classList.add('loading');
        err.hidden = true;
        const s = side;
        try {
            clearTimeout(timer);
            await update();
            if (!lastQuote || side !== s) { err.textContent = 'Enter an amount.'; err.hidden = false; return; }
            // The quote can be replaced while the wallet is open; trade exactly what was quoted here.
            const { wei, q } = lastQuote;
            const slip = BigInt(settings().slippageBps);
            if (s === 'buy') {
                const min = (BigInt(q.tokensOut) * (10_000n - slip)) / 10_000n;
                await sendEvmTx(cfg, { to: cfg.factory, value: wei, data: encodeFunctionData({ abi: FACTORY_ABI, functionName: 'buy', args: [t.address, min, w.evm] }) });
            } else {
                if (BigInt(bal?.allowance || 0) < wei) {
                    toast('Approve the factory to sell your tokens (one time).');
                    await sendEvmTx(cfg, { to: t.address, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [cfg.factory, maxUint256] }) });
                    bal = { ...bal, allowance: maxUint256.toString() };
                }
                const min = (BigInt(q.hypeOut) * (10_000n - slip)) / 10_000n;
                await sendEvmTx(cfg, { to: cfg.factory, data: encodeFunctionData({ abi: FACTORY_ABI, functionName: 'sell', args: [t.address, wei, min, w.evm] }) });
            }
            toast(s === 'buy' ? 'Bought.' : 'Sold.', 'ok');
            amount.value = '';
            est.textContent = '—';
            setTimeout(() => refreshOpenToken(), 3500);
            loadBal();
        } catch (e) {
            err.textContent = walletErrorMessage(e);
            err.hidden = false;
        } finally {
            busy = false;
            trading -= 1;
            btn.disabled = false;
            btn.classList.remove('loading');
        }
    });
    loadBal();
    return h('div',
        sideToggle,
        h('div.field', h('div.curve-row', h('label', 'Amount'), balLine), h('div.input-affix.right', amount, unit)),
        h('div.quote', h('div', h('span', 'You receive (est.)'), est), h('div', h('span', 'Slippage'), h('span', `${Number(settings().slippageBps) / 100}%`)), h('div', h('span', 'Wallet'), h('span', short(w.evm)))),
        err, btn);
}

export const currentToken = () => openToken;
export function clearTokenParam() {
    openToken = null;
    document.title = `${store.config?.siteName || 'HyperPump'} — Launch on Hyperliquid, pay in SOL`;
    try { history.replaceState(null, '', '/'); } catch { /* ignore */ }
}
