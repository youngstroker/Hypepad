// Vercel Routing Middleware. Vercel serves the static site (public/) from its
// CDN; everything dynamic is forwarded to the backend server (the Node app in
// server/, run with Docker on a host that allows long-running processes).
// Set BACKEND_URL in the Vercel project, e.g. https://api.example.com
// Without it, the static site is served on its own (pages load, actions fail).
import { rewrite, next } from '@vercel/functions';

export const config = {
    matcher: ['/', '/coin/:path*', '/api/:path*', '/uploads/:path*', '/robots.txt', '/sitemap.xml'],
};

export default function middleware(request) {
    const backend = process.env.BACKEND_URL;
    if (!backend) return next();
    const url = new URL(request.url);
    return rewrite(new URL(url.pathname + url.search, backend));
}
