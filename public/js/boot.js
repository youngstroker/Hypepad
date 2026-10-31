// Runs before first paint (classic, blocking script in <head>): marks that JS
// is on so scroll-reveal can hide sections without a flash. If the app's
// modules never load, everything is shown anyway after a moment.
(function () {
    var root = document.documentElement;
    if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (!('IntersectionObserver' in window)) return;
    root.classList.add('js');
    setTimeout(function () {
        if (window.__effects) return;
        document.querySelectorAll('[data-reveal]').forEach(function (el) { el.classList.add('in'); });
    }, 2500);
})();
