// Tiny DOM helpers. All user-supplied text goes through textContent or
// attributes, never innerHTML.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** h('div#id.cls', { attr }, ...children). Strings become text nodes. */
export function h(tag, attrs = {}, ...children) {
    const [head, ...classes] = tag.split('.');
    const [name, id] = head.split('#');
    const el = document.createElement(name || 'div');
    if (id) el.id = id;
    if (classes.length) el.className = classes.join(' ');
    if (attrs === null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs)) {
        children.unshift(attrs);
        attrs = {};
    }
    for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') el.className += ` ${v}`;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else el.setAttribute(k, v === true ? '' : String(v));
    }
    append(el, children);
    return el;
}

function append(el, children) {
    for (const c of children.flat(Infinity)) {
        if (c === null || c === undefined || c === false) continue;
        el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
}

export function toast(message, kind = '') {
    const t = h(`div.toast${kind ? `.${kind}` : ''}`, { role: kind === 'err' ? 'alert' : 'status' }, message);
    $('#toasts').append(t);
    setTimeout(() => t.remove(), kind === 'err' ? 7000 : 4000);
}

export async function copyText(text, label = 'Copied') {
    try {
        await navigator.clipboard.writeText(text);
        toast(label, 'ok');
    } catch {
        toast('Copy failed. Select the text and copy it manually.', 'err');
    }
}

/** Coin image, or a lettered placeholder when there is none or it fails to load. */
export function coinImage(token, cls = '') {
    const wrap = h(`div.coin-img-wrap${cls ? `.${cls}` : ''}`);
    const fallback = () => wrap.replaceChildren(h('div.ava', { 'aria-hidden': 'true' }, (token.symbol || token.name || '?')[0].toUpperCase()));
    if (token.image) {
        const img = h('img.coin-img', { src: token.image, alt: '', loading: 'lazy', decoding: 'async' });
        img.addEventListener('error', fallback, { once: true });
        wrap.append(img);
    } else {
        fallback();
    }
    return wrap;
}

export function openModal(id) {
    const d = document.getElementById(id);
    if (!d.open) d.showModal();
    return d;
}

export function closeModal(id) {
    const d = document.getElementById(id);
    if (d.open) d.close();
}

// Close buttons and backdrop clicks for every dialog.
export function wireDialogs() {
    for (const d of $$('dialog')) {
        d.addEventListener('click', (e) => {
            if (e.target.closest('[data-close]')) return d.close();
            if (e.target !== d) return;
            // A click on the dialog's own padding also targets it; only the backdrop is outside its box.
            const r = d.getBoundingClientRect();
            if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close();
        });
    }
}
