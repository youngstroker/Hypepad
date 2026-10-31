// Solana side: reading treasury deposits and sending refunds.
// A payment counts only when it is FINALIZED, succeeded, and its top-level
// instructions include a System transfer to the treasury plus a memo naming
// the order. Nothing about a payment is taken from the client.
import bs58 from 'bs58';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, ComputeBudgetProgram } from '@solana/web3.js';
import { config } from './config.js';

export const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const LAMPORTS_PER_SOL = 1_000_000_000;

let connection;
export function solConnection() {
    connection ||= new Connection(config.solana.rpcUrl, { commitment: 'finalized' });
    return connection;
}

export function isSolAddress(value) {
    try {
        return typeof value === 'string' && PublicKey.isOnCurve(new PublicKey(value).toBytes());
    } catch {
        return false;
    }
}

let treasuryKeypair;
export function treasurySigner() {
    if (!config.solana.treasurySecret) return null;
    if (!treasuryKeypair) {
        const raw = config.solana.treasurySecret.trim();
        const bytes = raw.startsWith('[') ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw);
        treasuryKeypair = Keypair.fromSecretKey(bytes);
        if (treasuryKeypair.publicKey.toBase58() !== config.solana.treasury) {
            throw new Error('TREASURY_SECRET_KEY does not match TREASURY_PUBLIC_KEY');
        }
    }
    return treasuryKeypair;
}

/**
 * Reduces a parsed transaction to what matters for a deposit.
 * Pure function so it can be unit-tested with fixtures.
 * @returns {{ ok: boolean, reason?: string, memo: string|null, source: string|null, lamports: number, slot?: number }}
 */
export function summarizeDeposit(parsedTx, treasury) {
    if (!parsedTx) return { ok: false, reason: 'not_found', memo: null, source: null, lamports: 0 };
    const keys = parsedTx.transaction?.message?.accountKeys || [];
    // What actually happened to the treasury's balance, whatever the instructions say.
    const ti = keys.findIndex((k) => k.pubkey.toString() === treasury);
    const delta = ti >= 0 && parsedTx.meta ? Number(parsedTx.meta.postBalances[ti]) - Number(parsedTx.meta.preBalances[ti]) : 0;
    const instructions = parsedTx.transaction?.message?.instructions || [];
    const memos = instructions
        .filter((ix) => ix.programId?.toString() === MEMO_PROGRAM_ID && typeof ix.parsed === 'string')
        .map((ix) => ix.parsed);
    const memo = memos[0] ?? null;
    const bad = (reason) => ({ ok: false, reason, memo, source: null, lamports: Math.max(delta, 0) });

    if (parsedTx.meta?.err) return { ok: false, reason: 'tx_failed', memo, source: null, lamports: 0 };
    if (memos.length > 1) return bad('multiple_memos');

    const signers = new Set(keys.filter((k) => k.signer).map((k) => k.pubkey.toString()));
    let source = null;
    let lamports = 0;
    let mixedSources = false;
    for (const ix of instructions) {
        if (ix.program === 'system' && ix.parsed?.type === 'transfer' && ix.parsed.info?.destination === treasury) {
            const from = ix.parsed.info.source;
            if (!signers.has(from)) continue;
            if (source && source !== from) mixedSources = true;
            source = from;
            lamports += Number(ix.parsed.info.lamports);
        }
    }
    if (mixedSources) return bad('multiple_sources');
    if (!source || lamports <= 0) return bad('no_transfer');
    // Never credit more than the treasury actually gained (e.g. a transaction
    // that pays in and then moves funds back out some other way).
    if (ti >= 0 && delta < lamports) return bad('balance_mismatch');
    return { ok: true, memo, source, lamports, slot: parsedTx.slot };
}

export async function fetchDeposit(signature) {
    const tx = await solConnection().getParsedTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
    return summarizeDeposit(tx, config.solana.treasury);
}

/** Newest-first treasury signatures after `untilSignature` (exclusive). */
export async function recentTreasurySignatures(untilSignature) {
    const opts = { limit: 200 };
    if (untilSignature) opts.until = untilSignature;
    return solConnection().getSignaturesForAddress(new PublicKey(config.solana.treasury), opts, 'finalized');
}

export async function latestBlockhash() {
    return solConnection().getLatestBlockhash('confirmed');
}

export async function solBalance(address) {
    return solConnection().getBalance(new PublicKey(address), 'confirmed');
}

/**
 * Signs (does not send) a refund from the treasury. The caller stores the
 * signature and raw bytes before broadcasting, so a crash can never lead to
 * paying the same refund twice: after a restart the stored signature is
 * checked, and a new refund is only signed once the old blockhash expired.
 */
export async function signRefund(to, lamports, memoText) {
    const signer = treasurySigner();
    if (!signer) throw new Error('No treasury key configured');
    const { blockhash, lastValidBlockHeight } = await solConnection().getLatestBlockhash('confirmed');
    const tx = new Transaction({ feePayer: signer.publicKey, blockhash, lastValidBlockHeight });
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 30_000 }));
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20_000 }));
    tx.add(SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: new PublicKey(to), lamports }));
    if (memoText) tx.add({ programId: new PublicKey(MEMO_PROGRAM_ID), keys: [], data: Buffer.from(memoText, 'utf8') });
    tx.sign(signer);
    return { signature: bs58.encode(tx.signature), raw: tx.serialize().toString('base64'), lastValidBlockHeight };
}

export async function broadcastRaw(rawBase64) {
    // Preflight at 'confirmed' to match the blockhash commitment; at the
    // connection default ('finalized') a fresh blockhash is usually rejected.
    return solConnection().sendRawTransaction(Buffer.from(rawBase64, 'base64'), { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 });
}

/** @returns {'confirmed'|'failed'|'unknown'} */
export async function signatureState(signature) {
    const { value } = await solConnection().getSignatureStatuses([signature], { searchTransactionHistory: true });
    const st = value[0];
    if (!st) return 'unknown';
    if (st.err) return 'failed';
    return st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized' ? 'confirmed' : 'unknown';
}

export async function blockHeight(commitment = 'confirmed') {
    return solConnection().getBlockHeight(commitment);
}

/** True only if the transaction is in finalized history. */
export async function isFinalized(signature) {
    const tx = await solConnection().getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
    return Boolean(tx && !tx.meta?.err);
}

let rentMin = null;
export async function rentExemptMinimum() {
    rentMin ??= await solConnection().getMinimumBalanceForRentExemption(0);
    return rentMin;
}

export async function genesisHash() {
    return solConnection().getGenesisHash();
}
