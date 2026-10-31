import { Buffer, bs58, PublicKey, SystemProgram, Transaction, TransactionInstruction, ComputeBudgetProgram, getAddress } from '/vendor/libs.js';
import { api } from './api.js';
import { settings, PRIORITY } from './settings.js';

const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const RENT_EXEMPT_MIN = 890_880; // a wallet must keep 0 or at least this many lamports
const PAYMENT_CU = 60_000;

// ---------------------------------------------------------------- Solana

const SOLANA_WALLETS = [
    { id: 'phantom', name: 'Phantom', url: 'https://phantom.app', browse: (page, ref) => `https://phantom.app/ul/browse/${encodeURIComponent(page)}?ref=${encodeURIComponent(ref)}`, get: () => window.phantom?.solana || (window.solana?.isPhantom ? window.solana : null) },
    { id: 'solflare', name: 'Solflare', url: 'https://solflare.com', browse: (page, ref) => `https://solflare.com/ul/v1/browse/${encodeURIComponent(page)}?ref=${encodeURIComponent(ref)}`, get: () => (window.solflare?.isSolflare ? window.solflare : null) },
    { id: 'backpack', name: 'Backpack', url: 'https://backpack.app', get: () => window.backpack?.isBackpack ? window.backpack : null },
];

const state = { sol: null, solProvider: null, solWalletId: null, evm: null };
const listeners = new Set();
const emit = () => listeners.forEach((fn) => fn(state));
export const onWallets = (fn) => listeners.add(fn);
export const wallets = () => state;

// Mobile browsers have no wallet extension; the wallet apps open the site in their own browser instead.
export const isMobile = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || matchMedia('(pointer:coarse)').matches;

export function availableSolanaWallets() {
    return SOLANA_WALLETS.map((w) => ({ ...w, provider: w.get() }));
}

const wired = new WeakSet();
function wire(p) {
    if (wired.has(p)) return;
    wired.add(p);
    p.on?.('disconnect', () => {
        if (state.solProvider === p) {
            Object.assign(state, { sol: null, solProvider: null, solWalletId: null });
            emit();
        }
    });
    p.on?.('accountChanged', (pk) => {
        if (state.solProvider !== p) return;
        state.sol = pk ? pk.toString() : null;
        if (!pk) state.solProvider = null;
        emit();
    });
}

export async function connectSolana(id) {
    const w = SOLANA_WALLETS.find((x) => x.id === id);
    const p = w?.get();
    if (!p) throw new Error(`${w?.name || 'Wallet'} is not installed.`);
    const res = await p.connect();
    const pk = res?.publicKey || p.publicKey;
    if (!pk) throw new Error('The wallet did not return an account.');
    Object.assign(state, { sol: pk.toString(), solProvider: p, solWalletId: id });
    wire(p);
    try { localStorage.setItem('hp.wallet', id); } catch { /* ignore */ }
    emit();
    return state.sol;
}

/** Reconnects silently only if this wallet already trusts the site. */
export async function eagerConnect() {
    let id = null;
    try { id = localStorage.getItem('hp.wallet'); } catch { /* ignore */ }
    const w = SOLANA_WALLETS.find((x) => x.id === id);
    const p = w?.get();
    if (!p) return;
    try {
        const res = await p.connect({ onlyIfTrusted: true });
        const pk = res?.publicKey || p.publicKey;
        if (pk) {
            Object.assign(state, { sol: pk.toString(), solProvider: p, solWalletId: id });
            wire(p);
            emit();
        }
    } catch { /* not trusted yet; wait for a click */ }
}

export async function disconnectSolana() {
    try { await state.solProvider?.disconnect?.(); } catch { /* ignore */ }
    try { localStorage.removeItem('hp.wallet'); } catch { /* ignore */ }
    Object.assign(state, { sol: null, solProvider: null, solWalletId: null });
    emit();
}

/**
 * Pays an order: one System transfer to the treasury plus the order's memo.
 * The amount and destination come from the order the server created, and the
 * wallet shows both to the user before they approve. Returns the signature and
 * the block height after which the transaction can no longer land.
 */
export async function payOrder(order) {
    const p = state.solProvider;
    if (!p || !state.sol) throw new Error('Connect your Solana wallet first.');
    const payer = new PublicKey(state.sol);
    const microLamports = PRIORITY[settings().priority] ?? PRIORITY.normal;
    const priorityLamports = Math.ceil((PAYMENT_CU * microLamports) / 1e6);
    const needed = order.lamportsTotal + 5000 + priorityLamports;

    const { lamports } = await api(`/solana/balance/${state.sol}`);
    if (lamports < needed) {
        throw new Error(`Not enough SOL. You need ${(needed / 1e9).toFixed(4)} SOL including network fees.`);
    }
    if (lamports - needed > 0 && lamports - needed < RENT_EXEMPT_MIN) {
        throw new Error('This would leave your wallet below the 0.00089 SOL Solana requires accounts to keep. Pay less or top up first.');
    }

    const { blockhash, lastValidBlockHeight } = await api('/solana/blockhash');
    const tx = new Transaction({ feePayer: payer, blockhash, lastValidBlockHeight });
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: PAYMENT_CU }));
    if (microLamports) tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }));
    tx.add(SystemProgram.transfer({ fromPubkey: payer, toPubkey: new PublicKey(order.treasury), lamports: order.lamportsTotal }));
    tx.add(new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [{ pubkey: payer, isSigner: true, isWritable: false }], data: Buffer.from(order.memo, 'utf8') }));

    if (typeof p.signAndSendTransaction === 'function') {
        const res = await p.signAndSendTransaction(tx);
        const sig = typeof res === 'string' ? res : res?.signature;
        if (sig) return { signature: typeof sig === 'string' ? sig : bs58.encode(sig), lastValidBlockHeight };
    }
    const signed = await p.signTransaction(tx);
    // The signature is known before sending; return it even if the broadcast
    // request fails, so the order keeps watching for it instead of offering
    // to pay again while this transaction may still land.
    const signature = bs58.encode(signed.signature);
    await api('/solana/broadcast', { method: 'POST', body: { transaction: signed.serialize().toString('base64') } }).catch(() => {});
    return { signature, lastValidBlockHeight };
}

// ---------------------------------------------------------------- HyperEVM

const eth = () => window.ethereum;
export const hasEvmWallet = () => Boolean(eth());

export async function connectEvm(evmConfig) {
    if (!eth()) throw new Error('No HyperEVM wallet found. Install MetaMask or Rabby, then reload.');
    const [account] = await eth().request({ method: 'eth_requestAccounts' });
    if (!account) throw new Error('The wallet did not return an account.');
    await ensureChain(evmConfig);
    state.evm = getAddress(account);
    if (!wired.has(eth())) {
        wired.add(eth());
        eth().on?.('accountsChanged', (a) => {
            state.evm = a?.[0] ? getAddress(a[0]) : null;
            emit();
        });
    }
    emit();
    return state.evm;
}

export function disconnectEvm() {
    state.evm = null; // injected EVM wallets have no programmatic disconnect
    emit();
}

async function ensureChain(c) {
    const hex = `0x${c.chainId.toString(16)}`;
    const current = await eth().request({ method: 'eth_chainId' });
    if (current?.toLowerCase() === hex) return;
    try {
        await eth().request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
    } catch (err) {
        if (err?.code !== 4902 && err?.data?.originalError?.code !== 4902) throw err;
        await eth().request({
            method: 'wallet_addEthereumChain',
            params: [{
                chainId: hex,
                chainName: c.chainName,
                nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
                rpcUrls: [c.rpcUrl],
                blockExplorerUrls: c.explorer ? [c.explorer] : undefined,
            }],
        });
    }
}

export async function sendEvmTx(evmConfig, { to, data, value = 0n }) {
    if (!state.evm) throw new Error('Connect your HyperEVM wallet first.');
    await ensureChain(evmConfig);
    const hash = await eth().request({
        method: 'eth_sendTransaction',
        params: [{ from: state.evm, to, data, value: `0x${value.toString(16)}` }],
    });
    for (let i = 0; i < 120; i++) {
        const r = await eth().request({ method: 'eth_getTransactionReceipt', params: [hash] });
        if (r) {
            if (r.status !== '0x1') throw new Error('The transaction reverted on HyperEVM.');
            return hash;
        }
        await new Promise((res) => setTimeout(res, 1000));
    }
    throw new Error('Timed out waiting for the HyperEVM transaction.');
}

export function walletErrorMessage(err) {
    const m = String(err?.message || err || '');
    if (err?.code === 4001 || /reject|denied|cancel/i.test(m)) return 'You cancelled the request in your wallet.';
    if (/blockhash not found|block height exceeded/i.test(m)) return 'Your wallet may be on a different Solana network than this site. Switch networks in the wallet and try again.';
    return m || 'Something went wrong in the wallet.';
}
