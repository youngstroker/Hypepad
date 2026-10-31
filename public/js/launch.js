import { $, $$, toast } from './dom.js';
import { api } from './api.js';
import { compact, tinyNumber } from './format.js';
import { settings } from './settings.js';
import { store, solToHype } from './store.js';
import { wallets, connectEvm, walletErrorMessage } from './wallets.js';
import { coinCard } from './coins.js';
import { isAddress } from '/vendor/libs.js';

const ALLOWED = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const form = {};
let image = { path: null, url: null, uploading: false };
let hooks = {};

const val = (id) => $(`#${id}`).value.trim();

/** Tokens out for a first buy on a fresh curve (float estimate of the contract math). */
function launchTokens(hypeGross) {
    const c = store.config?.curve;
    if (!c || !(hypeGross > 0)) return 0;
    const vH = Number(c.virtualHype) / 1e18;
    const vT = Number(c.virtualToken) / 1e18;
    const cap = Number(c.curveSupply) / 1e18;
    const hin = hypeGross * (1 - c.tradeFeeBps / 10_000);
    return Math.min(cap, vT - (vH * vT) / (vH + hin));
}

function launchPriceHype() {
    const c = store.config?.curve;
    return c ? Number(c.virtualHype) / Number(c.virtualToken) : 0;
}

export function renderPreview() {
    const priceHype = launchPriceHype();
    const t = {
        name: val('name') || 'Your coin',
        symbol: (val('symbol') || 'TICKER').toUpperCase().replace(/^\$/, ''),
        description: val('description') || 'Your description shows here.',
        image: image.url,
        priceHype,
        priceUsd: priceHype * (store.prices?.hypeUsd || 0),
        marketCapHype: priceHype * 1e9,
        marketCapUsd: priceHype * 1e9 * (store.prices?.hypeUsd || 0),
        progress: 0,
        change24h: null,
        createdAt: null,
    };
    $('#previewCard').replaceWith(Object.assign(coinCard(t, { interactive: false }), { id: 'previewCard' }));
}

export function renderCost() {
    const cfg = store.config;
    if (!cfg) return;
    const fee = cfg.fees.launchFeeSol;
    const buy = Number($('#initialBuy').value) || 0;
    const fmt = (n) => `${n.toLocaleString(undefined, { maximumFractionDigits: 4 })} SOL`;
    $('#costFee').textContent = fmt(fee);
    $('#costBuy').textContent = buy > 0 ? fmt(buy) : 'None';
    $('#costTotal').textContent = fmt(fee + buy);
    const hypeIn = solToHype(buy);
    const toks = launchTokens(hypeIn);
    const sym = (val('symbol') || 'TICKER').toUpperCase().replace(/^\$/, '');
    $('#costTokens').textContent = buy > 0 && toks ? `~${compact(toks)} $${sym} (${((toks / 1e9) * 100).toFixed(2)}%)` : '—';
    $('#costRate').textContent = store.prices ? `1 SOL ≈ ${tinyNumber(solToHype(1))} HYPE` : '—';
    $$('#buyChips button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.v) === buy)));
    renderButton();
}

export function renderButton() {
    const btn = $('#launchBtn');
    const cfg = store.config;
    if (!cfg) { btn.disabled = true; btn.textContent = 'Loading…'; return; }
    if (!cfg.ready) { btn.disabled = true; btn.textContent = 'Launching is temporarily unavailable'; return; }
    btn.disabled = image.uploading;
    if (!wallets().sol) { btn.textContent = 'Connect wallet to launch'; return; }
    const total = cfg.fees.launchFeeSol + (Number($('#initialBuy').value) || 0);
    btn.textContent = image.uploading ? 'Uploading image…' : `Launch for ${total.toLocaleString(undefined, { maximumFractionDigits: 4 })} SOL`;
}

function setUploadState(text, err = false) {
    const el = $('#uploadState');
    el.hidden = !text;
    el.textContent = text || '';
    el.classList.toggle('err', err);
}

async function handleFile(file) {
    if (!file) return;
    const max = store.config?.limits.maxUploadBytes || 2 * 1024 * 1024;
    if (!ALLOWED.includes(file.type)) return setUploadState('Use PNG, JPG, GIF or WEBP', true);
    if (file.size > max) return setUploadState(`Max ${(max / 1024 / 1024).toFixed(0)} MB`, true);
    if (image.url?.startsWith('blob:')) URL.revokeObjectURL(image.url);
    const mine = image = { path: null, url: URL.createObjectURL(file), uploading: true };
    $('#uploadPreview').src = image.url;
    $('#uploadPreview').hidden = false;
    $('#uploadEmpty').hidden = true;
    setUploadState('Uploading…');
    renderPreview();
    renderButton();
    // A newer pick (or a form reset) replaces `image`; this upload must not touch it then.
    try {
        const res = await api('/upload', { method: 'POST', raw: file });
        if (image !== mine) return;
        mine.path = res.image;
        setUploadState('✓ Uploaded');
        setTimeout(() => image === mine && mine.path && setUploadState(''), 1500);
    } catch (err) {
        if (image !== mine) return;
        mine.path = null;
        setUploadState(err.message.length > 34 ? 'Upload failed' : err.message, true);
        toast(err.message, 'err');
    } finally {
        mine.uploading = false;
        if (image === mine) renderButton();
    }
}

function showError(msg, fieldId) {
    const el = $('#formError');
    el.textContent = msg;
    el.hidden = !msg;
    $$('#launchForm [aria-invalid]').forEach((x) => x.removeAttribute('aria-invalid'));
    if (fieldId) {
        const f = $(`#${fieldId}`);
        f.setAttribute('aria-invalid', 'true');
        f.focus();
    }
}

function validate() {
    if (!image.path) return ['Add an image for your coin.', 'imageInput'];
    if (!val('name')) return ['Give your coin a name.', 'name'];
    const sym = val('symbol').replace(/^\$/, '');
    if (!/^[A-Za-z0-9]{1,10}$/.test(sym)) return ['Ticker: letters and digits only, up to 10.', 'symbol'];
    if (!isAddress(val('recipient'))) return ['Enter your HyperEVM address (0x…). Your coins and creator fees go there.', 'recipient'];
    const buy = Number($('#initialBuy').value) || 0;
    const { minBuySol, maxOrderSol } = store.config.limits;
    if (buy && (buy < minBuySol || buy > maxOrderSol)) return [`Initial buy must be between ${minBuySol} and ${maxOrderSol} SOL, or none.`, 'initialBuy'];
    return null;
}

async function submit(e) {
    e.preventDefault();
    showError('');
    if (!wallets().sol) return hooks.connectSolana();
    const problem = validate();
    if (problem) return showError(...problem);
    if (!(await hooks.ensureTerms())) return;
    const btn = $('#launchBtn');
    btn.classList.add('loading');
    btn.disabled = true;
    try {
        const order = await api('/orders/launch', {
            method: 'POST',
            body: {
                name: val('name'), symbol: val('symbol'), description: $('#description').value, image: image.path,
                twitter: val('twitter'), telegram: val('telegram'), website: val('website'),
                recipient: val('recipient'), initialBuySol: Number($('#initialBuy').value) || 0,
                slippageBps: Number(settings().slippageBps),
            },
        });
        hooks.startOrder(order, { onComplete: () => resetForm() });
    } catch (err) {
        showError(err.message);
    } finally {
        btn.classList.remove('loading');
        renderButton();
    }
}

function resetForm() {
    $('#launchForm').reset();
    image = { path: null, url: null, uploading: false };
    $('#uploadPreview').hidden = true;
    $('#uploadEmpty').hidden = false;
    $('#recipient').value = settings().defaultRecipient || wallets().evm || '';
    $('#descCount').textContent = '0 / 500';
    renderPreview();
    renderCost();
}

export function wireLaunch(opts) {
    hooks = opts;
    const box = $('#uploadBox');
    $('#imageInput').addEventListener('change', (e) => handleFile(e.target.files?.[0]));
    box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('drag'); });
    box.addEventListener('dragleave', () => box.classList.remove('drag'));
    box.addEventListener('drop', (e) => { e.preventDefault(); box.classList.remove('drag'); handleFile(e.dataTransfer.files?.[0]); });

    for (const id of ['name', 'symbol', 'description']) $(`#${id}`).addEventListener('input', () => { renderPreview(); renderCost(); });
    $('#symbol').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9$]/g, ''); });
    $('#description').addEventListener('input', (e) => { $('#descCount').textContent = `${[...e.target.value].length} / 500`; });
    $('#initialBuy').addEventListener('input', renderCost);
    $$('#buyChips button').forEach((b) => b.addEventListener('click', () => { $('#initialBuy').value = b.dataset.v === '0' ? '' : b.dataset.v; renderCost(); }));
    $('#recipient').value = settings().defaultRecipient || '';
    $('#useEvmBtn').addEventListener('click', async () => {
        try {
            $('#recipient').value = await connectEvm(store.config.evm);
            $('#recipient').removeAttribute('aria-invalid');
        } catch (err) {
            toast(walletErrorMessage(err), 'err');
        }
    });
    $('#launchForm').addEventListener('submit', submit);
    $('#launchForm').addEventListener('input', (e) => e.target.removeAttribute?.('aria-invalid'));
    renderPreview();
}

export function fillRecipientIfEmpty(addr) {
    if (addr && !val('recipient')) $('#recipient').value = addr;
}

