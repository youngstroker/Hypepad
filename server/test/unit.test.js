import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeDeposit, MEMO_PROGRAM_ID } from '../solana.js';

const TREASURY = '5qcnTptpLs2hZZmsqt3HNF8zZXpZuuFktChK3tnYnyLp';
const PAYER = 'FYo836JE7Sg3VBFzq8tbdA1wXFRrWfhbyUuF9JQboyh6';
const OTHER = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';

// Shaped like getParsedTransaction(..., { maxSupportedTransactionVersion: 0 }) output.
function parsedTx({ transfers = [[PAYER, TREASURY, 1_000_000]], memos = ['hp1:abc'], err = null, signers = [PAYER], treasuryDelta } = {}) {
    const keys = [...new Set([...signers, TREASURY, OTHER])];
    const gained = treasuryDelta ?? transfers.filter(([, to]) => to === TREASURY).reduce((a, [, , l]) => a + l, 0);
    const pre = keys.map(() => 10_000_000);
    const post = keys.map((k, i) => (k === TREASURY && !err ? pre[i] + gained : pre[i]));
    return {
        slot: 1,
        meta: { err, preBalances: pre, postBalances: post },
        transaction: {
            message: {
                accountKeys: keys.map((k) => ({ pubkey: k, signer: signers.includes(k), writable: true })),
                instructions: [
                    ...transfers.map(([source, destination, lamports]) => ({
                        program: 'system', programId: '11111111111111111111111111111111',
                        parsed: { type: 'transfer', info: { source, destination, lamports } },
                    })),
                    ...memos.map((m) => ({ program: 'spl-memo', programId: MEMO_PROGRAM_ID, parsed: m })),
                ],
            },
        },
    };
}

test('accepts a signed transfer to the treasury with a memo', () => {
    assert.deepEqual(summarizeDeposit(parsedTx(), TREASURY), { ok: true, memo: 'hp1:abc', source: PAYER, lamports: 1_000_000, slot: 1 });
});

test('sums multiple transfers from the same payer', () => {
    const r = summarizeDeposit(parsedTx({ transfers: [[PAYER, TREASURY, 5], [PAYER, TREASURY, 7]] }), TREASURY);
    assert.equal(r.lamports, 12);
});

test('rejects failed transactions', () => {
    assert.equal(summarizeDeposit(parsedTx({ err: { InstructionError: [0, 'Custom'] } }), TREASURY).reason, 'tx_failed');
});

test('ignores transfers to other addresses', () => {
    assert.equal(summarizeDeposit(parsedTx({ transfers: [[PAYER, OTHER, 99]] }), TREASURY).reason, 'no_transfer');
});

test('ignores transfers whose source did not sign', () => {
    assert.equal(summarizeDeposit(parsedTx({ transfers: [[OTHER, TREASURY, 99]] }), TREASURY).reason, 'no_transfer');
});

test('rejects ambiguous multi-source and multi-memo transactions', () => {
    assert.equal(summarizeDeposit(parsedTx({ signers: [PAYER, OTHER], transfers: [[PAYER, TREASURY, 1], [OTHER, TREASURY, 1]] }), TREASURY).reason, 'multiple_sources');
    assert.equal(summarizeDeposit(parsedTx({ memos: ['hp1:a', 'hp1:b'] }), TREASURY).reason, 'multiple_memos');
});

test('never credits more than the treasury balance actually gained', () => {
    const r = summarizeDeposit(parsedTx({ treasuryDelta: 10 }), TREASURY);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'balance_mismatch');
    assert.equal(r.memo, 'hp1:abc');
});

test('keeps the memo on unparseable deposits so they can be traced to an order', () => {
    const r = summarizeDeposit(parsedTx({ signers: [PAYER, OTHER], transfers: [[PAYER, TREASURY, 1], [OTHER, TREASURY, 1]] }), TREASURY);
    assert.equal(r.memo, 'hp1:abc');
    assert.equal(r.lamports, 2);
});

test('missing transaction reads as not found', () => {
    assert.equal(summarizeDeposit(null, TREASURY).reason, 'not_found');
});
