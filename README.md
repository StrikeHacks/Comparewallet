# 🔍 CompareWallet

A browser tool to find **wallets that overlap across multiple Solana coins** — paste 2 or more contract addresses (CAs) and instantly see which wallets are in *all* of them. Useful for spotting coordinated shillers, bundled wallets, and insiders who hop between the same coins.

> Example: give it `$YUI` (CA) and `$TRY` (CA) → it shows every wallet that is in **both**. Add more CAs to tighten the net.

No build step, no server. Just open `index.html` in your browser.

---

## Setup

1. **Get a free Helius API key** → https://dashboard.helius.dev (sign up, copy the key).
2. Open `index.html` in any modern browser (double-click it, or serve the folder).
3. Open **⚙️ Settings**, paste your Helius key, click **Save keys locally**.
   - Keys live only in your browser's `localStorage` and are sent **directly** to Helius/Bitquery — never to any third party.

## Usage

1. Paste contract addresses in the box, **one per line**. Optionally add a label:
   ```
   7xKp…mint   $YUI
   9aBc…mint   $TRY
   EgQ…mint    $ANOTHER
   ```
2. Set **"Show wallets present in at least N coins"** (defaults to 2; set it to the number of CAs to require wallets in *every* coin).
3. Click **Analyze overlap**.
4. Read the table — each row is a wallet, with a `N/total` badge and which coins it's in (with balances in holders mode). Click a wallet to open it on Solscan.
5. **Export CSV** to keep the list.

## Two data modes

| Mode | Source | What it finds | Notes |
|------|--------|---------------|-------|
| **Current holders** *(default)* | Helius `getTokenAccounts` | Wallets that **currently hold** each coin | Fast, reliable, complete snapshot. Best run while coins are actively being shilled. |
| **Trade history (Birdeye)** | Birdeye `defi/txs/token` | Wallets that **bought or sold** (the `owner` of each swap) — including wallets that already sold out | Needs a free [Birdeye API key](https://bds.birdeye.so). Scans the most recent trades (up to Birdeye's 10k cap), ~1 req/sec on the free tier so large coins take a while. |
| **Full trade history (Bitquery)** | Bitquery `DEXTrades` | Every wallet that **ever bought or sold** — including wallets that already sold out | Needs a free [Bitquery access token](https://account.bitquery.io/user/api_v2/access_tokens). Heavier; deepest history. |

**Why two modes?** On Solana, the set of *current* holders is cheap and exact to query. The set of *everyone who ever traded* (catching a shiller who already dumped) needs a full DEX-trade indexer — that's what the Bitquery mode is for. Start with Current holders; switch to Full trade history when you need past sellers too.

## Filtering down to real traders

Three layers keep the results to genuine personal trader wallets:

1. **Known-address list** — the *"Filter out known program / AMM / pool / burn addresses"* option removes liquidity pools, the pump.fun/Raydium programs, the burn address, etc. The list lives in `app.js` (`KNOWN_ADDRESSES`); add any address you want ignored.
2. **Only real trader wallets** — when enabled, each overlapping wallet is looked up via Helius `getMultipleAccounts`; anything **not owned by the System Program** (i.e. LP vaults, program-derived accounts, AMM pools) is dropped. Only normal keypair wallets survive. Needs a Helius key.
3. **Minimum SOL balance** — drops wallets holding less than the set amount of native SOL (default **5 SOL**), filtering out dust/throwaway accounts.
4. **Exclude high-frequency bots / market makers** — looks up each survivor's recent signatures via `getSignaturesForAddress`; if a wallet did **1000+ transactions within 24h** it's a bot/MM (the "buys every second" wallets), not a person, and is removed.
5. **Maximum USDC balance** — checks each survivor's USDC balance via `getTokenAccountsByOwner`; wallets holding **≥ the cap** (default **250,000 USDC**) are dropped as whales / market makers. Set to 0 to disable.

Layers 2–5 run only on the small set of wallets that already passed the overlap threshold, so they stay fast. When active, the results table and CSV gain a **SOL** column. Specific addresses can always be hard-blocked by adding them to `KNOWN_ADDRESSES` in `app.js`.

## Files

- `index.html` — UI
- `styles.css` — styling
- `app.js` — all logic (Helius + Bitquery engines, overlap, CSV export)

## Limitations & honesty

- **Current holders** is a live snapshot: a wallet that sold before you run it won't appear. Use Full trade history mode to catch those.
- Free API tiers have rate limits; very large coins (100k+ holders) take longer and are capped for safety (configurable in `app.js`).
- This is an analysis aid, **not financial advice**. On-chain heuristics can produce false positives (e.g. shared CEX/router wallets) — verify before drawing conclusions.
