import { h, $, $$, toast, openModal, closeModal, wireDialogs, copyText } from './dom.js';
import { api } from './api.js';
import { short, compact, usd, hype, tinyNumber, ago } from './format.js';
import { settings, updateSettings, resetSettings, onSettings, savedOrders, DEFAULTS, PRIORITY } from './settings.js';
import { store, loadConfig, refreshPrices, onStore, explorerUrl, markComingSoon } from './store.js';
import * as w from './wallets.js';
import { wireFeed, loadFeed, rerenderFeed, openTokenModal, refreshOpenToken, clearTokenParam } from './coins.js';
import { wireLaunch, renderCost, renderPreview, renderButton, fillRecipientIfEmpty } from './launch.js';
import { startOrder, resumeOrder, statusLabel } from './orders.js';
import { isAddress } from '/vendor/libs.js';
import { initEffects, countTo } from './effects.js';

// ---------------------------------------------------------------- wallets

function connectSolana() {
    const list = $('#walletList');
    const mobile = w.isMobile();
    list.replaceChildren(...w.availableSolanaWallets().map((x) => x.provider
        ? h('button.wallet-opt', { type: 'button', onclick: async () => {
            try {
                await w.connectSolana(x.id);
                closeModal('walletModal');
                toast(`${x.name} connected.`, 'ok');
            } catch (err) {
                toast(w.walletErrorMessage(err), 'err');
            }
        } }, x.name, h('small', 'Detected'))
        : mobile && x.browse
            ? h('a.wallet-opt', { href: x.browse(location.href, location.origin) }, `Open in ${x.name}`, h('small', 'App ↗'))
            : h('a.wallet-opt', { href: x.url, target: '_blank', rel: 'noopener noreferrer' }, x.name, h('small', 'Install ↗'))));
    openModal('walletModal');
}

function renderWallets() {
    const s = w.wallets();
    const btn = $('#solWalletBtn');
    btn.replaceChildren(s.sol ? h('span.wallet-dot') : '', s.sol ? short(s.sol) : 'Connect wallet');
    btn.title = s.sol ? 'Wallet settings' : '';
    $('#solWalletInfo').textContent = s.sol || 'Not connected';
    $('#solWalletToggle').textContent = s.sol ? 'Disconnect' : 'Connect';
    $('#evmWalletInfo').textContent = s.evm || (w.hasEvmWallet() ? 'Not connected' : 'No EVM wallet detected');
    $('#evmWalletToggle').textContent = s.evm ? 'Disconnect' : 'Connect';
    $('#evmWalletToggle').disabled = !w.hasEvmWallet();
    if (s.evm) fillRecipientIfEmpty(s.evm);
    renderButton();
}

// ---------------------------------------------------------------- settings

function openSettings(pane = 'prefs') {
    syncSettingsForm();
    showPane(pane);
    openModal('settingsModal');
}

function showPane(pane) {
    $$('#settingsTabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.pane === pane)));
    $$('#settingsModal .pane').forEach((p) => (p.hidden = p.dataset.pane !== pane));
    if (pane === 'orders') renderOrderList();
}

function syncSettingsForm() {
    const s = settings();
    $$('#settingsForm .seg').forEach((seg) => $$('button', seg).forEach((b) => b.setAttribute('aria-pressed', String(String(s[seg.dataset.setting]) === b.dataset.v))));
    $('#defaultRecipient').value = s.defaultRecipient;
    $('#autoRefresh').checked = s.autoRefresh;
    $('#reduceMotion').checked = s.reduceMotion;
    const lamports = Math.ceil((60_000 * PRIORITY[s.priority]) / 1e6);
    $('#priorityHint').textContent = lamports ? `Adds up to ${(lamports / 1e9).toFixed(6)} SOL per payment to land faster when Solana is busy.` : 'No priority fee. Payments may be slow when Solana is congested.';
}

let savedTimer;
function saved() {
    $('#savedNote').textContent = 'Saved';
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => ($('#savedNote').textContent = ''), 1200);
}

function wireSettings() {
    $('#settingsBtn').addEventListener('click', () => openSettings());
    $$('#settingsTabs button').forEach((b) => b.addEventListener('click', () => showPane(b.dataset.pane)));
    $$('#settingsForm .seg').forEach((seg) => seg.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        updateSettings({ [seg.dataset.setting]: b.dataset.v });
        syncSettingsForm();
        saved();
    }));
    // Enter in the address field would submit the form and reload the page; save the value instead.
    $('#settingsForm').addEventListener('submit', (e) => {
        e.preventDefault();
        $('#defaultRecipient').blur();
    });
    $('#defaultRecipient').addEventListener('change', (e) => {
        const v = e.target.value.trim();
        if (v && !isAddress(v)) { e.target.setAttribute('aria-invalid', 'true'); return; }
        e.target.removeAttribute('aria-invalid');
        updateSettings({ defaultRecipient: v });
        if (v) fillRecipientIfEmpty(v);
        saved();
    });
    $('#autoRefresh').addEventListener('change', (e) => { updateSettings({ autoRefresh: e.target.checked }); saved(); });
    $('#reduceMotion').addEventListener('change', (e) => { updateSettings({ reduceMotion: e.target.checked }); saved(); });
    $('#resetSettings').addEventListener('click', () => { resetSettings(); syncSettingsForm(); saved(); });
    $('#solWalletToggle').addEventListener('click', () => (w.wallets().sol ? w.disconnectSolana() : connectSolana()));
    $('#evmWalletToggle').addEventListener('click', async () => {
        if (w.wallets().evm) return w.disconnectEvm();
        try { await w.connectEvm(store.config.evm); } catch (err) { toast(w.walletErrorMessage(err), 'err'); }
    });
    onSettings((s) => {
        document.documentElement.classList.toggle('reduce-motion', s.reduceMotion);
        rerenderFeed();
        renderPreview();
        renderStats();
    });
    document.documentElement.classList.toggle('reduce-motion', settings().reduceMotion);
    void DEFAULTS;
}

async function renderOrderList() {
    const list = $('#orderList');
    const saved = savedOrders();
    if (!saved.length) {
        list.replaceChildren(h('li', h('p.hint', 'No orders from this browser yet.')));
        return;
    }
    list.replaceChildren(...saved.map((o) => {
        const status = h('span.mono', '…');
        api(`/orders/${o.id}`).then((r) => (status.textContent = statusLabel(r.status))).catch(() => (status.textContent = 'Unknown'));
        return h('li', h('button', { type: 'button', onclick: () => { closeModal('settingsModal'); resumeOrder(o.id, orderUi()); } },
            h('span', `${o.kind === 'launch' ? 'Launch' : 'Buy'} ${o.label ? `$${o.label}` : ''}`, h('br'), h('small.mono', { style: { color: 'var(--faint)' } }, ago(o.createdAt))),
            status));
    }));
}

// ---------------------------------------------------------------- terms

function openDoc(name) {
    $('#docBody').replaceChildren($(`#doc-${name}`).content.cloneNode(true));
    openModal('docModal');
}

function ensureTerms() {
    try { if (localStorage.getItem('hp.terms') === '1') return Promise.resolve(true); } catch { /* ask every time */ }
    return new Promise((resolve) => {
        const agree = h('button.btn.btn-primary', { type: 'button' }, 'I agree');
        const cancel = h('button.btn.btn-ghost', { type: 'button' }, 'Cancel');
        const box = h('label.toggle', { style: { marginTop: '18px' } }, h('input', { type: 'checkbox' }), h('span', 'I understand memecoins are high risk and I may lose everything I spend.'));
        agree.disabled = true;
        box.querySelector('input').addEventListener('change', (e) => (agree.disabled = !e.target.checked));
        $('#docBody').replaceChildren($('#doc-terms').content.cloneNode(true), $('#doc-risks').content.cloneNode(true), box, h('div.actions', cancel, agree));
        const d = openModal('docModal');
        const done = (ok) => {
            d.removeEventListener('close', onClose);
            if (ok) try { localStorage.setItem('hp.terms', '1'); } catch { /* ignore */ }
            d.close();
            resolve(ok);
        };
        const onClose = () => resolve(false);
        d.addEventListener('close', onClose, { once: true });
        agree.addEventListener('click', () => done(true));
        cancel.addEventListener('click', () => done(false));
    });
}

// ---------------------------------------------------------------- market chrome

async function renderTicker() {
    let items = [];
    const track = $('#ticker');
    try {
        items = await api('/activity');
    } catch (err) {
        if (err.status !== 404) return;
        markComingSoon();
        track.replaceChildren(h('span.ticker-empty', 'Live trades scroll here once trading opens.'));
        track.style.animation = 'none';
        return;
    }
    if (!items.length) {
        track.replaceChildren(h('span.ticker-empty', 'No trades yet. Launch the first coin.'));
        track.style.animation = 'none';
        return;
    }
    const row = items.map((t) => h('button.ticker-item', { type: 'button', onclick: () => openTokenModal(t.token) },
        t.image ? h('img', { src: t.image, alt: '' }) : h('span.ava', { style: { fontSize: '11px' } }, t.symbol[0]),
        h(t.isBuy ? 'span.up' : 'span.down', t.isBuy ? 'BUY' : 'SELL'),
        h('b', `$${t.symbol}`),
        `${t.hype.toLocaleString(undefined, { maximumFractionDigits: 3 })} HYPE`,
        h('span', ago(t.timestamp))));
    // Two copies make the marquee loop seamlessly.
    track.replaceChildren(...row, ...row.map((n) => { const c = n.cloneNode(true); c.setAttribute('aria-hidden', 'true'); c.tabIndex = -1; return c; }));
    $$('.ticker-item[aria-hidden]', track).forEach((n, i) => n.addEventListener('click', () => openTokenModal(items[i % items.length].token)));
    track.style.animation = '';
    track.style.animationDuration = `${Math.max(30, items.length * 4)}s`;
}

let stats = null;
async function loadStats() {
    try { stats = await api('/stats'); } catch { /* ignore */ }
    renderStats();
}

function renderStats() {
    const el = (k) => $(`[data-stat="${k}"]`);
    if (store.comingSoon && !stats) {
        ['tokens', 'volume24h', 'graduated', 'rate'].forEach((k) => { if (!el(k).dataset.n) el(k).textContent = 'Soon'; });
        return;
    }
    if (stats) {
        countTo(el('tokens'), stats.tokens, (n) => compact(Math.round(n), 1));
        countTo(el('graduated'), stats.graduated, (n) => compact(Math.round(n), 1));
        const inUsd = settings().currency === 'usd' && store.prices;
        countTo(el('volume24h'), inUsd ? stats.volume24hHype * store.prices.hypeUsd : stats.volume24hHype, (n) => (inUsd ? usd(n) : hype(n)));
    }
    if (store.prices) countTo(el('rate'), store.prices.solHype, (n) => `${tinyNumber(n)} HYPE`);
}

function renderComingSoon() {
    const banner = $('#banner');
    banner.hidden = false;
    banner.className = 'banner info';
    banner.textContent = "We're launching soon. Look around and preview your coin; launching and trading open shortly.";
    $('.announce-tag').textContent = 'Soon';
    $('#netPill').textContent = 'Launching soon';
    rerenderFeed();
    renderButton();
}

function renderChrome() {
    if (store.comingSoon && !store.config) return renderComingSoon();
    const c = store.config;
    if (!c) return;
    $$('[data-site-name]').forEach((el) => (el.textContent = c.siteName));
    document.title = `${c.siteName} — Launch on Hyperliquid, pay in SOL`;
    $('#netPill').textContent = 'Solana → HyperEVM';
    const banner = $('#banner');
    if (!c.ready) {
        banner.hidden = false;
        banner.className = 'banner error';
        banner.textContent = 'Launching and buying are paused for a moment. Browsing and HyperEVM wallet trading still work.';
    } else {
        banner.hidden = true;
    }
    if (c.curve) {
        $('#factFee').textContent = `${c.curve.tradeFeeBps / 100}%`;
        $('#factCreator').textContent = `${c.curve.creatorFeeBps / 100}%`;
    }
    const factory = explorerUrl('address', c.evm.factory);
    const fl = $('#factoryLink');
    if (factory) fl.href = factory;
    else { fl.removeAttribute('href'); fl.addEventListener('click', (e) => { e.preventDefault(); copyText(c.evm.factory, 'Factory address copied'); }); }
}

const orderUi = () => ({
    onOpenToken: (addr) => openTokenModal(addr),
    onComplete: () => { loadFeed({ quiet: true }); loadStats(); renderTicker(); },
});

// ---------------------------------------------------------------- boot

async function boot() {
    initEffects();
    wireDialogs();
    wireSettings();
    $$('[data-open]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); openDoc(a.dataset.open); }));
    $('#solWalletBtn').addEventListener('click', () => (w.wallets().sol ? openSettings('wallets') : connectSolana()));
    $('#tokenModal').addEventListener('close', clearTokenParam);

    w.onWallets(renderWallets);
    onStore(() => {
        renderChrome(); renderCost(); renderPreview(); renderStats();
        if (store.config) $$('[data-spread]').forEach((el) => (el.textContent = `${store.config.fees.conversionSpreadBps / 100}%`));
    });

    const startOrderWithUi = (order, ui = {}) => {
        const base = orderUi();
        startOrder(order, { ...base, ...ui, onComplete: (o) => { base.onComplete(o); ui.onComplete?.(o); } });
    };
    wireLaunch({ connectSolana, ensureTerms, startOrder: startOrderWithUi });
    wireFeed({ connectSolana, startOrder: startOrderWithUi });
    renderWallets();

    // Nothing waits on anything else: a slow endpoint only delays its own part of the page.
    const deep = location.pathname.match(/^\/coin\/(0x[0-9a-fA-F]{40})$/)?.[1] || new URLSearchParams(location.search).get('token');
    loadConfig().then(() => {
        if (deep && isAddress(deep)) openTokenModal(deep);
    }).catch((err) => {
        if (err.status === 404) return; // not deployed yet: renderComingSoon() handles the page
        $('#banner').hidden = false;
        $('#banner').className = 'banner error';
        $('#banner').textContent = `Could not reach the server: ${err.message}`;
    });
    refreshPrices();
    loadFeed();
    loadStats();
    renderTicker();
    w.eagerConnect();

    setInterval(() => {
        if (document.hidden || !settings().autoRefresh || store.comingSoon) return;
        refreshPrices();
        loadFeed({ quiet: true });
        loadStats();
        refreshOpenToken();
    }, 15_000);
    setInterval(() => { if (!document.hidden && settings().autoRefresh && !store.comingSoon) renderTicker(); }, 30_000);
    // While launching soon, check once a minute and switch on when the backend answers.
    setInterval(async () => {
        if (!store.comingSoon || document.hidden) return;
        try {
            await api('/config');
            location.reload();
        } catch { /* still not deployed */ }
    }, 60_000);
}

boot();
