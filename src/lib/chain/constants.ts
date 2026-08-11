/**
 * PulseChain network constants.
 *
 * Every address / endpoint here is a real mainnet value. Nothing in this file
 * (or anywhere in this app) fabricates market data.
 */

export const PULSECHAIN_CHAIN_ID = 369;
export const PULSECHAIN_CHAIN_ID_HEX = '0x171';

/** Approximate PulseChain block cadence, used only for block->time estimates. */
export const AVG_BLOCK_TIME_SEC = 10;

/**
 * HTTP RPC endpoints, in failover order.
 * Verified live: both answer eth_blockNumber / eth_call / eth_getLogs.
 */
export const RPC_HTTP_ENDPOINTS = [
  'https://rpc.pulsechain.com',
  'https://pulsechain-rpc.publicnode.com',
  'https://rpc-pulsechain.g4mm4.io',
] as const;

/**
 * WebSocket RPC endpoints, in failover order.
 *
 * NOTE: `wss://rpc.pulsechain.com` was verified to reject the upgrade handshake
 * at the time of writing, so publicnode is listed first. It is kept in the list
 * because it may come back, and the client transparently falls through.
 */
export const RPC_WS_ENDPOINTS = [
  'wss://pulsechain-rpc.publicnode.com',
  'wss://rpc.pulsechain.com',
  'wss://rpc-pulsechain.g4mm4.io',
] as const;

/** PulseX subgraphs. V2 is queried first, then V1 (most legacy pairs live in V1). */
export const SUBGRAPH_V2 = 'https://graph.pulsechain.com/subgraphs/name/pulsechain/pulsexv2';
export const SUBGRAPH_V1 = 'https://graph.pulsechain.com/subgraphs/name/pulsechain/pulsex';

export const DEXSCREENER_BASE = 'https://api.dexscreener.com';
export const DEXSCREENER_CHAIN = 'pulsechain';

/** PulseX routers / factories (used for provenance labelling of swap logs). */
export const PULSEX_V2_ROUTER = '0x165C3410fC91EF562C50559f7d2289fEbed552d9';
export const PULSEX_V1_ROUTER = '0x98bf93ebf5c380C0e6Ae8e192A7e2AE08edAcc02';
export const PULSEX_V2_FACTORY = '0x29eA7545DEf87022BAdc76323F373EA1e707C523';
export const PULSEX_V1_FACTORY = '0x1715a3E4A142d8b698131108995174F37aEBA10D';

/** Canonical wrapped native token. Its USD price is the PLS price. */
export const WPLS = '0xA1077a294dDE1B09bB078844df40758a5D0f9a27';

/**
 * Uniswap-V2 `Swap` event topic0.
 * Swap(address indexed sender, uint amount0In, uint amount1In,
 *      uint amount0Out, uint amount1Out, address indexed to)
 * data = 4 x uint256 = 128 bytes
 */
export const SWAP_TOPIC0 = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';

/**
 * Uniswap-V3 / Algebra style `Swap` topic0.
 * Swap(address indexed sender, address indexed recipient, int256 amount0,
 *      int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)
 * data = 5 words = 160 bytes. Amounts are SIGNED: positive means the token
 * flowed into the pool, negative means it left.
 *
 * PulseChain needs both: 9mm and liberty-swap run V3-style pools, and at least
 * one venue (switchx) answers `getReserves()` like a V2 pair while emitting
 * V3-shaped swaps. Decoding is therefore driven by the log's own shape, never
 * by what kind of pool we think it is.
 */
export const SWAP_V3_TOPIC0 = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';

/** Both swap shapes, for `topics[0]` OR-matching in eth_getLogs / eth_subscribe. */
export const ALL_SWAP_TOPICS = [SWAP_TOPIC0, SWAP_V3_TOPIC0];

/**
 * Display names for the DexScreener `dexId` values seen on PulseChain,
 * ordered roughly by observed trade count.
 */
export const DEX_LABELS: Record<string, string> = {
  pulsex: 'PulseX',
  '9mm': '9mm',
  '9inch': '9inch',
  'liberty-swap': 'Liberty',
  switchx: 'SwitchX',
  dextop: 'Dextop',
  uniswap: 'Uniswap',
  'pulse-rate': 'PulseRate',
  eazyswap: 'EazySwap',
  finvesta: 'Finvesta',
  pdex: 'PDEX',
};

export function dexLabel(dexId: string, labels?: string[]): string {
  const base = DEX_LABELS[dexId] ?? dexId;
  const version = labels?.find((l) => /^v\d$/i.test(l));
  return version ? `${base} ${version.toUpperCase()}` : base;
}

/**
 * Uniswap-V2 `Sync` event topic0 — emitted on every reserve change.
 * Sync(uint112 reserve0, uint112 reserve1)
 */
export const SYNC_TOPIC0 = '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1';

export interface PresetToken {
  symbol: string;
  address: string;
  note: string;
}

/**
 * Token battlefields — the headline mode.
 *
 * Selecting a token pulls in every liquid pool that trades it, across every
 * PulseChain DEX at once, and fights over the combined flow. PulseX alone
 * carries most of the volume, but 9mm, 9inch, Liberty and SwitchX together add
 * a large minority of trades, so an aggregated field is markedly busier than
 * any single pool.
 */
export const PRESET_TOKENS: PresetToken[] = [
  { symbol: 'WPLS', address: WPLS, note: 'Wrapped PLS · the most traded token on the chain' },
  {
    symbol: 'HEX',
    address: '0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39',
    note: 'HEX · highest trade count',
  },
  {
    symbol: 'PLSX',
    address: '0x95B303987A60C71504D99Aa1b13B4DA07b0790ab',
    note: 'PulseX token · deepest liquidity',
  },
  {
    symbol: 'INC',
    address: '0x2fa878Ab3F87CC1C9737Fc071108F904c0B0C95d',
    note: 'Incentive token',
  },
  {
    symbol: 'PRVX',
    address: '0xF6f8Db0aBa00007681F8fAF16A0FDa1c9B030b11',
    note: 'ProveX · deepest book is PRVX/USDC on PulseX',
  },
];

/**
 * Combined-theatre presets.
 *
 * Token order is priority order: when a pool holds two of the war's tokens
 * (HEX/WPLS, say) the higher-priority one decides which side the trade counts
 * for, so every pool has exactly one well-defined reading.
 *
 * WPLS is listed last on purpose — it is the chain's base trading currency, so
 * in an X/WPLS pool the interesting question is what happened to X.
 */
export const WAR_PRESETS: { id: string; label: string; note: string; tokens: PresetToken[] }[] = [
  {
    id: 'pulse-war',
    label: 'GRAND WAR',
    note: 'Every major PulseChain coin fighting in one theatre',
    tokens: [
      { symbol: 'HEX', address: '0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39', note: 'HEX' },
      { symbol: 'eHEX', address: '0x57fde0a71132198BBeC939B98976993d8D89D225', note: 'HEX from Ethereum' },
      { symbol: 'PLSX', address: '0x95B303987A60C71504D99Aa1b13B4DA07b0790ab', note: 'PulseX' },
      { symbol: 'INC', address: '0x2fa878Ab3F87CC1C9737Fc071108F904c0B0C95d', note: 'Incentive' },
      { symbol: 'PCOCK', address: '0xc10A4Ed9b4042222d69ff0B374eddd47ed90fC1F', note: 'Peacock' },
      { symbol: 'PRVX', address: '0xF6f8Db0aBa00007681F8fAF16A0FDa1c9B030b11', note: 'ProveX' },
      { symbol: 'PLS', address: WPLS, note: 'Wrapped PLS' },
    ],
  },
];

export interface PresetPair {
  label: string;
  address: string;
  note: string;
}

/**
 * Default battlefields. Each address was verified live against DexScreener,
 * the PulseX V1 subgraph, and on-chain `getReserves()`.
 */
export const PRESET_PAIRS: PresetPair[] = [
  {
    label: 'WPLS / USDC',
    address: '0x6753560538ECa67617A9Ce605178F788bE7E524E',
    note: 'PulseX · deepest stable book',
  },
  {
    label: 'HEX / WPLS',
    address: '0xf1F4ee610b2bAbB05C635F726eF8B0C568c8dc65',
    note: 'PulseX · highest trade count',
  },
  {
    label: 'PLSX / WPLS',
    address: '0x1b45b9148791d3a104184Cd5DFE5CE57193a3ee9',
    note: 'PulseX · deepest liquidity',
  },
  {
    label: 'INC / WPLS',
    address: '0xf808Bb6265e9Ca27002c0A04562Bf50d4FE37EAA',
    note: 'PulseX · incentive token',
  },
  {
    label: 'WPLS / DAI',
    address: '0xE56043671df55dE5CDf8459710433C10324DE0aE',
    note: 'PulseX · stable pair',
  },
  {
    label: 'PRVX / USDC',
    address: '0x7f681a5aD615238357bA148C281E2EAEfd2dE55A',
    note: 'PulseX · ProveX deepest book',
  },
];

export const EXPLORER_TX = 'https://midgard.wtf/tx/';
export const EXPLORER_ADDRESS = 'https://midgard.wtf/address/';
