import path from 'node:path';
import express from 'express';
import { config, validateConfig, isMainnet } from './config.js';
import { api } from './routes.js';
import * as orders from './orders.js';
import { runIndexer, runMigrations } from './indexer.js';
import { getPrices } from './prices.js';
import { log } from './log.js';
import { homePage, coinPage, sitemap, robots } from './seo.js';
import { sweep as sweepUploads } from './uploads.js';
import { genesisHash } from './solana.js';
import { publicClient } from './hyperevm.js';
import * as evm from './hyperevm.js';

for (const problem of validateConfig()) log.warn('config', { problem });
if (config.evm.chainId === 999 && evm.relayer && evm.sharedKey) {
    // migrate() needs ~3.7M gas (> a 3M small block); the relayer must stay on small blocks.
    log.error('config', { problem: 'MIGRATOR_PRIVATE_KEY must be a separate key (on big blocks) on mainnet.' });
    process.exit(1);
}

const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', config.trustProxy);

app.use((req, res, next) => {
    res.set({
        'content-security-policy': [
            "default-src 'self'",
            "img-src 'self' data: blob:",
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
            "font-src 'self' https://fonts.gstatic.com",
            "script-src 'self'",
            "connect-src 'self'",
            "frame-ancestors 'none'",
            "base-uri 'none'",
            "form-action 'self'",
            "object-src 'none'",
        ].join('; '),
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'strict-origin-when-cross-origin',
        'permissions-policy': 'camera=(), microphone=(), geolocation=()',
        'cross-origin-opener-policy': 'same-origin',
    });
    if (isMainnet) res.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
    next();
});

app.use('/api', api);
app.use('/uploads/pending', (req, res) => res.status(404).end());
app.use('/uploads', express.static(path.join(config.dataDir, 'uploads'), { maxAge: '365d', immutable: true, index: false, dotfiles: 'deny' }));
// Images not yet tied to a paid launch (shown in the quote), briefly cacheable.
app.use('/uploads', express.static(path.join(config.dataDir, 'uploads', 'pending'), { maxAge: '5m', index: false, dotfiles: 'deny' }));
// Revalidate app files on every load (cheap with ETags) so a deploy never mixes old and new modules.
const html = (res, body, status = 200) => res.status(status).set({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }).send(body);
app.get('/', (req, res) => html(res, homePage()));
app.get('/coin/:address', (req, res) => {
    const page = /^0x[0-9a-fA-F]{40}$/.test(req.params.address) ? coinPage(req.params.address) : null;
    html(res, page || homePage(), page ? 200 : 404);
});
app.get('/robots.txt', (req, res) => res.type('text/plain').send(robots()));
app.get('/sitemap.xml', (req, res) => res.type('application/xml').set('cache-control', 'public, max-age=600').send(sitemap()));
app.use(express.static(path.join(config.root, 'public'), { index: false, maxAge: 0, setHeaders: (res) => res.set('cache-control', 'no-cache') }));
app.use((req, res) => html(res, homePage(), 404));

// ---------------------------------------------------------------- background jobs

const timers = [];
const running = new Set();
let stopping = false;

function every(name, ms, fn) {
    let busy = false;
    const tick = async () => {
        if (busy || stopping) return;
        busy = true;
        const job = (async () => {
            try {
                await fn();
            } catch (err) {
                log.error(`${name}.error`, { err: err.shortMessage || err.message });
            }
        })();
        running.add(job);
        await job;
        running.delete(job);
        busy = false;
    };
    timers.push(setTimeout(tick, 500), setInterval(tick, ms));
}

// Money-moving jobs start only after both RPCs prove they are on the
// configured networks, so a wrong URL can never credit test SOL or send real HYPE.
class WrongNetworkError extends Error {}
const GENESIS = { 'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d', devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' };
async function verifyNetworks() {
    for (;;) {
        try {
            const [genesis, chainId] = await Promise.all([genesisHash(), publicClient.getChainId()]);
            if (genesis !== GENESIS[config.solana.cluster]) throw new WrongNetworkError(`SOLANA_RPC_URL is not ${config.solana.cluster} (genesis ${genesis})`);
            if (chainId !== config.evm.chainId) throw new WrongNetworkError(`HYPEREVM_RPC_URL is chain ${chainId}, expected ${config.evm.chainId}`);
            return;
        } catch (err) {
            if (err instanceof WrongNetworkError) {
                log.error('startup.wrong_network', { err: err.message });
                process.exit(1);
            }
            log.error('startup.rpc_unreachable', { err: err.message });
            await new Promise((r) => setTimeout(r, 5000));
        }
    }
}

every('prices', 15_000, () => getPrices());
every('uploads', 10 * 60_000, () => sweepUploads());
if (process.env.NO_JOBS !== '1') {
    verifyNetworks().then(() => {
        log.info('startup.networks_ok', { solana: config.solana.cluster, hyperevm: config.evm.chainId });
        every('treasury', config.solana.pollMs, () => orders.pollTreasury());
        every('executor', 2_000, () => orders.runExecutor());
        every('refunds', 10_000, () => orders.runRefunds());
        every('indexer', config.evm.pollMs, () => runIndexer());
        every('migrations', 30_000, () => runMigrations());
        every('expire', 60_000, () => orders.expireStale());
    });
}

const server = app.listen(config.port, config.host, () => {
    log.info('server.started', {
        url: config.publicUrl,
        solana: config.solana.cluster,
        hyperevm: config.evm.chainId,
        factory: config.evm.factory || null,
    });
});

// On deploy/restart: stop taking new work, let in-flight jobs (a relayer
// transaction being confirmed, a refund) finish, then exit. Anything cut off
// is picked up safely on the next start because transactions are saved
// before they are broadcast.
async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    log.info('server.stopping', { signal, inFlight: running.size });
    timers.forEach((t) => clearInterval(t));
    server.close();
    await Promise.race([Promise.allSettled([...running]), new Promise((r) => setTimeout(r, 25_000))]);
    process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
