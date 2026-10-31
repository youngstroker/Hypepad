// Operator tools. Reads the same .env and database as the server.
//   npm run admin -- attention                     everything that needs a human
//   npm run admin -- order <id>                    full order record and its refunds
//   npm run admin -- refund-sent <refundId> <sig> [to]  record a refund you sent by hand (verified on-chain)
//   npm run admin -- dismiss <refundId> [note]    close a manual refund that is not owed (e.g. your own top-up)
//   npm run admin -- resolve <orderId> completed|refund   close a 'needs_review' order
//   npm run admin -- hide <token> | unhide <token> remove a coin from this site (it stays on-chain)
process.env.NO_JOBS = '1';
const { db, now } = await import('../server/db.js');
const { solConnection } = await import('../server/solana.js');

const [cmd, ...args] = process.argv.slice(2);
const sol = (l) => (l == null ? null : l / 1e9);

if (cmd === 'attention') {
    const review = db.prepare(`SELECT id, kind, payer, lamports_total, evm_nonce, error, updated_at FROM orders WHERE status = 'needs_review' ORDER BY updated_at`).all();
    const manual = db.prepare(`SELECT id, order_id, to_address, lamports, reason, note FROM refunds WHERE status = 'manual' ORDER BY created_at`).all();
    const owed = db.prepare(`SELECT id, to_address, lamports, reason, pending_sig, created_at FROM refunds WHERE status = 'pending' ORDER BY created_at`).all();
    const stuck = db.prepare(`SELECT id, kind, status, evm_tx_hash, error, paid_at FROM orders WHERE status IN ('paid', 'processing') AND paid_at < ?`).all(now() - 600);
    const unread = db.prepare(`SELECT signature, note, seen_at FROM sol_deposits WHERE note LIKE 'needs_manual_review%'`).all();
    console.log(`\nOrders needing review (${review.length}) — paid, relayer nonce used, no receipt for our tx. Check the relayer's transactions, then: resolve <id> completed|refund`);
    console.table(review.map((r) => ({ ...r, sol: sol(r.lamports_total) })));
    console.log(`\nRefunds that need a human (${manual.length}) — send by hand, then: refund-sent <id> <signature>`);
    console.table(manual.map((r) => ({ ...r, sol: sol(r.lamports) })));
    console.log(`\nRefunds queued (${owed.length}) — sent automatically when TREASURY_SECRET_KEY is set`);
    console.table(owed.map((r) => ({ ...r, sol: sol(r.lamports) })));
    console.log(`\nOrders paid but unfilled for 10+ minutes (${stuck.length})`);
    console.table(stuck);
    console.log(`\nTreasury signatures the RPC never returned (${unread.length}) — look them up on an explorer`);
    console.table(unread);
} else if (cmd === 'order') {
    console.log(db.prepare('SELECT * FROM orders WHERE id = ?').get(args[0]) || 'not found');
    console.table(db.prepare('SELECT id, to_address, lamports, reason, status, sent_sig, note FROM refunds WHERE order_id = ?').all(args[0]));
} else if (cmd === 'refund-sent') {
    const [id, sig] = args;
    const row = db.prepare('SELECT * FROM refunds WHERE id = ?').get(id);
    if (!row) throw new Error('refund not found');
    // Only refunds nobody else will pay: manual ones, or pending ones the server never signed.
    if (!(row.status === 'manual' || (row.status === 'pending' && !row.pending_sig))) {
        throw new Error(`Refund ${id} is '${row.status}'${row.pending_sig ? ` with server transaction ${row.pending_sig}` : ''}; it is handled automatically. Do not pay it by hand.`);
    }
    const tx = await solConnection().getParsedTransaction(sig, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
    if (!tx || tx.meta?.err) throw new Error('That signature is not a successful finalized transaction.');
    const to = row.to_address || args[2];
    const paid = tx.transaction.message.instructions
        .filter((ix) => ix.program === 'system' && ix.parsed?.type === 'transfer' && ix.parsed.info.destination === to)
        .reduce((sum, ix) => sum + Number(ix.parsed.info.lamports), 0);
    if (!to || paid < row.lamports) throw new Error(`That transaction pays ${paid} lamports to ${to || '(no address; pass it as the 3rd argument)'}, not ${row.lamports}.`);
    if (db.prepare(`SELECT 1 FROM refunds WHERE sent_sig = ?`).get(sig)) throw new Error('That transaction is already recorded for another refund.');
    db.prepare(`UPDATE refunds SET status = 'sent', sent_sig = ?, to_address = ?, updated_at = ? WHERE id = ?`).run(sig, to, now(), id);
    if (row.order_id && id === `order:${row.order_id}`) db.prepare(`UPDATE orders SET status = 'refunded', refund_signature = ?, updated_at = ? WHERE id = ?`).run(sig, now(), row.order_id);
    console.log(`Recorded ${sig} for refund ${id}`);
} else if (cmd === 'dismiss') {
    // e.g. a memo-less deposit that was your own treasury top-up
    const res = db.prepare(`UPDATE refunds SET status = 'skipped', note = ?, updated_at = ? WHERE id = ? AND status = 'manual'`).run(args.slice(1).join(' ') || 'dismissed by operator', now(), args[0]);
    console.log(res.changes ? `Dismissed ${args[0]}` : 'no manual refund with that id');
} else if (cmd === 'resolve') {
    const [id, outcome] = args;
    const row = db.prepare(`SELECT * FROM orders WHERE id = ? AND status = 'needs_review'`).get(id);
    if (!row) throw new Error('no order in needs_review with that id');
    if (outcome === 'completed') {
        db.prepare(`UPDATE orders SET status = 'completed', error = NULL, updated_at = ? WHERE id = ?`).run(now(), id);
    } else if (outcome === 'refund') {
        db.prepare(`INSERT OR IGNORE INTO refunds (id, order_id, deposit_sig, to_address, lamports, reason, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'order_failed', 'pending', ?, ?)`).run(`order:${id}`, id, row.sol_signature, row.payer, row.lamports_total, now(), now());
        db.prepare(`UPDATE orders SET status = 'refunding', refund_lamports = COALESCE(refund_lamports, 0) + ?, updated_at = ? WHERE id = ?`).run(row.lamports_total, now(), id);
    } else {
        throw new Error('outcome must be completed or refund');
    }
    console.log(`Order ${id} -> ${outcome}`);
} else if (cmd === 'hide' || cmd === 'unhide') {
    const res = db.prepare('UPDATE tokens SET hidden = ? WHERE LOWER(address) = LOWER(?)').run(cmd === 'hide' ? 1 : 0, args[0] || '');
    console.log(res.changes ? `${cmd === 'hide' ? 'Hidden' : 'Unhidden'} ${args[0]}` : 'token not found');
} else {
    console.log('Usage: npm run admin -- attention | order <id> | refund-sent <refundId> <sig> [to] | dismiss <refundId> [note] | resolve <orderId> completed|refund | hide <token> | unhide <token>');
}
