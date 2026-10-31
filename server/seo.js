// Server-side <head> tags, so shared links unfurl with a title and image on
// X, Telegram and Discord (their crawlers do not run JavaScript).
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { db } from './db.js';
import { lastPrices } from './prices.js';

const template = fs.readFileSync(path.join(config.root, 'public/index.html'), 'utf8');
const MARK = '<!--SEO: the server fills in title, description, canonical and social tags-->';
if (!template.includes(MARK)) throw new Error('public/index.html is missing the SEO marker');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const abs = (p) => (/^https?:\/\//.test(p) ? p : `${config.publicUrl}${p}`);

function head({ title, description, url, image, imageAlt, large = true }) {
    return [
        `<title>${esc(title)}</title>`,
        `<meta name="description" content="${esc(description)}">`,
        `<link rel="canonical" href="${esc(url)}">`,
        `<meta property="og:type" content="website">`,
        `<meta property="og:site_name" content="${esc(config.siteName)}">`,
        `<meta property="og:title" content="${esc(title)}">`,
        `<meta property="og:description" content="${esc(description)}">`,
        `<meta property="og:url" content="${esc(url)}">`,
        `<meta property="og:image" content="${esc(abs(image))}">`,
        `<meta property="og:image:alt" content="${esc(imageAlt)}">`,
        `<meta name="twitter:card" content="${large ? 'summary_large_image' : 'summary'}">`,
        `<meta name="twitter:title" content="${esc(title)}">`,
        `<meta name="twitter:description" content="${esc(description)}">`,
        `<meta name="twitter:image" content="${esc(abs(image))}">`,
    ].join('\n    ');
}

const render = (tags) => template.replace(MARK, () => tags); // a function, so `$&` etc. in coin names stay literal

const home = render(head({
    title: `${config.siteName} — Launch on Hyperliquid, pay in SOL`,
    description: "Launch a memecoin on Hyperliquid's HyperEVM in one step and pay with SOL. Fair-launch bonding curve, liquidity locked on graduation.",
    url: `${config.publicUrl}/`,
    image: '/assets/og.png',
    imageAlt: `${config.siteName}: launch on Hyperliquid, pay in SOL`,
}));

export const homePage = () => home;

const compactUsd = (n) => (n > 0 ? `$${Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(n)}` : null);

/** Page for /coin/:address, with that coin's name and image in the share card. */
export function coinPage(address) {
    const t = db.prepare('SELECT address, name, symbol, description, image, price_hype, total_supply FROM tokens WHERE LOWER(address) = LOWER(?) AND hidden = 0').get(address);
    if (!t) return null;
    const mcap = compactUsd(t.price_hype * (Number(t.total_supply) / 1e18) * (lastPrices()?.hypeUsd || 0));
    const desc = [t.description, mcap && `Market cap ${mcap}.`, `Trade $${t.symbol} on ${config.siteName}.`].filter(Boolean).join(' ').slice(0, 280);
    return render(head({
        title: `${t.name} ($${t.symbol}) · ${config.siteName}`,
        description: desc,
        url: `${config.publicUrl}/coin/${t.address}`,
        image: t.image || '/assets/og.png',
        imageAlt: `${t.name} ($${t.symbol})`,
        large: !t.image,
    }));
}

export function sitemap() {
    const rows = db.prepare('SELECT address, COALESCE(last_trade_at, created_at) AS t FROM tokens WHERE hidden = 0 ORDER BY created_at DESC LIMIT 20000').all();
    const urls = [`<url><loc>${esc(config.publicUrl)}/</loc><changefreq>hourly</changefreq></url>`,
        ...rows.map((r) => `<url><loc>${esc(config.publicUrl)}/coin/${r.address}</loc><lastmod>${new Date(r.t * 1000).toISOString()}</lastmod></url>`)];
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

export const robots = () => `User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${config.publicUrl}/sitemap.xml\n`;
