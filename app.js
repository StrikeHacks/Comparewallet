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
]);

const SOLSCAN = (addr) => `https://solscan.io/account/${addr}`;

/* ---- Persisted settings --------------------------------------------------- */
function loadSettings() {
  $('heliusKey').value = localStorage.getItem('cw_helius') || DEFAULT_HELIUS_KEY;
  $('bitqueryKey').value = localStorage.getItem('cw_bitquery') || '';
  const mode = localStorage.getItem('cw_mode');
  if (mode) $('mode').value = mode;
  const excl = localStorage.getItem('cw_exclude');
  if (excl !== null) $('excludeKnown').checked = excl === '1';
  toggleBitqueryField();
}
function saveSettings() {
  localStorage.setItem('cw_helius', $('heliusKey').value.trim());
  localStorage.setItem('cw_bitquery', $('bitqueryKey').value.trim());
  localStorage.setItem('cw_mode', $('mode').value);
  localStorage.setItem('cw_exclude', $('excludeKnown').checked ? '1' : '0');
}

function toggleBitqueryField() {
  $('bitqueryField').hidden = $('mode').value !== 'trades';
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
  if (mode === 'holders' && !heliusKey) { alert('Enter your Helius API key in Settings.'); return; }
  if (mode === 'trades' && !bitqueryKey) { alert('Enter your Bitquery access token in Settings.'); return; }

  let threshold = parseInt($('threshold').value, 10);
  if (isNaN(threshold) || threshold < 2) threshold = 2;
  if (threshold > coins.length) threshold = coins.length;

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
  const rows = [];
  for (const [addr, w] of wallets) {
    if (w.coins.size >= threshold) rows.push({ addr, w });
  }
  rows.sort((a, b) => b.w.coins.size - a.w.coins.size || a.addr.localeCompare(b.addr));

  log(`\n✓ Done. ${rows.length} wallets appear in ≥ ${threshold} of ${coins.length} coins.`, 'ok');
  lastResults = { coins, rows, mode, decimalsByCoin };
  renderResults(lastResults);
  $('analyze').disabled = false;
}

/* ---- Rendering ------------------------------------------------------------ */
function renderResults({ coins, rows, mode, decimalsByCoin }) {
  $('resultsCard').hidden = false;
  $('resultsTitle').textContent =
    `${rows.length} overlapping wallet${rows.length === 1 ? '' : 's'} ` +
    `(${mode === 'holders' ? 'current holders' : 'all-time traders'})`;

  const thead = $('resultsTable').querySelector('thead');
  const tbody = $('resultsTable').querySelector('tbody');
  thead.innerHTML = '';
  tbody.innerHTML = '';

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td><div class="empty">No wallets met the overlap threshold. Try lowering it.</div></td></tr>`;
    return;
  }

  // Header
  const htr = document.createElement('tr');
  htr.innerHTML = `<th>#</th><th>Wallet</th><th>Coins</th><th>Which coins ${mode === 'holders' ? '(balance)' : ''}</th>`;
  thead.appendChild(htr);

  rows.forEach((row, idx) => {
    const tr = document.createElement('tr');

    const pills = coins.map((c, i) => {
      const hit = row.w.coins.has(i);
      if (!hit) return '';
      const amt = mode === 'holders' ? fmtAmount(row.w.amounts.get(i) || 0n, decimalsByCoin[i]) : '';
      return `<span class="pill hit">${escapeHtml(c.label)}${amt ? ` · ${amt}` : ''}</span>`;
    }).join('');

    tr.innerHTML =
      `<td>${idx + 1}</td>` +
      `<td class="addr"><a href="${SOLSCAN(row.addr)}" target="_blank" rel="noreferrer">${shorten(row.addr)}</a></td>` +
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
  const { coins, rows, mode, decimalsByCoin } = lastResults;
  const header = ['wallet', 'coins_count', ...coins.map((c) => c.label)];
  const lines = [header.join(',')];
  for (const row of rows) {
    const cells = [row.addr, row.w.coins.size];
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
  $('mode').addEventListener('change', toggleBitqueryField);
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
