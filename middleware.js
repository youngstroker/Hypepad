// Vercel Routing Middleware. Vercel serves the static site (public/) from its
// CDN; everything dynamic is forwarded to the backend server (the Node app in
// server/, run with Docker on a host that allows long-running processes).
// Set BACKEND_URL in the Vercel project, e.g. https://api.example.com
// Without it, the static site is served on its own (pages load, actions fail).
import { rewrite, next, ipAddress } from '@vercel/functions';

export const config = {
    matcher: ['/', '/coin/:path*', '/api/:path*', '/uploads/:path*', '/robots.txt', '/sitemap.xml'],
};

export default function middleware(request) {
    const backend = process.env.BACKEND_URL;
    if (!backend) return next();
    const url = new URL(request.url);
    // Pass the visitor's IP with a shared secret, so the backend can rate-limit
    // per visitor without trusting forwarded-for headers anyone could forge.
    const headers = new Headers(request.headers);
    headers.delete('x-hp-proxy');
    headers.delete('x-hp-client-ip');
    if (process.env.PROXY_SECRET) {
        headers.set('x-hp-proxy', process.env.PROXY_SECRET);
        headers.set('x-hp-client-ip', ipAddress(request) || '');
    }
    return rewrite(new URL(url.pathname + url.search, backend), { request: { headers } });
}
