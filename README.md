# HyperPump

Launch memecoins on Hyperliquid's **HyperEVM** and pay with **SOL**.

A user fills in a coin (name, ticker, image, socials), approves one SOL transfer in Phantom/Solflare/Backpack, and ~20 seconds later the coin is live on HyperEVM with their first buy already in their wallet. Every coin trades on a bonding curve priced in HYPE; when the curve sells out, liquidity moves into a **HyperSwap V2** pool and the LP tokens are burned.

```
 Browser ──(1) quote──────────────▶ Server ─────────────────────────┐
    │                                  │                             │
    │ (2) SOL transfer + memo          │ (3) sees FINALIZED deposit  │ (4) relayer signs createToken/buy
    ▼                                  │     on the treasury         ▼     with its own HYPE
 Solana treasury ◀─────────────────────┘                       HyperPumpFactory (HyperEVM)
                                            (5) indexer follows events → coin feed, prices, charts
                                            (6) migrator moves sold-out curves into HyperSwap V2
```

| Path | What it is |
|---|---|
| `contracts/` | `HyperPumpFactory` (bonding curves, fees, DEX migration) and `HyperPumpToken` (fixed-supply ERC-20 clone). Hardhat tests, including a suite that runs against the real mainnet WHYPE + HyperSwap V2 bytecode. |
| `server/` | Express API, SQLite (built into Node), Solana deposit watcher, crash-safe HyperEVM relayer (`txslot.js`), refund queue, event indexer, auto-migration, server-rendered share pages. |
| `public/` | The site. No framework; `public/vendor/libs.js` is a pinned local bundle (`npm run build`). |
| `scripts/` | `preflight` (go/no-go), `admin` (operator tools), `big-blocks` (HyperEVM block mode), local dev helpers. |
| `deploy/`, `Dockerfile`, `docker-compose.yml` | Production: app + Caddy with automatic HTTPS. |

## Coin economics (set in the factory)
- 1,000,000,000 fixed supply. No mint, owner, tax, or blacklist.
- 800M sold on a constant-product curve (virtual 10 HYPE / 1.0667B tokens), raising ~30 HYPE.
- At graduation: raised HYPE (minus a 1% migration fee) + the remaining 200M seed the HyperSwap V2 pair; LP goes to `0x…dEaD`. The pool opens within 2% of the curve's final price (tested).
- 1% trade fee: 0.7% protocol, 0.3% to the coin's creator (claimable with `claimFees()`). Contract hard caps: 2% trade, 5% migration.
- The owner can change fees (within caps), curve parameters for *future* launches, who may launch, and pause new launches. The owner **cannot** touch reserves, pause trading, or move anyone's tokens.
- Nobody can send tokens to a coin's future DEX pair before graduation (not even through a curve buy), so no one can seed the pool first and claim the locked liquidity.

What users pay the platform: `LAUNCH_FEE_SOL` per launch and `CONVERSION_SPREAD_BPS` on SOL→HYPE, both shown in every quote.

## How money is kept safe
- A deposit counts only when **finalized** on Solana, successful, signed by the sender, carrying the order's memo, for the **full** quoted amount, and matched by the treasury's actual balance change.
- Short or duplicate payments never touch the order: each is refunded on its own (dust below 0.00005 SOL is recorded, not refunded). Overpayments fill the order and the excess is refunded.
- The treasury watcher walks history oldest-first and saves progress per signature, so nothing is skipped even if the browser never reports the payment.
- The relayer has exactly one transaction in flight. It is saved before broadcast, re-broadcast and fee-bumped at the same nonce if slow, and never re-sent at a new nonce on a guess. If something impossible happens (our nonce used, no receipt for any of our transactions for 5 minutes), the order goes to **needs_review** for a human instead of risking a double fill.
- Every SOL owed back is one row in `refunds`, keyed by reason, sent crash-safely (signed and saved before broadcast; a new refund is only signed after the old one provably expired).
- HYPE is re-priced at fill time; if a buyer would get fewer tokens than their slippage minimum, they are refunded instead. Quotes stop if Hyperliquid's and CoinGecko's prices disagree by >3%.
- The server refuses to start payment jobs unless the Solana RPC's genesis hash and the HyperEVM chain id match the configuration.

## Launch runbook

### 1. Keys and funding (four separate wallets)
| Wallet | Chain | Needs |
|---|---|---|
| Treasury | Solana | Receives payments. Keep a small SOL float for refund fees; sweep the rest to cold storage regularly. |
| Deployer / owner | HyperEVM | HYPE to deploy. Transfer ownership to a multisig. |
| Relayer | HyperEVM | HYPE inventory that funds users' buys (+0.5 HYPE gas reserve). **Small blocks.** |
| Migrator | HyperEVM | ~1 HYPE for gas. **Big blocks** (see step 3). Must exist on HyperCore first: send it any USDC/HYPE on HyperCore. |

The relayer spends HYPE while the treasury collects SOL, so someone must rebalance (sell SOL, buy HYPE, move it to the relayer) on a schedule. Watch for `relayer.low_balance` in the logs; `/api/health` shows queues.

### 2. Deploy the contracts
```bash
cd contracts && cp .env.example .env
```
Fill in `DEPLOYER_PRIVATE_KEY`, `OWNER` (multisig), `FEE_RECIPIENT`, `LAUNCHER` (relayer address). WHYPE and HyperSwap V2 addresses are pre-filled and verified.
```bash
npm install && npx hardhat test && npm run deploy:mainnet
```
Deploying the factory costs ~2.94M gas, right at the 3M small-block limit, so put the deployer on big blocks too (`MIGRATOR_PRIVATE_KEY=<deployer key> npm run big-blocks -- on`, from the repo root). The owner multisig then calls `acceptOwnership()`. Addresses and the deploy block are written to `contracts/deployments/hyperevm.json`.

### 3. Configure the server
```bash
cp .env.example .env
```
Fill in every value. Then switch only the migrator to big blocks:
```bash
npm run big-blocks -- on
```

### 4. Check everything
```bash
npm run preflight
```
It must print **GO**. It checks networks, your https `PUBLIC_URL`, both RPCs, treasury key, factory owner/fees/launcher, the HyperSwap init-code hash against live pairs, balances, the migrator's block mode, prices, and disk.

### 5. Go live
Point your domain's DNS (A/AAAA) at the server, then:
```bash
docker compose up -d --build
```
Caddy gets the HTTPS certificate automatically and redirects `www` to the apex. Back up the `hyperpump-data` volume (database + coin images).

### Running it
- `npm run admin -- attention` lists anything needing a human: orders under review, refunds that must be sent by hand, stuck orders, unreadable deposits.
- `npm run admin -- hide <token>` removes a coin from the site (it stays on-chain).
- Logs are one JSON object per line (`docker compose logs -f app`).

### Before you open the doors (not code)
- **Audit the contracts.** They are well tested (17 contract tests, 23 server tests, two independent adversarial reviews), including against the real DEX bytecode, but unaudited.
- **Legal.** Accepting SOL and converting it is custodial. Get advice on money-transmission and securities rules where you operate, finish the Terms of use in `public/index.html`, and decide on geo-restrictions.
- **Do a real end-to-end launch yourself** with a small amount once deployed, before announcing.
- **Know the DEX's admin powers.** HyperSwap V2 pairs are a Camelot-style variant whose fee owner can (per its function names; the source is unverified) raise swap fees up to 2% and switch a pair to a stable curve, and the protocol takes a share of LP fees. Graduated coins inherit that. The only verified canonical-Uniswap-V2 alternative found on HyperEVM (NOXA, `0xec4a56061d86955d0df883efb2e5791d99ea71f2`) has almost no liquidity, so HyperSwap is the default.

## Local development
Requires Node 22.13+.
```bash
npm install && (cd contracts && npm install)
```
Start a local chain standing in for HyperEVM (leave it running):
```bash
cd contracts && npx hardhat node
```
Deploy with the real HyperSwap/WHYPE bytecode installed locally, write a dev `.env` (Solana devnet + local chain), and start:
```bash
cd contracts && MAINNET_DEX=1 npx hardhat run scripts/deploy.js --network localhost
```
```bash
npm run setup:local -- --force && npm start
```
Tests (the integration suite needs the local chain):
```bash
npm test && (cd contracts && npx hardhat test)
```
