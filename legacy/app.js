import {
    Connection,
    Keypair,
    SystemProgram,
    Transaction,
    clusterApiUrl,
    TOKEN_PROGRAM_ID,
    MINT_SIZE,
    ACCOUNT_SIZE,
    getMinimumBalanceForRentExemptMint,
    createInitializeMintInstruction,
    getAssociatedTokenAddressSync,
    createAssociatedTokenAccountInstruction,
    createMintToInstruction,
    createSetAuthorityInstruction,
    AuthorityType,
} from "./vendor/solana.js";

// ---------------------------------------------------------------------------
// This app creates a REAL SPL token mint on Solana. Every transaction is
// built so the connecting wallet is the fee payer, the mint authority, the
// freeze authority, and the recipient of the initial supply. The only
// lamports that move are:
//   1) standard Solana network/signature fees, paid to the network, and
//   2) the rent-exempt deposit for the new mint account (locked in it for
//      good, since a classic SPL mint cannot be closed) and for the wallet's
//      own token account (refundable by closing that account).
// No instruction in this file sends funds or token authority to any address
// other than the new mint and the connecting wallet's own accounts. There is
// no platform fee and no hardcoded destination account anywhere.
//
// The Solana libraries come from ./vendor/solana.js, bundled locally from
// exact versions pinned in package-lock.json (run `npm run build`).
// ---------------------------------------------------------------------------

// Genesis hashes identify which cluster an RPC endpoint reports it is on.
// A custom RPC is trusted for this, so it is only a guard against mistakes,
// not against a deliberately hostile endpoint.
const GENESIS_HASHES = {
    '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d': 'mainnet-beta',
    'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG': 'devnet',
    '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY': 'testnet',
};

const U64_MAX = 18446744073709551615n;
const BASE_FEE_LAMPORTS = 5000;
const SIGNATURES = 2; // wallet + the new mint keypair
// Rent for these small accounts is well under 0.002 SOL on every cluster. A
// reported value above this cap means the RPC is misbehaving, and we refuse
// to put it into a transaction.
const MAX_ACCOUNT_RENT_LAMPORTS = 5_000_000;
const CLUSTER_NAMES = { 'mainnet-beta': 'Mainnet', devnet: 'Devnet', testnet: 'Testnet' };

const $ = (id) => document.getElementById(id);

document.addEventListener('DOMContentLoaded', () => {
    const segButtons = document.querySelectorAll('.seg-btn');
    const walletBtn = $('walletBtn');
    const banner = $('networkBanner');
    const chipNetwork = $('chipNetwork');
    const rpcUrlInput = $('rpcUrl');

    const nameInput = $('tokenName');
    const symbolInput = $('tokenSymbol');
    const decimalsInput = $('tokenDecimals');
    const supplyInput = $('tokenSupply');
    const revokeMintEl = $('revokeMint');
    const revokeFreezeEl = $('revokeFreeze');
    const mainnetConfirmRow = $('mainnetConfirmRow');
    const mainnetConfirm = $('mainnetConfirm');

    const uploadBox = $('uploadBox');
    const uploadInput = $('tokenImageInput');
    const uploadPreview = $('uploadPreview');
    const uploadIcon = $('uploadIcon');
    const uploadLabel = $('uploadLabel');

    const deployBtn = $('deployBtn');
    const statusMsg = $('statusMsg');
    const loader = $('loader');
    const resultBox = $('resultBox');
    const resultTitle = $('resultTitle');
    const resultMint = $('resultMint');
    const resultLink = $('resultLink');
    const copyMintBtn = $('copyMintBtn');
    const tokenGrid = $('tokenGrid');

    let network = 'devnet';
    let detectedCluster = null; // from the genesis hash; 'unknown' if unrecognized
    let syncSeq = 0;
    let provider = null;
    let walletPubkey = null;
    let deploying = false;
    const wiredProviders = new WeakSet();

    // Example tokens so the list isn't empty. They have no on-chain mint, so
    // they carry an "Example" tag instead of an explorer link. Tokens deployed
    // in this session are added to the front.
    const tokens = [
        { name: 'Lightning Frog', symbol: 'ZAP', supply: '1,000,000,000', example: true },
        { name: 'Diamond Paws', symbol: 'PAWS', supply: '420,690,000', example: true },
        { name: 'Rocket Llama', symbol: 'LLAMA', supply: '100,000,000', example: true },
        { name: 'Neon Shrimp', symbol: 'SHRIMP', supply: '888,888,888', example: true },
        { name: 'Moon Pickle', symbol: 'PICKL', supply: '69,000,000', example: true },
        { name: 'Hyper Pepe', symbol: 'HPEPE', supply: '1,000,000', example: true },
    ];

    // ---------------------------------------------------------------- helpers

    const sol = (lamports) => `${(lamports / 1e9).toFixed(6)} SOL`;
    const short = (addr) => `${addr.slice(0, 4)}…${addr.slice(-4)}`;

    function setStatus(text, kind = '') {
        statusMsg.textContent = text;
        statusMsg.className = `status ${kind}`.trim();
    }

    function effectiveCluster() {
        return detectedCluster && detectedCluster !== 'unknown' ? detectedCluster : network;
    }

    function solscanUrl(kind, id, cluster) {
        const base = `https://solscan.io/${kind}/${id}`;
        if (cluster === 'mainnet-beta') return base;
        return `${base}?cluster=${cluster === 'testnet' ? 'testnet' : 'devnet'}`;
    }

    function getConnection() {
        const custom = rpcUrlInput.value.trim();
        return new Connection(custom || clusterApiUrl(network), 'confirmed');
    }

    async function detectCluster(connection) {
        const hash = await connection.getGenesisHash();
        return GENESIS_HASHES[hash] || 'unknown';
    }

    function checkedRent(value, what) {
        if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_ACCOUNT_RENT_LAMPORTS) {
            throw new Error(`The RPC returned an unusual ${what} value (${value}). Refusing to continue. Try a different RPC.`);
        }
        return value;
    }

    async function getRent(connection) {
        const [mintRent, ataRent, walletKeep] = await Promise.all([
            getMinimumBalanceForRentExemptMint(connection),
            connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE),
            connection.getMinimumBalanceForRentExemption(0), // the wallet must stay rent-exempt itself
        ]);
        checkedRent(mintRent, 'mint rent');
        checkedRent(ataRent, 'token account rent');
        checkedRent(walletKeep, 'wallet rent');
        return { mintRent, ataRent, walletKeep, total: mintRent + ataRent };
    }

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    // ---------------------------------------------------------------- tokens grid

    function renderTokens() {
        tokenGrid.replaceChildren(...tokens.map((t) => {
            const card = el('div', 'token-card');
            card.append(el('div', 'avatar', (t.symbol[0] || '?').toUpperCase()));

            const body = el('div', 'token-body');
            body.append(el('div', 'token-name', t.name));

            const row = el('div', 'token-row');
            row.append(el('span', '', `$${t.symbol} · ${t.supply}`));
            if (t.example) {
                row.append(el('span', 'tag', 'Example'));
            } else {
                const link = el('a', '', `${short(t.mint)} ↗`);
                link.href = t.url;
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                row.append(link);
            }
            body.append(row);
            card.append(body);
            return card;
        }));
    }

    // ---------------------------------------------------------------- live preview

    function updatePreview() {
        const name = nameInput.value.trim();
        const symbol = symbolInput.value.trim().toUpperCase();
        const supply = Number(supplyInput.value);

        $('previewAvatar').textContent = (symbol[0] || name[0] || '?').toUpperCase();
        $('previewName').textContent = name || 'Your token';
        $('previewSymbol').textContent = `$${symbol || 'TICKER'}`;
        $('previewSupply').textContent = Number.isFinite(supply) && supply > 0 ? supply.toLocaleString() : '-';
        $('previewDecimals').textContent = decimalsInput.value || '-';
        $('previewMintAuth').textContent = revokeMintEl.checked ? 'Revoked' : 'You';
        $('previewFreezeAuth').textContent = revokeFreezeEl.checked ? 'Revoked' : 'You';
    }
    [nameInput, symbolInput, decimalsInput, supplyInput, revokeMintEl, revokeFreezeEl]
        .forEach((node) => node.addEventListener('input', updatePreview));

    // ---------------------------------------------------------------- network state

    function renderNetworkUI({ mismatch = false } = {}) {
        const cluster = effectiveCluster();
        const unknown = detectedCluster === 'unknown';
        const isMainnet = cluster === 'mainnet-beta';
        const label = CLUSTER_NAMES[cluster] || 'Unknown';

        segButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.network === network)));
        chipNetwork.textContent = unknown ? 'Unrecognized network' : label;
        mainnetConfirmRow.hidden = !(isMainnet || network === 'mainnet-beta');

        let text;
        if (unknown) {
            text = 'This RPC reports an unrecognized network, so deploying is disabled. Use the public endpoint or a provider for Devnet or Mainnet.';
        } else if (mismatch) {
            text = `Your custom RPC is on ${label}, but ${CLUSTER_NAMES[network]} is selected. Switch the toggle to match before deploying.`;
        } else if (isMainnet) {
            text = 'Mainnet: this spends real SOL and cannot be undone. Double-check everything before approving.';
        } else {
            text = `${label}: free test SOL, no real value. Switch to Mainnet only when you intend to spend real SOL.`;
        }
        banner.textContent = text;
        banner.classList.toggle('warn', isMainnet || mismatch || unknown || network === 'mainnet-beta');
    }

    function setCosts(rent) {
        const fee = BASE_FEE_LAMPORTS * SIGNATURES;
        $('costMint').textContent = rent ? sol(rent.mintRent) : '-';
        $('costAta').textContent = rent ? sol(rent.ataRent) : '-';
        $('costFee').textContent = rent ? `~${sol(fee)}` : '-';
        $('costTotal').textContent = rent ? `~${sol(rent.total + fee)}` : '-';
    }

    // Re-detects which cluster the current connection reports and recomputes
    // the cost estimate. A sequence number discards results from superseded
    // calls so rapid toggling can't show stale data. Cluster detection and
    // the rent lookup fail independently: a rent failure must not erase a
    // successful cluster detection.
    async function syncNetworkState() {
        const seq = ++syncSeq;
        detectedCluster = null;
        renderNetworkUI();
        setCosts(null);

        const connection = getConnection();
        try {
            const cluster = await detectCluster(connection);
            if (seq !== syncSeq) return;
            detectedCluster = cluster;
            const mismatch = rpcUrlInput.value.trim() !== '' && cluster !== 'unknown' && cluster !== network;
            renderNetworkUI({ mismatch });
        } catch (err) {
            if (seq !== syncSeq) return;
            renderNetworkUI();
        }

        try {
            const rent = await getRent(connection);
            if (seq !== syncSeq) return;
            setCosts(rent);
        } catch (err) {
            if (seq !== syncSeq) return;
            setCosts(null);
        }
    }

    segButtons.forEach((b) => b.addEventListener('click', () => {
        if (network === b.dataset.network) return;
        network = b.dataset.network;
        mainnetConfirm.checked = false;
        syncNetworkState();
    }));
    rpcUrlInput.addEventListener('change', () => {
        mainnetConfirm.checked = false;
        syncNetworkState();
    });

    // ---------------------------------------------------------------- wallet

    function getProvider() {
        return window.phantom?.solana || (window.solana?.isPhantom ? window.solana : null);
    }

    function renderWallet() {
        if (walletPubkey) {
            walletBtn.textContent = short(walletPubkey.toBase58());
            walletBtn.title = 'Click to disconnect';
            walletBtn.disabled = deploying;
            deployBtn.disabled = deploying;
            deployBtn.textContent = deploying ? 'Creating…' : 'Create token';
        } else {
            walletBtn.textContent = 'Connect';
            walletBtn.title = '';
            walletBtn.disabled = false;
            deployBtn.disabled = true;
            deployBtn.textContent = 'Connect wallet to continue';
        }
    }

    function handleWalletGone() {
        provider = null;
        walletPubkey = null;
        renderWallet();
    }

    // Listeners are attached once per provider object, however many times
    // the user reconnects.
    function wireProvider(p) {
        if (wiredProviders.has(p)) return;
        wiredProviders.add(p);
        p.on?.('disconnect', handleWalletGone);
        p.on?.('accountChanged', (pubkey) => {
            if (pubkey) {
                walletPubkey = pubkey;
                renderWallet();
                setStatus('Wallet account changed.');
            } else {
                handleWalletGone();
            }
        });
    }

    async function connectWallet() {
        const p = getProvider();
        if (!p) {
            setStatus('Phantom wallet not detected. Install it from phantom.app, then reload.', 'err');
            return;
        }
        walletBtn.disabled = true;
        walletBtn.textContent = 'Connecting…';
        try {
            // Always an explicit, user-visible request, never a silent probe.
            const resp = await p.connect();
            provider = p;
            walletPubkey = resp.publicKey;
            wireProvider(p);
            setStatus('Wallet connected.', 'ok');
        } catch (err) {
            console.error(err);
            setStatus(err.message || 'Wallet connection was rejected.', 'err');
        } finally {
            renderWallet();
        }
    }

    async function disconnectWallet() {
        try {
            await provider?.disconnect?.();
        } catch (err) {
            console.error('Wallet disconnect failed:', err);
        }
        handleWalletGone();
        setStatus('Wallet disconnected.');
    }

    walletBtn.addEventListener('click', () => (walletPubkey ? disconnectWallet() : connectWallet()));

    // ---------------------------------------------------------------- image preview (local only)

    uploadBox.addEventListener('click', () => uploadInput.click());
    uploadInput.addEventListener('change', () => {
        const file = uploadInput.files && uploadInput.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            uploadPreview.src = reader.result;
            uploadPreview.hidden = false;
            uploadIcon.setAttribute('hidden', ''); // an <svg> has no .hidden property
            uploadLabel.textContent = file.name;
        };
        reader.readAsDataURL(file);
    });

    // ---------------------------------------------------------------- deploy

    function readForm() {
        const name = nameInput.value.trim();
        const symbol = symbolInput.value.trim().toUpperCase();
        const decimalsRaw = decimalsInput.value.trim();
        const decimals = Number(decimalsRaw);
        const supply = Number(supplyInput.value);

        if (!name || !symbol) throw new Error('Enter a token name and ticker.');
        if (decimalsRaw === '' || !Number.isInteger(decimals) || decimals < 0 || decimals > 9) throw new Error('Decimals must be a whole number from 0 to 9.');
        if (!Number.isSafeInteger(supply) || supply < 1) throw new Error('Initial supply must be a whole number of at least 1.');

        const mintAmount = BigInt(supply) * 10n ** BigInt(decimals);
        if (mintAmount > U64_MAX) throw new Error('Supply is too large for this many decimals. Lower the supply or the decimals.');

        return { name, symbol, decimals, supply, mintAmount };
    }

    function setFormLocked(locked) {
        document.querySelectorAll('.form-card input, .seg-btn').forEach((node) => { node.disabled = locked; });
        uploadBox.disabled = locked;
    }

    function showResult({ title, mint, href, linkText }) {
        resultTitle.textContent = title;
        resultMint.textContent = mint;
        resultLink.href = href;
        resultLink.textContent = linkText;
        resultBox.hidden = false;
    }

    async function handleDeploy() {
        if (deploying) return;
        if (!walletPubkey || !provider) {
            setStatus('Connect your wallet first.', 'err');
            return;
        }

        let form;
        try {
            form = readForm();
        } catch (err) {
            setStatus(err.message, 'err');
            return;
        }

        deploying = true;
        resultBox.hidden = true;
        setFormLocked(true);
        renderWallet();

        let cluster = effectiveCluster();
        let signature = null;
        let mintAddress = null;
        let failedOnChain = false;

        try {
            // The wallet may have switched accounts since we last looked.
            if (provider.publicKey) walletPubkey = provider.publicKey;

            const connection = getConnection();

            // Confirm what we are actually talking to right now before asking
            // for any signature.
            setStatus('Checking network…');
            cluster = await detectCluster(connection);
            syncSeq++; // invalidate any in-flight background sync
            detectedCluster = cluster;
            const mismatch = rpcUrlInput.value.trim() !== '' && cluster !== 'unknown' && cluster !== network;
            renderNetworkUI({ mismatch });
            if (cluster === 'unknown') {
                throw new Error('This RPC reports an unrecognized network. Use the public endpoint or a provider for Devnet or Mainnet.');
            }
            if (cluster !== network) {
                throw new Error(`Your RPC is on ${CLUSTER_NAMES[cluster]}, but ${CLUSTER_NAMES[network]} is selected. Switch the toggle to match.`);
            }
            if (cluster === 'mainnet-beta' && !mainnetConfirm.checked) {
                throw new Error('Tick the Mainnet confirmation above to continue.');
            }

            setStatus('Checking your SOL balance…');
            const [balance, rent] = await Promise.all([connection.getBalance(walletPubkey), getRent(connection)]);
            // Rent for both new accounts, fees, and enough left over for the
            // wallet itself to stay rent-exempt.
            const needed = rent.total + BASE_FEE_LAMPORTS * SIGNATURES + rent.walletKeep;
            if (balance < needed) {
                throw new Error(`Not enough SOL. You need about ${sol(needed)} for rent, network fees and the minimum your wallet must keep.`);
            }

            setStatus('Building transaction…');
            const mintKeypair = Keypair.generate();
            const mint = mintKeypair.publicKey;
            mintAddress = mint.toBase58();
            const ata = getAssociatedTokenAddressSync(mint, walletPubkey);

            const tx = new Transaction();

            // 1) Create the new mint account, funded by the wallet. This is the
            //    token's own address, not a transfer destination.
            tx.add(SystemProgram.createAccount({
                fromPubkey: walletPubkey,
                newAccountPubkey: mint,
                space: MINT_SIZE,
                lamports: rent.mintRent,
                programId: TOKEN_PROGRAM_ID,
            }));
            // 2) Initialize it. The wallet is mint authority and freeze authority.
            tx.add(createInitializeMintInstruction(mint, form.decimals, walletPubkey, walletPubkey, TOKEN_PROGRAM_ID));
            // 3) The wallet's own associated token account for this mint.
            tx.add(createAssociatedTokenAccountInstruction(walletPubkey, ata, walletPubkey, mint));
            // 4) Mint the whole supply into the wallet's own token account.
            tx.add(createMintToInstruction(mint, ata, walletPubkey, form.mintAmount));
            // 5) Optional, user-requested authority revocations.
            if (revokeMintEl.checked) {
                tx.add(createSetAuthorityInstruction(mint, walletPubkey, AuthorityType.MintTokens, null));
            }
            if (revokeFreezeEl.checked) {
                tx.add(createSetAuthorityInstruction(mint, walletPubkey, AuthorityType.FreezeAccount, null));
            }

            const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
            tx.recentBlockhash = blockhash;
            tx.feePayer = walletPubkey;
            tx.partialSign(mintKeypair);

            setStatus('Approve the transaction in your wallet…');
            const signed = await provider.signTransaction(tx);

            setStatus('Sending transaction…');
            signature = await connection.sendRawTransaction(signed.serialize());

            loader.hidden = false;
            const { value } = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
            if (value.err) {
                failedOnChain = true;
                throw new Error(`Transaction failed on-chain: ${JSON.stringify(value.err)}`);
            }

            const url = solscanUrl('token', mintAddress, cluster);
            tokens.unshift({ name: form.name, symbol: form.symbol, supply: form.supply.toLocaleString(), example: false, mint: mintAddress, url });
            renderTokens();

            showResult({ title: 'Token created', mint: mintAddress, href: url, linkText: 'View on Solscan' });
            setStatus(`Created ${form.symbol}.`, 'ok');
        } catch (err) {
            console.error(err);
            if (signature) {
                // Past this point the transaction may have landed, so never
                // hide the signature or mint address from the user.
                showResult({
                    title: failedOnChain ? 'Transaction failed on-chain' : 'Sent, but not confirmed yet',
                    mint: mintAddress,
                    href: solscanUrl('tx', signature, cluster),
                    linkText: 'View transaction on Solscan',
                });
                setStatus(
                    failedOnChain
                        ? `${err.message}`
                        : `${err.message || 'Confirmation failed.'} The transaction may still land. Check Solscan before trying again.`,
                    'err',
                );
            } else {
                setStatus(err.message || 'Transaction failed or was rejected.', 'err');
            }
        } finally {
            loader.hidden = true;
            deploying = false;
            setFormLocked(false);
            renderWallet();
        }
    }

    deployBtn.addEventListener('click', handleDeploy);

    copyMintBtn.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(resultMint.textContent);
            copyMintBtn.textContent = 'Copied';
        } catch {
            copyMintBtn.textContent = 'Copy failed';
        }
        setTimeout(() => { copyMintBtn.textContent = 'Copy address'; }, 1500);
    });

    // ---------------------------------------------------------------- init

    renderTokens();
    updatePreview();
    renderWallet();
    syncNetworkState();
});
