/* ===========================================================================
 * CompareWallet — find wallets that overlap across multiple Solana coins.
 *
 * Two data engines:
 *   - "holders"  : current token holders via Helius DAS getTokenAccounts.
 *   - "trades"   : every wallet that ever bought/sold via Bitquery DEXTrades
 *                  (also catches wallets that have already fully sold out).
 *
 * All requests go straight from the browser to Helius / Bitquery.
 * ===========================================================================*/

'use strict';

const $ = (id) => document.getElementById(id);

/* Default Helius key (repo is private). Override anytime in Settings. */
const DEFAULT_HELIUS_KEY = '235607da-5b6f-46c2-9957-a21f2b6306ca';
/* A mint that always has holders, used by the "Test connection" button. */
const TEST_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC

/* ---- Known non-wallet addresses to optionally filter out (noise) ---------- */
const KNOWN_ADDRESSES = new Set([
  '11111111111111111111111111111111',               // System program
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',    // SPL Token program
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',   // Associated Token program
  '1nc1nerator11111111111111111111111111111111',    // Incinerator (burn)
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',    // pump.fun program
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j',    // Raydium AMM Authority V4
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',    // Raydium CPMM
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',    // Raydium Liquidity Pool V4
  'AdduY3tfV1KX5gDgw4SrMrtbS8aaH9pJzhx9YjpqHnXp',    // (common router)
  '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',    // Common CEX / hot wallet
  'HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC',    // Market-maker / bot (user-reported)
  'BM9CcyErJcu2mjrFvUsRRrD3snGeHDDVirJLvL6EjvMN',    // Market-maker / bot (user-reported)
]);

const SOLSCAN = (addr) => `https://solscan.io/account/${addr}`;

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const LAMPORTS_PER_SOL = 1_000_000_000;
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/* ---- Persisted settings --------------------------------------------------- */
function loadSettings() {
  $('heliusKey').value = localStorage.getItem('cw_helius') || DEFAULT_HELIUS_KEY;
  $('bitqueryKey').value = localStorage.getItem('cw_bitquery') || '';
  $('birdeyeKey').value = localStorage.getItem('cw_birdeye') || '';
  const mode = localStorage.getItem('cw_mode');
  if (mode) $('mode').value = mode;
  const excl = localStorage.getItem('cw_exclude');
  if (excl !== null) $('excludeKnown').checked = excl === '1';
  const minSol = localStorage.getItem('cw_minsol');
  if (minSol !== null) $('minSol').value = minSol;
  const maxUsdc = localStorage.getItem('cw_maxusdc');
  if (maxUsdc !== null) $('maxUsdc').value = maxUsdc;
  const onlyReal = localStorage.getItem('cw_onlyreal');
  if (onlyReal !== null) $('onlyReal').checked = onlyReal === '1';
  const exclBots = localStorage.getItem('cw_excludebots');
  if (exclBots !== null) $('excludeBots').checked = exclBots === '1';
  toggleKeyFields();
}
function saveSettings() {
  localStorage.setItem('cw_helius', $('heliusKey').value.trim());
  localStorage.setItem('cw_bitquery', $('bitqueryKey').value.trim());
  localStorage.setItem('cw_birdeye', $('birdeyeKey').value.trim());
  localStorage.setItem('cw_mode', $('mode').value);
  localStorage.setItem('cw_exclude', $('excludeKnown').checked ? '1' : '0');
  localStorage.setItem('cw_minsol', $('minSol').value);
  localStorage.setItem('cw_maxusdc', $('maxUsdc').value);
  localStorage.setItem('cw_onlyreal', $('onlyReal').checked ? '1' : '0');
  localStorage.setItem('cw_excludebots', $('excludeBots').checked ? '1' : '0');
}

function toggleKeyFields() {
  const mode = $('mode').value;
  $('bitqueryField').hidden = mode !== 'trades';
  $('birdeyeField').hidden = mode !== 'birdeye';
}

/* ---- Logging -------------------------------------------------------------- */
function log(msg, cls) {
  const el = $('log');
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = msg;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}
function resetLog() {
  $('log').textContent = '';
  $('progressCard').hidden = false;
}

/* ---- Input parsing -------------------------------------------------------- */
// Each line: "<mint> [optional label]". Label = remainder after first space/comma/tab.
function parseInputs() {
  const lines = $('cas').value.split('\n').map((l) => l.trim()).filter(Boolean);
  const coins = [];
  const seen = new Set();
  for (const line of lines) {
    const m = line.match(/^([1-9A-HJ-NP-Za-km-z]{32,44})(?:[\s,]+(.*))?$/);
    if (!m) {
      log(`Skipping line (not a valid Solana address): ${line}`, 'warn');
      continue;
    }
    const mint = m[1];
    if (seen.has(mint)) continue;
    seen.add(mint);
    const label = (m[2] || '').trim() || shorten(mint);
    coins.push({ mint, label });
  }
  return coins;
}

function shorten(addr) {
  return addr.length > 12 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr;
}

/* ===========================================================================
 * Engine 1 — current holders via Helius DAS getTokenAccounts
 * ===========================================================================*/
async function heliusRpc(apiKey, method, params) {
  const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'cw', method, params }),
  });
  if (!res.ok) throw new Error(`Helius HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
  return json.result;
}

async function getDecimals(apiKey, mint) {
  try {
    const r = await heliusRpc(apiKey, 'getTokenSupply', [mint]);
    return r?.value?.decimals ?? 0;
  } catch {
    return 0;
  }
}

// Returns Map(owner -> rawAmount BigInt) of current holders.
async function fetchHolders(apiKey, mint, label) {
  const owners = new Map();
  let page = 1;
  const limit = 1000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await heliusRpc(apiKey, 'getTokenAccounts', { mint, page, limit });
    const accounts = result?.token_accounts || [];
    if (accounts.length === 0) break;
    for (const a of accounts) {
      if (!a.owner) continue;
      const amt = BigInt(String(a.amount ?? '0'));
      owners.set(a.owner, (owners.get(a.owner) || 0n) + amt);
    }
    log(`  ${label}: page ${page} → ${accounts.length} accounts (${owners.size} unique owners so far)`);
    if (accounts.length < limit) break;
    page += 1;
    if (page > 200) { log('  Stopping at 200 pages safety cap.', 'warn'); break; }
    await sleep(120);
  }
  return owners;
}

/* ===========================================================================
 * Engine 2 — full buy/sell history via Bitquery DEXTrades
 * ===========================================================================*/
async function fetchTraders(token, mint, label) {
  const query = `query ($mint: String!, $limit: Int!, $offset: Int!) {
    Solana {
      DEXTrades(
        limit: { count: $limit, offset: $offset }
        orderBy: { descending: Block_Time }
        where: { Trade: { Currency: { MintAddress: { is: $mint } } } }
      ) {
        Trade {
          Account { Address Owner }
          Side { Account { Address Owner } }
        }
      }
    }
  }`;

  const wallets = new Map(); // owner/address -> placeholder amount (0n; trades has no balance)
  const pageSize = 5000;
  let offset = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await fetch('https://streaming.bitquery.io/eap', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query, variables: { mint, limit: pageSize, offset } }),
    });
    if (!res.ok) throw new Error(`Bitquery HTTP ${res.status}`);
    const json = await res.json();
    if (json.errors) throw new Error(json.errors.map((e) => e.message).join('; '));
    const trades = json?.data?.Solana?.DEXTrades || [];
    if (trades.length === 0) break;
    for (const t of trades) {
      const a = t.Trade?.Account;
      const b = t.Trade?.Side?.Account;
      const w1 = a?.Owner || a?.Address;
      const w2 = b?.Owner || b?.Address;
      if (w1) wallets.set(w1, 0n);
      if (w2) wallets.set(w2, 0n);
    }
    log(`  ${label}: fetched ${trades.length} trades (offset ${offset}) → ${wallets.size} unique traders`);
    if (trades.length < pageSize) break;
    offset += pageSize;
    if (offset >= 100000) { log('  Stopping at 100k trades safety cap.', 'warn'); break; }
    await sleep(250);
  }
  return wallets;
}

/* ===========================================================================
 * Engine 3 — trade history via Birdeye /defi/txs/token
 * Collects the `owner` (trader wallet) of every swap on the token, so it
 * captures wallets that have already sold out.
 * ===========================================================================*/
async function fetchTradersBirdeye(apiKey, mint, label) {
  const wallets = new Map();
  const limit = 50; // Birdeye max page size for this endpoint
  let offset = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const url = `https://public-api.birdeye.so/defi/txs/token?address=${encodeURIComponent(mint)}` +
                `&offset=${offset}&limit=${limit}&tx_type=swap&sort_type=desc`;
    let res;
    try {
      res = await fetch(url, {
        headers: { 'X-API-KEY': apiKey, 'x-chain': 'solana', accept: 'application/json' },
      });
    } catch (e) {
      throw new Error('Could not reach Birdeye (network/CORS). If this is a CORS error, ' +
        'Birdeye is blocking browser calls for your key/plan — tell me and I will add a proxy step. ' +
        `(${e.message})`);
    }
    if (res.status === 429) { log('  Rate limited — waiting 3s…', 'warn'); await sleep(3000); continue; }
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Birdeye rejected the API key (HTTP ${res.status}). Check the key, or this ` +
        'endpoint may need a higher Birdeye plan.');
    }
    if (!res.ok) throw new Error(`Birdeye HTTP ${res.status}`);
    const json = await res.json();
    if (json.success === false) throw new Error(json.message || 'Birdeye request failed');
    const items = json?.data?.items || [];
    if (items.length === 0) break;
    for (const it of items) {
      const w = it.owner || it.from?.owner || it.to?.owner;
      if (w) wallets.set(w, 0n);
    }
    log(`  ${label}: ${offset + items.length} trades scanned → ${wallets.size} unique traders`);
    const hasNext = json?.data?.hasNext;
    if (hasNext === false || items.length < limit) break;
    offset += limit;
    // Birdeye caps offset+limit at 10000 for this endpoint.
    if (offset >= 10000) { log('  Reached Birdeye 10k-trade cap (most recent trades).', 'warn'); break; }
    await sleep(1100); // free tier ≈ 1 request/second
  }
  return wallets;
}

/* ===========================================================================
 * Wallet enrichment — SOL balance + account owner, to keep only real
 * person-controlled trader wallets (and drop LP pools / vaults / programs).
 * Runs only on the small overlap candidate set, batched via getMultipleAccounts.
 * ===========================================================================*/
async function enrichWallets(apiKey, addresses) {
  const info = new Map(); // addr -> { lamports: BigInt, owner: string|null }
  const batchSize = 100;
  for (let i = 0; i < addresses.length; i += batchSize) {
    const batch = addresses.slice(i, i + batchSize);
    const res = await heliusRpc(apiKey, 'getMultipleAccounts', [batch, { encoding: 'base64' }]);
    const vals = res?.value || [];
    batch.forEach((addr, j) => {
      const v = vals[j];
      info.set(addr, v
        ? { lamports: BigInt(v.lamports || 0), owner: v.owner }
        : { lamports: 0n, owner: null });
    });
    log(`  checked ${Math.min(i + batchSize, addresses.length)}/${addresses.length} wallets`);
    await sleep(120);
  }
  return info;
}

/* Detects high-frequency bots / market makers: a wallet that did `maxTx`
 * transactions inside `windowHours` is not a person. Returns true if bot-like. */
async function isHighFrequency(apiKey, addr, maxTx = 1000, windowHours = 24) {
  const sigs = await heliusRpc(apiKey, 'getSignaturesForAddress', [addr, { limit: maxTx }]);
  if (!Array.isArray(sigs) || sigs.length < maxTx) return false; // fewer than maxTx total → not hyperactive
  const times = sigs.map((s) => s.blockTime).filter(Boolean);
  if (times.length < 2) return false;
  const spanHours = (Math.max(...times) - Math.min(...times)) / 3600;
  return spanHours < windowHours;
}

/* Returns a wallet's total USDC balance (uiAmount) across its token accounts. */
async function getUsdcBalance(apiKey, addr) {
  const res = await heliusRpc(apiKey, 'getTokenAccountsByOwner',
    [addr, { mint: USDC_MINT }, { encoding: 'jsonParsed' }]);
  let total = 0;
  for (const a of res?.value || []) {
    const ui = a?.account?.data?.parsed?.info?.tokenAmount?.uiAmount;
    if (typeof ui === 'number') total += ui;
  }
  return total;
}

/* ---- Helpers -------------------------------------------------------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmtAmount(raw, decimals) {
  if (raw === 0n) return '';
  if (!decimals) return raw.toString();
  const s = raw.toString().padStart(decimals + 1, '0');
  const intPart = s.slice(0, -decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = s.slice(-decimals).replace(/0+$/, '').slice(0, 4);
  return frac ? `${intPart}.${frac}` : intPart;
}

/* ===========================================================================
 * Main analysis
 * ===========================================================================*/
let lastResults = null;

async function analyze() {
  const coins = parseInputs();
  const mode = $('mode').value;
  const excludeKnown = $('excludeKnown').checked;

  if (coins.length < 2) {
    alert('Please enter at least 2 valid contract addresses (one per line).');
    return;
  }

  const heliusKey = $('heliusKey').value.trim();
  const bitqueryKey = $('bitqueryKey').value.trim();
  const birdeyeKey = $('birdeyeKey').value.trim();
  if (mode === 'holders' && !heliusKey) { alert('Enter your Helius API key in Settings.'); return; }
  if (mode === 'trades' && !bitqueryKey) { alert('Enter your Bitquery access token in Settings.'); return; }
  if (mode === 'birdeye' && !birdeyeKey) { alert('Enter your Birdeye API key in Settings.'); return; }

  let threshold = parseInt($('threshold').value, 10);
  if (isNaN(threshold) || threshold < 2) threshold = 2;
  if (threshold > coins.length) threshold = coins.length;

  let minSol = parseFloat($('minSol').value);
  if (isNaN(minSol) || minSol < 0) minSol = 0;
  let maxUsdc = parseFloat($('maxUsdc').value);
  if (isNaN(maxUsdc) || maxUsdc < 0) maxUsdc = 0; // 0 = no cap
  const onlyReal = $('onlyReal').checked;
  const excludeBots = $('excludeBots').checked;

  $('analyze').disabled = true;
  resetLog();
  $('resultsCard').hidden = true;
  log(`Analyzing ${coins.length} coins in "${mode}" mode…`);

  // wallet -> { coinsHit: Set(index), amounts: Map(index -> raw BigInt) }
  const wallets = new Map();
  const decimalsByCoin = [];

  try {
    for (let i = 0; i < coins.length; i++) {
      const { mint, label } = coins[i];
      log(`\n▶ ${label}  (${mint})`);
      let owners;
      let decimals = 0;
      if (mode === 'holders') {
        decimals = await getDecimals(heliusKey, mint);
        owners = await fetchHolders(heliusKey, mint, label);
      } else if (mode === 'birdeye') {
        owners = await fetchTradersBirdeye(birdeyeKey, mint, label);
      } else {
        owners = await fetchTraders(bitqueryKey, mint, label);
      }
      decimalsByCoin[i] = decimals;
      log(`  ✓ ${label}: ${owners.size} wallets`, 'ok');

      for (const [owner, amount] of owners) {
        if (excludeKnown && KNOWN_ADDRESSES.has(owner)) continue;
        let w = wallets.get(owner);
        if (!w) { w = { coins: new Set(), amounts: new Map() }; wallets.set(owner, w); }
        w.coins.add(i);
        w.amounts.set(i, amount);
      }
    }
  } catch (err) {
    log(`\n✗ Error: ${err.message}`, 'err');
    $('analyze').disabled = false;
    return;
  }

  // Filter by threshold and sort by overlap count desc.
  let rows = [];
  for (const [addr, w] of wallets) {
    if (w.coins.size >= threshold) rows.push({ addr, w });
  }
  rows.sort((a, b) => b.w.coins.size - a.w.coins.size || a.addr.localeCompare(b.addr));
  log(`\n✓ ${rows.length} wallets appear in ≥ ${threshold} of ${coins.length} coins.`, 'ok');

  // Keep only real trader wallets with enough SOL (and no high-frequency bots).
  let enriched = false;
  if ((minSol > 0 || onlyReal || excludeBots || maxUsdc > 0) && rows.length > 0) {
    if (!heliusKey) {
      log('Skipping SOL / wallet-type / bot / USDC filter — needs a Helius key in Settings.', 'warn');
    } else {
      try {
        log(`\nChecking SOL balance & wallet type for ${rows.length} candidates…`);
        const info = await enrichWallets(heliusKey, rows.map((r) => r.addr));
        const minLamports = BigInt(Math.round(minSol * LAMPORTS_PER_SOL));
        let kept = [];
        let droppedType = 0;
        let droppedSol = 0;
        for (const row of rows) {
          const v = info.get(row.addr) || { lamports: 0n, owner: null };
          row.sol = Number(v.lamports) / LAMPORTS_PER_SOL;
          if (onlyReal && v.owner !== SYSTEM_PROGRAM) { droppedType++; continue; } // LP/vault/program/PDA
          if (v.lamports < minLamports) { droppedSol++; continue; }
          kept.push(row);
        }
        enriched = true;
        log(`  Kept ${kept.length}. Dropped ${droppedType} non-personal (LP/program) and ` +
            `${droppedSol} below ${minSol} SOL.`, 'ok');

        // Behavioural pass on the survivors: USDC whale cap + bot/MM activity.
        if ((excludeBots || maxUsdc > 0) && kept.length > 0) {
          log(`\nChecking ${kept.length} wallets` +
              `${maxUsdc > 0 ? ` for USDC ≥ ${maxUsdc.toLocaleString('en-US')}` : ''}` +
              `${excludeBots ? `${maxUsdc > 0 ? ' and' : ' for'} bot-like activity (1000+ tx/24h)` : ''}…`);
          const human = [];
          let droppedBots = 0;
          let droppedWhales = 0;
          for (const row of kept) {
            await sleep(120);
            // USDC whale check
            if (maxUsdc > 0) {
              try {
                row.usdc = await getUsdcBalance(heliusKey, row.addr);
                if (row.usdc >= maxUsdc) {
                  droppedWhales++;
                  log(`  ✗ ${shorten(row.addr)} holds ${row.usdc.toLocaleString('en-US')} USDC — removed`, 'warn');
                  continue;
                }
              } catch (e) { log(`  ${shorten(row.addr)}: USDC check failed (${e.message})`, 'warn'); }
            }
            // bot / market-maker check
            if (excludeBots) {
              let bot = false;
              try { bot = await isHighFrequency(heliusKey, row.addr); }
              catch (e) { log(`  ${shorten(row.addr)}: activity check failed (${e.message})`, 'warn'); }
              if (bot) { droppedBots++; log(`  ✗ ${shorten(row.addr)} looks like a bot/MM — removed`, 'warn'); continue; }
            }
            human.push(row);
          }
          kept = human;
          log(`  Removed ${droppedWhales} USDC whales and ${droppedBots} bot/MM wallets.`, 'ok');
        }

        rows = kept;
      } catch (err) {
        log(`  Filter failed: ${err.message}`, 'err');
      }
    }
  }

  log(`\n✓ Done. ${rows.length} wallets match all filters.`, 'ok');
  lastResults = { coins, rows, mode, decimalsByCoin, enriched };
  renderResults(lastResults);
  $('analyze').disabled = false;
}

/* ---- Rendering ------------------------------------------------------------ */
function renderResults({ coins, rows, mode, decimalsByCoin, enriched }) {
  $('resultsCard').hidden = false;
  $('resultsTitle').textContent =
    `${rows.length} matching wallet${rows.length === 1 ? '' : 's'} ` +
    `(${mode === 'holders' ? 'current holders' : 'traders'})`;

  const thead = $('resultsTable').querySelector('thead');
  const tbody = $('resultsTable').querySelector('tbody');
  thead.innerHTML = '';
  tbody.innerHTML = '';

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td><div class="empty">No wallets matched. Try lowering the overlap threshold or the minimum SOL.</div></td></tr>`;
    return;
  }

  // Header
  const htr = document.createElement('tr');
  htr.innerHTML = `<th>#</th><th>Wallet</th>${enriched ? '<th>SOL</th>' : ''}<th>Coins</th>` +
    `<th>Which coins ${mode === 'holders' ? '(balance)' : ''}</th>`;
  thead.appendChild(htr);

  rows.forEach((row, idx) => {
    const tr = document.createElement('tr');

    const pills = coins.map((c, i) => {
      const hit = row.w.coins.has(i);
      if (!hit) return '';
      const amt = mode === 'holders' ? fmtAmount(row.w.amounts.get(i) || 0n, decimalsByCoin[i]) : '';
      return `<span class="pill hit">${escapeHtml(c.label)}${amt ? ` · ${amt}` : ''}</span>`;
    }).join('');

    const solCell = enriched
      ? `<td>${row.sol != null ? row.sol.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—'}</td>`
      : '';

    tr.innerHTML =
      `<td>${idx + 1}</td>` +
      `<td class="addr"><a href="${SOLSCAN(row.addr)}" target="_blank" rel="noreferrer">${shorten(row.addr)}</a></td>` +
      solCell +
      `<td><span class="count-badge">${row.w.coins.size}/${coins.length}</span></td>` +
      `<td>${pills}</td>`;
    tbody.appendChild(tr);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---- CSV export ----------------------------------------------------------- */
function exportCsv() {
  if (!lastResults || lastResults.rows.length === 0) return;
  const { coins, rows, mode, decimalsByCoin, enriched } = lastResults;
  const header = ['wallet', 'coins_count', ...(enriched ? ['sol_balance'] : []), ...coins.map((c) => c.label)];
  const lines = [header.join(',')];
  for (const row of rows) {
    const cells = [row.addr, row.w.coins.size];
    if (enriched) cells.push(row.sol != null ? row.sol.toFixed(3) : '');
    coins.forEach((c, i) => {
      if (!row.w.coins.has(i)) { cells.push(''); return; }
      cells.push(mode === 'holders' ? fmtAmount(row.w.amounts.get(i) || 0n, decimalsByCoin[i]).replace(/,/g, '') : 'yes');
    });
    lines.push(cells.map(csvCell).join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `comparewallet_overlap_${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
function csvCell(v) {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/* ---- Wire up -------------------------------------------------------------- */
document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  $('mode').addEventListener('change', toggleKeyFields);
  $('saveKeys').addEventListener('click', () => {
    saveSettings();
    $('saveKeys').textContent = '✓ Saved';
    setTimeout(() => ($('saveKeys').textContent = 'Save keys locally'), 1500);
  });
  $('analyze').addEventListener('click', () => { saveSettings(); analyze(); });
  $('exportCsv').addEventListener('click', exportCsv);
  $('testConn').addEventListener('click', testConnection);
});

/* ---- Test connection ------------------------------------------------------ */
async function testConnection() {
  const out = $('testResult');
  const key = $('heliusKey').value.trim();
  if (!key) { out.textContent = 'Enter a Helius key first.'; out.className = 'test-result err'; return; }
  out.textContent = 'Testing…'; out.className = 'test-result';
  $('testConn').disabled = true;
  try {
    const t0 = performance.now();
    const supply = await heliusRpc(key, 'getTokenSupply', [TEST_MINT]);
    const accts = await heliusRpc(key, 'getTokenAccounts', { mint: TEST_MINT, page: 1, limit: 1 });
    const ms = Math.round(performance.now() - t0);
    const ok = supply?.value && Array.isArray(accts?.token_accounts);
    if (ok) {
      out.textContent = `✓ Connected — Helius key works (getTokenSupply + getTokenAccounts OK, ${ms}ms).`;
      out.className = 'test-result ok';
    } else {
      out.textContent = '⚠ Connected but unexpected response — getTokenAccounts (DAS) may not be enabled on this key.';
      out.className = 'test-result warn';
    }
  } catch (err) {
    out.textContent = `✗ ${err.message}`;
    out.className = 'test-result err';
  } finally {
    $('testConn').disabled = false;
  }
}
