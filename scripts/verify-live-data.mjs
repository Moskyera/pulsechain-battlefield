#!/usr/bin/env node
/**
 * Live data audit — `pnpm verify:live [tokenAddress]`
 *
 * Independently confirms that every source this app depends on is reachable and
 * returning real PulseChain data, then cross-checks them against each other:
 *
 *   - on-chain reserves reconcile with DexScreener's reported liquidity
 *   - both USD legs of each decoded swap agree (the decoder is correct)
 *   - V2 and V3 swap shapes both decode, across whichever DEXs are live
 *
 * Run it any time the battlefield looks wrong. It talks to the public endpoints
 * directly, with no Next.js server in the loop, so it isolates "the chain is
 * fine, the app is broken" from "the endpoint is down".
 */

const RPC_ENDPOINTS = [
  'https://rpc.pulsechain.com',
  'https://pulsechain-rpc.publicnode.com',
  'https://rpc-pulsechain.g4mm4.io',
];
const WS_ENDPOINTS = ['wss://pulsechain-rpc.publicnode.com', 'wss://rpc.pulsechain.com'];
const SUBGRAPHS = {
  v2: 'https://graph.pulsechain.com/subgraphs/name/pulsechain/pulsexv2',
  v1: 'https://graph.pulsechain.com/subgraphs/name/pulsechain/pulsex',
};
const DEXSCREENER = 'https://api.dexscreener.com';

const V2_SWAP = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';
const V3_SWAP = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';

/** Default focus token: WPLS. */
const TOKEN = process.argv[2] ?? '0xA1077a294dDE1B09bB078844df40758a5D0f9a27';
const MAX_POOLS = 8;

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

let failures = 0;
const ok = (label, detail = '') => console.log(`${green('  PASS')} ${label} ${dim(detail)}`);
const warn = (label, detail = '') => console.log(`${yellow('  WARN')} ${label} ${dim(detail)}`);
const fail = (label, detail = '') => {
  failures++;
  console.log(`${red('  FAIL')} ${label} ${dim(detail)}`);
};

let liveRpc = null;
async function rpc(method, params, url = liveRpc) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}
const call = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);

const word = (hex, i) => BigInt('0x' + hex.slice(2).slice(i * 64, i * 64 + 64));
const signed = (v) => (v >= 1n << 255n ? v - (1n << 256n) : v);
const addrWord = (hex) => '0x' + hex.slice(2).slice(24).toLowerCase();
function units(v, d) {
  const neg = v < 0n;
  const n = neg ? -v : v;
  const b = 10n ** BigInt(d);
  const val = Number(n / b) + Number(n % b) / Number(b);
  return neg ? -val : val;
}

console.log('\n' + '─'.repeat(72));
console.log('PulseChain Battlefield — live data audit');
console.log(`focus token: ${TOKEN}`);
console.log('─'.repeat(72));

/* ---- 1. RPC ------------------------------------------------------- */
console.log('\n[1] JSON-RPC endpoints');
let head = 0;
for (const url of RPC_ENDPOINTS) {
  try {
    const t = Date.now();
    const [block, chainId] = await Promise.all([
      rpc('eth_blockNumber', [], url),
      rpc('eth_chainId', [], url),
    ]);
    const ms = Date.now() - t;
    if (parseInt(chainId, 16) !== 369) {
      fail(url, `wrong chain id ${chainId}`);
      continue;
    }
    head = Math.max(head, parseInt(block, 16));
    liveRpc ??= url;
    ok(url, `chain 369 · block ${parseInt(block, 16).toLocaleString()} · ${ms}ms`);
  } catch (e) {
    fail(url, e.message);
  }
}
if (!liveRpc) {
  console.log(red('\nNo RPC endpoint reachable — cannot continue.\n'));
  process.exit(1);
}

/* ---- 2. DexScreener: enlist the battle group ---------------------- */
console.log('\n[2] DexScreener — battle group discovery');
let markets = [];
try {
  const res = await fetch(`${DEXSCREENER}/token-pairs/v1/pulsechain/${TOKEN}`);
  markets = await res.json();
  if (!Array.isArray(markets) || markets.length === 0) {
    fail('token-pairs lookup', 'no markets returned');
  } else {
    ok('token-pairs lookup', `${markets.length} markets on PulseChain`);
  }
} catch (e) {
  fail('token-pairs lookup', e.message);
}

const group = markets
  .filter((m) => (m.liquidity?.usd ?? 0) >= 2500)
  .filter((m) => (m.txns?.h24?.buys ?? 0) + (m.txns?.h24?.sells ?? 0) > 0)
  .sort(
    (a, b) =>
      b.txns.h24.buys + b.txns.h24.sells - (a.txns.h24.buys + a.txns.h24.sells),
  )
  .slice(0, MAX_POOLS);

if (group.length === 0) {
  console.log(red('\nNo eligible pools for this token — cannot continue.\n'));
  process.exit(1);
}

const dexes = [...new Set(group.map((m) => m.dexId))];
const totalTx = group.reduce((n, m) => n + m.txns.h24.buys + m.txns.h24.sells, 0);
const totalLiq = group.reduce((n, m) => n + (m.liquidity?.usd ?? 0), 0);
ok(
  'group assembled',
  `${group.length} pools across ${dexes.length} DEX(es): ${dexes.join(', ')}`,
);
ok(
  'group activity',
  `$${Math.round(totalLiq).toLocaleString()} liquidity · ${totalTx.toLocaleString()} trades/24h (~${(totalTx / 1440).toFixed(1)}/min)`,
);

/* ---- 3. Read every pool on-chain ---------------------------------- */
console.log('\n[3] Pool contracts (on-chain truth)');
const pools = [];
for (const m of group) {
  const address = m.pairAddress.toLowerCase();
  try {
    const token0 = addrWord(await call(address, '0x0dfe1681'));
    const token1 = addrWord(await call(address, '0xd21220a7'));
    const d0 = Number(word(await call(token0, '0x313ce567'), 0));
    const d1 = Number(word(await call(token1, '0x313ce567'), 0));

    let reserveMode = 'getReserves';
    let a0;
    let a1;
    try {
      const r = await call(address, '0x0902f1ac');
      a0 = units(word(r, 0), d0);
      a1 = units(word(r, 1), d1);
    } catch {
      reserveMode = 'balanceOf';
      const bal = async (token) =>
        word(await call(token, '0x70a08231' + address.slice(2).padStart(64, '0')), 0);
      a0 = units(await bal(token0), d0);
      a1 = units(await bal(token1), d1);
    }

    pools.push({ market: m, address, token0, token1, d0, d1, a0, a1, reserveMode });
    ok(
      `${m.dexId} ${m.baseToken.symbol}/${m.quoteToken.symbol}`,
      `${address.slice(0, 10)}… · reserves via ${reserveMode}`,
    );
  } catch (e) {
    fail(`${m.dexId} ${address.slice(0, 10)}…`, e.message);
  }
}

/* ---- 4. Reserves vs DexScreener liquidity ------------------------- */
console.log('\n[4] Cross-check: on-chain reserves vs DexScreener liquidity');
for (const p of pools) {
  const m = p.market;
  const priceUsd = parseFloat(m.priceUsd);
  const priceNative = parseFloat(m.priceNative);
  if (!Number.isFinite(priceUsd) || !Number.isFinite(priceNative) || priceNative === 0) {
    warn(`${m.dexId} ${m.baseToken.symbol}/${m.quoteToken.symbol}`, 'unpriced');
    continue;
  }
  const quoteUsd = priceUsd / priceNative;
  const baseIsT0 = m.baseToken.address.toLowerCase() === p.token0;
  const computed = baseIsT0 ? p.a0 * priceUsd + p.a1 * quoteUsd : p.a1 * priceUsd + p.a0 * quoteUsd;
  const reported = m.liquidity?.usd ?? 0;
  const drift = reported > 0 ? (Math.abs(computed - reported) / reported) * 100 : 100;
  const line = `computed $${Math.round(computed).toLocaleString()} vs reported $${Math.round(reported).toLocaleString()} (${drift.toFixed(1)}%)`;
  const name = `${m.dexId} ${m.baseToken.symbol}/${m.quoteToken.symbol}`;

  // V3 pools legitimately diverge: DexScreener reports usable depth, while raw
  // token balances include liquidity parked outside the active tick range.
  if (drift < 5) ok(name, line);
  else if (p.reserveMode === 'balanceOf') warn(`${name} (V3)`, `${line} — expected for concentrated liquidity`);
  else if (drift < 15) warn(name, line);
  else fail(name, line);
}

/* ---- 5. Swap decoding, both AMM shapes ---------------------------- */
console.log('\n[5] Swap decoding — USD legs of each trade must agree');
let v2Seen = 0;
let v3Seen = 0;
for (const p of pools) {
  const m = p.market;
  let logs = [];
  try {
    logs = await rpc('eth_getLogs', [
      {
        fromBlock: '0x' + (head - 3000).toString(16),
        toBlock: '0x' + head.toString(16),
        address: p.address,
        topics: [[V2_SWAP, V3_SWAP]],
      },
    ]);
  } catch (e) {
    fail(`${m.dexId} getLogs`, e.message);
    continue;
  }

  const name = `${m.dexId} ${m.baseToken.symbol}/${m.quoteToken.symbol}`;
  if (logs.length === 0) {
    warn(name, 'no swaps in the last 3000 blocks');
    continue;
  }

  const priceUsd = parseFloat(m.priceUsd);
  const priceNative = parseFloat(m.priceNative);
  const quoteUsd = priceUsd / priceNative;
  const baseIsT0 = m.baseToken.address.toLowerCase() === p.token0;
  const p0 = baseIsT0 ? priceUsd : quoteUsd;
  const p1 = baseIsT0 ? quoteUsd : priceUsd;

  let checked = 0;
  let worst = 0;
  for (const l of logs.slice(-10)) {
    const isV3 = l.topics[0].toLowerCase() === V3_SWAP;
    let a0;
    let a1;
    if (isV3) {
      a0 = units(signed(word(l.data, 0)), p.d0);
      a1 = units(signed(word(l.data, 1)), p.d1);
      v3Seen++;
    } else {
      a0 = units(word(l.data, 0), p.d0) - units(word(l.data, 2), p.d0);
      a1 = units(word(l.data, 1), p.d1) - units(word(l.data, 3), p.d1);
      v2Seen++;
    }
    const usd0 = Math.abs(a0 * p0);
    const usd1 = Math.abs(a1 * p1);
    if (usd0 < 1 && usd1 < 1) continue;
    worst = Math.max(worst, (Math.abs(usd0 - usd1) / Math.max(usd0, usd1)) * 100);
    checked++;
  }

  if (checked === 0) warn(name, `${logs.length} swaps, all dust`);
  else if (worst < 8)
    ok(name, `${logs.length} swaps · ${checked} priced · worst leg drift ${worst.toFixed(2)}%`);
  else fail(name, `leg drift ${worst.toFixed(2)}% — decoder or pricing is wrong`);
}
console.log(dim(`       decoded ${v2Seen} V2-shaped and ${v3Seen} V3-shaped swaps`));
if (v2Seen === 0 && v3Seen === 0) fail('swap decoding', 'no swaps decoded at all');

/* ---- 6. Subgraphs -------------------------------------------------- */
console.log('\n[6] PulseX subgraphs (PulseX pools only)');
const pulsexPool = pools.find((p) => p.market.dexId === 'pulsex');
if (!pulsexPool) {
  warn('skipped', 'no PulseX pool in this group');
} else {
  for (const [version, url] of Object.entries(SUBGRAPHS)) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: `{ _meta { block { number } } pair(id:"${pulsexPool.address}"){ id reserveUSD } }`,
        }),
      });
      const json = await res.json();
      if (json.errors) {
        warn(`${version} subgraph`, json.errors[0].message.split('\n')[0].slice(0, 80));
        continue;
      }
      const lag = head - json.data._meta.block.number;
      const has = json.data.pair
        ? `indexes it · $${Math.round(parseFloat(json.data.pair.reserveUSD)).toLocaleString()} reserves`
        : 'does not index it';
      ok(`${version} subgraph`, `block ${json.data._meta.block.number.toLocaleString()} (${lag} behind) · ${has}`);
    } catch (e) {
      warn(`${version} subgraph`, e.message);
    }
  }
}

/* ---- 7. WebSocket -------------------------------------------------- */
console.log('\n[7] WebSocket live events (20s listen across the whole group)');
const addresses = pools.map((p) => p.address);
for (const url of WS_ENDPOINTS) {
  const result = await new Promise((resolve) => {
    let swaps = 0;
    let heads = 0;
    let subscribed = false;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      return resolve({ error: e.message });
    }
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      resolve({ swaps, heads, subscribed });
    }, 20000);
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_subscribe',
          params: ['logs', { address: addresses, topics: [[V2_SWAP, V3_SWAP]] }],
        }),
      );
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_subscribe', params: ['newHeads'] }));
    };
    ws.onerror = () => {
      clearTimeout(timer);
      resolve({ error: 'handshake/connection failed' });
    };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === 1 && m.result) subscribed = true;
      if (m.method === 'eth_subscription') {
        const r = m.params?.result;
        if (r?.topics) swaps++;
        else if (r?.number) heads++;
      }
    };
  });

  if (result.error) warn(url, result.error);
  else if (!result.subscribed) fail(url, 'log subscription not confirmed');
  else if (result.heads === 0) warn(url, 'subscribed but no blocks in 20s');
  else ok(url, `${result.heads} blocks, ${result.swaps} swaps across ${addresses.length} pools in 20s`);
}

console.log('\n' + '─'.repeat(72));
if (failures === 0) {
  console.log(green('All critical checks passed — the battlefield has real data to render.'));
} else {
  console.log(red(`${failures} critical check(s) failed.`));
}
console.log('─'.repeat(72) + '\n');
process.exit(failures === 0 ? 0 : 1);
