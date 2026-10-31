// Coin images. New uploads land in uploads/pending/ and only move to uploads/
// (where they are served) once a launch order uses them; unused ones are
// swept after an hour. A site-wide hourly budget and a free-disk floor keep
// uploads from ever filling the volume the database lives on.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { log } from './log.js';

const LIVE = path.join(config.dataDir, 'uploads');
const PENDING = path.join(LIVE, 'pending');
const NAME = /^\/uploads\/([a-f0-9]{64}\.(png|jpg|gif|webp))$/;
const PENDING_TTL_MS = 60 * 60 * 1000;
const HOURLY_BUDGET = Number(process.env.UPLOADS_PER_HOUR || 2000);
const PER_CLIENT_HOURLY = 30;
const MIN_FREE_BYTES = Number(process.env.MIN_FREE_DISK_MB || 1024) * 1024 * 1024;

fs.mkdirSync(PENDING, { recursive: true });

let windowStart = Date.now();
let windowCount = 0;
const perClient = new Map();

export class UploadRefused extends Error {}

/** Stores an image (already type-checked) and returns its public path. */
export function save(buf, ext, client = '') {
    if (Date.now() - windowStart > 3_600_000) {
        windowStart = Date.now();
        windowCount = 0;
        perClient.clear();
    }
    // Per visitor first, so a few clients cannot use up the site-wide budget.
    const mine = (perClient.get(client) || 0) + 1;
    if (mine > PER_CLIENT_HOURLY) throw new UploadRefused('You have uploaded a lot of images this hour. Try again later.');
    if (windowCount + 1 > HOURLY_BUDGET) throw new UploadRefused('Uploads are busy right now. Try again in a few minutes.');
    if (perClient.size < 100_000) perClient.set(client, mine);
    windowCount++;
    try {
        const { bavail, bsize } = fs.statfsSync(config.dataDir);
        if (bavail * bsize < MIN_FREE_BYTES) {
            log.error('uploads.disk_low', { freeMb: Math.round((bavail * bsize) / 1048576) });
            throw new UploadRefused('Uploads are temporarily unavailable.');
        }
    } catch (err) {
        if (err instanceof UploadRefused) throw err;
    }
    const name = `${crypto.createHash('sha256').update(buf).digest('hex')}.${ext}`;
    if (!fs.existsSync(path.join(LIVE, name))) fs.writeFileSync(path.join(PENDING, name), buf);
    return `/uploads/${name}`;
}

export function exists(publicPath) {
    const m = NAME.exec(publicPath || '');
    return Boolean(m && (fs.existsSync(path.join(LIVE, m[1])) || fs.existsSync(path.join(PENDING, m[1]))));
}

/** Restarts a pending image's one-hour clock (when a quote is created for it). */
export function touch(publicPath) {
    const m = NAME.exec(publicPath || '');
    const p = m && path.join(PENDING, m[1]);
    if (p && fs.existsSync(p)) {
        const t = new Date();
        fs.utimesSync(p, t, t);
    }
}

/** Makes an image permanent once a launch is paid. Returns false if it is gone. */
export function keep(publicPath) {
    const m = NAME.exec(publicPath || '');
    if (!m) return false;
    const live = path.join(LIVE, m[1]);
    const from = path.join(PENDING, m[1]);
    if (fs.existsSync(from)) fs.renameSync(from, live);
    return fs.existsSync(live);
}

export function sweep() {
    const cutoff = Date.now() - PENDING_TTL_MS;
    let removed = 0;
    for (const f of fs.readdirSync(PENDING)) {
        const p = path.join(PENDING, f);
        try {
            if (fs.statSync(p).mtimeMs < cutoff) {
                fs.rmSync(p);
                removed++;
            }
        } catch { /* already gone */ }
    }
    if (removed) log.info('uploads.swept', { removed });
}
