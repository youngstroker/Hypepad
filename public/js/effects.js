// Visual polish only: nothing here is needed for the app to work.
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.classList.contains('reduce-motion');

/** Cards light up under the pointer (CSS reads --mx/--my). */
function spotlight() {
    document.addEventListener('pointermove', (e) => {
        const el = e.target.closest?.('.spot, button.coin-card');
        if (!el) return;
        const r = el.getBoundingClientRect();
        el.style.setProperty('--mx', `${e.clientX - r.left}px`);
        el.style.setProperty('--my', `${e.clientY - r.top}px`);
    }, { passive: true });
}

/**
 * Sections fade up as they scroll in. boot.js already hid them before first
 * paint; the observer's first callback reports the ones already on screen.
 */
function reveal() {
    const items = [...document.querySelectorAll('[data-reveal]')];
    if (!document.documentElement.classList.contains('js')) return;
    if (reduced()) {
        items.forEach((el) => el.classList.add('in'));
        return;
    }
    let batch = 0;
    const io = new IntersectionObserver((entries) => {
        batch = 0;
        for (const en of entries) {
            if (!en.isIntersecting) continue;
            en.target.style.transitionDelay = `${Math.min(batch++, 5) * 70}ms`;
            en.target.classList.add('in');
            io.unobserve(en.target);
        }
    }, { rootMargin: '0px 0px -6% 0px' });
    items.forEach((el) => io.observe(el));
    // Background tabs may not run observer callbacks until shown; never leave
    // on-screen content hidden waiting for one.
    setTimeout(() => items.forEach((el) => {
        const r = el.getBoundingClientRect();
        if (!el.classList.contains('in') && r.top < innerHeight && r.bottom > 0) el.classList.add('in');
    }), 1200);
}

/** Animates a number from its last shown value to `value`, rendered with `format`. */
export function countTo(el, value, format) {
    if (!el || !Number.isFinite(value)) return;
    const from = Number(el.dataset.n ?? 0);
    el.dataset.n = String(value);
    if (reduced() || from === value || document.hidden) {
        el.textContent = format(value);
        return;
    }
    const start = performance.now();
    const dur = 900;
    const step = (t) => {
        const k = Math.min(1, (t - start) / dur);
        const eased = 1 - (1 - k) ** 3;
        el.textContent = format(from + (value - from) * eased);
        if (k < 1 && el.dataset.n === String(value)) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
}

function shortcuts() {
    document.addEventListener('keydown', (e) => {
        if (e.key !== '/' || e.metaKey || e.ctrlKey || /input|textarea|select/i.test(document.activeElement?.tagName || '')) return;
        if (document.querySelector('dialog[open]')) return;
        e.preventDefault();
        document.getElementById('search')?.focus();
    });
}

export function initEffects() {
    window.__effects = true;
    spotlight();
    reveal();
    shortcuts();
}
