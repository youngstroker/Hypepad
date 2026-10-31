// One in-flight HyperEVM transaction per signing key.
//
// The slot is saved to the database BEFORE the transaction is broadcast, so a
// crash or restart can always tell what is outstanding. While a transaction
// is pending it is re-broadcast, and fee-bumped at the same nonce if it sits
// too long, so every candidate competes for one nonce and at most one can
// execute. A transaction is never re-sent at a new nonce on a guess: if the
// nonce is used but none of our candidates has a receipt, the slot is handed
// back to the caller as 'gone' only after a long, repeated check.
import { db, kvGet, kvSet, now, tx } from './db.js';
import * as evm from './hyperevm.js';
import { log } from './log.js';

const BUMP_AFTER_SEC = 30;
const MAX_BUMPS = 6;
const GONE_AFTER_SEC = 300;

const slotKey = (address) => `evm_slot:${address.toLowerCase()}`;
const nextKey = (address) => `evm_next_nonce:${address.toLowerCase()}`;

// BigInts are stored as {"$bigint": "123"}, which no user-supplied string can collide with.
const encode = (s) => JSON.stringify(s, (_, v) => (typeof v === 'bigint' ? { $bigint: v.toString() } : v));
const decode = (raw) => (raw ? JSON.parse(raw, (_, v) => (v && typeof v === 'object' && typeof v.$bigint === 'string' ? BigInt(v.$bigint) : v)) : null);

export const getSlot = (address) => decode(kvGet(slotKey(address)));
const saveSlot = (address, slot) => kvSet(slotKey(address), encode(slot));
export const clearSlot = (address) => db.prepare('DELETE FROM kv WHERE key = ?').run(slotKey(address));

/**
 * Signs `call`, records it as the account's in-flight transaction (running
 * `onSaved` in the same DB transaction so callers can link it), then
 * broadcasts it. Throws if the slot is busy. If the broadcast is rejected
 * outright, the slot is cleared and the error rethrown (nothing was sent).
 */
export async function send(account, { purpose, ref, call, onSaved }) {
    if (getSlot(account.address)) throw new Error('slot busy');
    const latest = await evm.confirmedNonce(account.address);
    const nonce = Math.max(latest, Number(kvGet(nextKey(account.address)) || 0));
    const signed = await evm.signFactoryCall({ ...call, nonce });
    const slot = {
        purpose, ref, call: { functionName: call.functionName, args: call.args, value: call.value ?? 0n, useMigrator: call.useMigrator },
        nonce, hashes: [signed.hash], raw: signed.raw, sentAt: now(), bumps: 0,
        fees: { maxFeePerGas: signed.maxFeePerGas, maxPriorityFeePerGas: signed.maxPriorityFeePerGas },
    };
    tx(() => {
        saveSlot(account.address, slot);
        onSaved?.(slot);
    });
    try {
        await evm.broadcast(signed.raw);
    } catch (err) {
        if (err instanceof evm.NonceConflictError) {
            // The nonce was already used by something else; skip past it.
            kvSet(nextKey(account.address), nonce + 1);
        }
        if (err instanceof evm.NonceConflictError || isDefinitiveRejection(err)) {
            clearSlot(account.address);
            err.rejected = true;
        }
        throw err;
    }
    return slot;
}

const isRevertError = (err) => /ContractFunctionRevertedError|ContractFunctionExecutionError/.test(`${err?.name} ${err?.cause?.name}`) || /reverted/i.test(err?.shortMessage || '');

const isDefinitiveRejection = (err) =>
    /insufficient funds|intrinsic gas|exceeds block gas limit|gas limit reached|invalid sender|invalid transaction|tx fee .* exceeds|max fee per gas less than block base fee/i
        .test(`${err?.shortMessage} ${err?.details} ${err?.message}`);

/**
 * Checks the account's in-flight transaction.
 * @returns {Promise<{state: 'idle'} | {state: 'mined', slot, receipt} | {state: 'pending', slot} | {state: 'gone', slot}>}
 */
export async function reconcile(account) {
    const slot = getSlot(account.address);
    if (!slot) return { state: 'idle' };
    // Nonce first, receipts second: if our transaction mines between the two
    // reads we see the receipt, never "nonce used but no receipt".
    const used = await evm.confirmedNonce(account.address);
    for (const hash of slot.hashes) {
        const receipt = await evm.getReceipt(hash);
        if (receipt) {
            kvSet(nextKey(account.address), slot.nonce + 1);
            return { state: 'mined', slot, receipt };
        }
    }
    if (used > slot.nonce) {
        // Our nonce is used but none of our candidates has a receipt. That
        // should not happen (only we sign with this key), so wait it out in
        // case it is RPC lag, and hand it to a human if it persists.
        slot.goneSince ??= now();
        saveSlot(account.address, slot);
        if (now() - slot.goneSince < GONE_AFTER_SEC) return { state: 'pending', slot };
        log.error('relayer.nonce_used_without_receipt', { account: account.address, nonce: slot.nonce, hashes: slot.hashes });
        kvSet(nextKey(account.address), slot.nonce + 1);
        return { state: 'gone', slot };
    }
    slot.goneSince = null;
    if (now() - slot.sentAt >= BUMP_AFTER_SEC && slot.bumps < MAX_BUMPS) {
        slot.sentAt = now(); // throttle: one bump attempt per interval, success or not
        try {
            const signed = slot.cancelHash
                ? await evm.signCancel({ useMigrator: slot.call.useMigrator, nonce: slot.nonce, minFees: slot.fees })
                : await evm.signFactoryCall({ ...slot.call, nonce: slot.nonce, minFees: slot.fees });
            if (slot.cancelHash) slot.cancelHash = signed.hash;
            Object.assign(slot, {
                raw: signed.raw, bumps: slot.bumps + 1, hashes: [...slot.hashes, signed.hash],
                fees: { maxFeePerGas: signed.maxFeePerGas, maxPriorityFeePerGas: signed.maxPriorityFeePerGas },
            });
            log.warn('relayer.fee_bump', { account: account.address, nonce: slot.nonce, bumps: slot.bumps, cancel: Boolean(slot.cancelHash) });
        } catch (err) {
            if (isRevertError(err)) {
                // The call would now revert (e.g. the price moved past slippage),
                // so it cannot be re-priced. Replace it with a 0-value transfer to
                // ourselves at the same nonce; once that mines, the original can
                // never execute and the caller may safely refund.
                const cancel = await evm.signCancel({ useMigrator: slot.call.useMigrator, nonce: slot.nonce, minFees: slot.fees });
                Object.assign(slot, {
                    raw: cancel.raw, cancelHash: cancel.hash, bumps: slot.bumps + 1, hashes: [...slot.hashes, cancel.hash],
                    fees: { maxFeePerGas: cancel.maxFeePerGas, maxPriorityFeePerGas: cancel.maxPriorityFeePerGas },
                });
                log.warn('relayer.cancel', { account: account.address, nonce: slot.nonce, ref: slot.ref });
            } else {
                log.warn('relayer.bump_failed', { err: err.shortMessage || err.message });
            }
        }
        saveSlot(account.address, slot);
    }
    try {
        await evm.broadcast(slot.raw);
    } catch (err) {
        if (!(err instanceof evm.NonceConflictError)) log.warn('relayer.rebroadcast_failed', { err: err.shortMessage || err.message });
    }
    return { state: 'pending', slot };
}

/** Waits briefly for the in-flight transaction to mine (fast path after sending). */
export async function settle(account, ms = 8000) {
    const until = Date.now() + ms;
    for (;;) {
        const slot = getSlot(account.address);
        if (!slot) return { state: 'idle' };
        for (const hash of slot.hashes) {
            const receipt = await evm.getReceipt(hash).catch(() => null);
            if (receipt) {
                kvSet(nextKey(account.address), slot.nonce + 1);
                return { state: 'mined', slot, receipt };
            }
        }
        if (Date.now() > until) return { state: 'pending', slot };
        await new Promise((r) => setTimeout(r, 700));
    }
}
