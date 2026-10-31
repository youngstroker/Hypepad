// Input validation for everything the public API accepts.
import { config } from './config.js';
import { isEvmAddress, toChecksum } from './hyperevm.js';
import * as uploads from './uploads.js';

export class InputError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/;

export function text(value, field, { min = 0, max, required = false } = {}) {
    if (value === undefined || value === null || value === '') {
        if (required) throw new InputError(`${field} is required.`);
        return '';
    }
    if (typeof value !== 'string') throw new InputError(`${field} must be text.`);
    const v = value.trim().replace(/\s+/g, ' ');
    if (CONTROL.test(v)) throw new InputError(`${field} contains invisible or control characters.`);
    if (v.length < min || (required && !v)) throw new InputError(`${field} is too short.`);
    if (max && [...v].length > max) throw new InputError(`${field} must be ${max} characters or fewer.`);
    if (Buffer.byteLength(v) > max * 4) throw new InputError(`${field} is too long.`);
    return v;
}

export function multiline(value, field, max) {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value !== 'string') throw new InputError(`${field} must be text.`);
    const v = value.replace(/\r\n/g, '\n').trim();
    if (/[\u0000-\u0009\u000b-\u001f\u007f‪-‮⁦-⁩]/.test(v)) throw new InputError(`${field} contains control characters.`);
    if ([...v].length > max) throw new InputError(`${field} must be ${max} characters or fewer.`);
    return v;
}

export function symbol(value) {
    const v = text(value, 'Ticker', { required: true, max: 10 }).toUpperCase().replace(/^\$/, '');
    if (!/^[A-Z0-9]{1,10}$/.test(v)) throw new InputError('Ticker can use letters A-Z and digits only, up to 10.');
    return v;
}

export function evmAddress(value, field = 'HyperEVM address') {
    if (!isEvmAddress(value)) throw new InputError(`${field} is not a valid 0x address.`);
    const v = toChecksum(value);
    if (/^0x0{40}$/i.test(v)) throw new InputError(`${field} cannot be the zero address.`);
    return v;
}

export function solAmount(value, field, { min, max, allowZero = false }) {
    const n = typeof value === 'string' ? Number(value) : value;
    if (allowZero && (n === 0 || value === '' || value === undefined || value === null)) return 0;
    if (typeof n !== 'number' || !Number.isFinite(n)) throw new InputError(`${field} must be a number.`);
    if (n < min) throw new InputError(`${field} must be at least ${min} SOL.`);
    if (n > max) throw new InputError(`${field} must be at most ${max} SOL.`);
    return Math.round(n * 1e9); // lamports
}

export function slippage(value) {
    const n = Number(value ?? 300);
    if (!Number.isInteger(n) || n < 0 || n > config.limits.maxSlippageBps) throw new InputError('Slippage must be between 0% and 50%.');
    return n;
}

export function httpsUrl(value, field) {
    const v = text(value, field, { max: 200 });
    if (!v) return '';
    let url;
    try {
        url = new URL(v);
    } catch {
        throw new InputError(`${field} must be a full https:// link.`);
    }
    if (url.protocol !== 'https:' || url.username || url.password) throw new InputError(`${field} must be a full https:// link.`);
    return url.toString();
}

export function twitter(value) {
    const v = text(value, 'X / Twitter', { max: 200 });
    if (!v) return '';
    const handle = v.replace(/^https?:\/\/(www\.)?(twitter|x)\.com\//i, '').replace(/^@/, '').split(/[/?#]/)[0];
    if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) throw new InputError('X / Twitter must be a handle like @name or an x.com link.');
    return `https://x.com/${handle}`;
}

export function telegram(value) {
    const v = text(value, 'Telegram', { max: 200 });
    if (!v) return '';
    const handle = v.replace(/^https?:\/\/(www\.)?(t\.me|telegram\.me)\//i, '').replace(/^@/, '').split(/[?#]/)[0];
    if (!/^(\+?[A-Za-z0-9_]{4,64}|joinchat\/[A-Za-z0-9_-]{8,64})$/.test(handle)) throw new InputError('Telegram must be a handle like @group or a t.me link.');
    return `https://t.me/${handle}`;
}

/** Images must have been uploaded through /api/upload first. */
export function uploadedImage(value) {
    if (typeof value !== 'string' || !/^\/uploads\/[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(value)) {
        throw new InputError('Upload an image for your coin.');
    }
    if (!uploads.exists(value)) throw new InputError('That image upload has expired. Upload it again.');
    return value;
}
