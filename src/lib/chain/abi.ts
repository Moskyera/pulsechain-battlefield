/**
 * Minimal hand-rolled ABI encode/decode for the handful of calls this app makes.
 *
 * Pulling in a full web3 library for four function selectors and one event
 * would be dead weight; these helpers are exact for the shapes we use.
 */

/** Function selectors (first 4 bytes of keccak256 of the signature). */
export const SELECTOR = {
  token0: '0x0dfe1681',
  token1: '0xd21220a7',
  getReserves: '0x0902f1ac',
  decimals: '0x313ce567',
  symbol: '0x95d89b41',
  name: '0x06fdde03',
  totalSupply: '0x18160ddd',
  factory: '0xc45a0155',
  balanceOf: '0x70a08231',
  /** V3-style pools expose slot0()/fee() instead of getReserves(). */
  slot0: '0x3850c7bd',
  fee: '0xddca3f43',
} as const;

/** Strip 0x and return the raw hex body. */
function body(hex: string): string {
  return hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
}

/** Read the Nth 32-byte word of an ABI blob as an unsigned bigint. */
export function word(hex: string, index: number): bigint {
  const h = body(hex);
  const slice = h.slice(index * 64, index * 64 + 64);
  if (slice.length < 64) return 0n;
  return BigInt('0x' + slice);
}

/** Read the Nth 32-byte word as a lowercase 20-byte address. */
export function wordAddress(hex: string, index: number): string {
  const h = body(hex);
  const slice = h.slice(index * 64, index * 64 + 64);
  if (slice.length < 64) return '0x0000000000000000000000000000000000000000';
  return '0x' + slice.slice(24).toLowerCase();
}

/** Decode a uint8 return (e.g. `decimals()`), clamped to a sane range. */
export function decodeUint8(hex: string): number {
  const v = Number(word(hex, 0));
  return Number.isFinite(v) && v >= 0 && v <= 255 ? v : 18;
}

/**
 * Decode `getReserves()` -> (uint112 reserve0, uint112 reserve1, uint32 ts).
 * Verified against DexScreener liquidity for the WPLS/USDC pair.
 */
export function decodeReserves(hex: string): {
  reserve0: bigint;
  reserve1: bigint;
  blockTimestampLast: number;
} {
  return {
    reserve0: word(hex, 0),
    reserve1: word(hex, 1),
    blockTimestampLast: Number(word(hex, 2)),
  };
}

/**
 * Decode a solidity `string` return. Handles both the ABI-encoded dynamic
 * string and the legacy bytes32 form some older tokens still use.
 */
export function decodeString(hex: string): string {
  const h = body(hex);
  if (h.length === 0) return '';

  const asBytes = (slice: string) => {
    let out = '';
    for (let i = 0; i + 1 < slice.length; i += 2) {
      const code = parseInt(slice.slice(i, i + 2), 16);
      if (code === 0) continue;
      out += String.fromCharCode(code);
    }
    return out.replace(/[^\x20-\x7E]/g, '').trim();
  };

  // Legacy bytes32: exactly one word, not a valid offset/length pair.
  if (h.length === 64) return asBytes(h);

  try {
    const offset = Number(word(h, 0));
    if (offset % 32 !== 0) return asBytes(h.slice(0, 64));
    const lenWordIdx = offset / 32;
    const len = Number(word(h, lenWordIdx));
    if (!Number.isFinite(len) || len <= 0 || len > 256) return asBytes(h.slice(0, 64));
    const start = (lenWordIdx + 1) * 64;
    return asBytes(h.slice(start, start + len * 2));
  } catch {
    return asBytes(h.slice(0, 64));
  }
}

export interface DecodedSwapEvent {
  sender: string;
  to: string;
  amount0In: bigint;
  amount1In: bigint;
  amount0Out: bigint;
  amount1Out: bigint;
}

/**
 * Decode a Uniswap-V2 `Swap` log.
 *
 * topics = [topic0, sender (indexed), to (indexed)]
 * data   = abi.encode(amount0In, amount1In, amount0Out, amount1Out) — 128 bytes
 */
export function decodeSwapLog(log: { topics: string[]; data: string }): DecodedSwapEvent | null {
  if (!log.data || body(log.data).length < 256) return null;
  return {
    sender: log.topics[1] ? '0x' + body(log.topics[1]).slice(24).toLowerCase() : '',
    to: log.topics[2] ? '0x' + body(log.topics[2]).slice(24).toLowerCase() : '',
    amount0In: word(log.data, 0),
    amount1In: word(log.data, 1),
    amount0Out: word(log.data, 2),
    amount1Out: word(log.data, 3),
  };
}

/** Reinterpret a 256-bit word as a two's-complement signed bigint. */
export function toSigned256(v: bigint): bigint {
  return v >= 1n << 255n ? v - (1n << 256n) : v;
}

export interface DecodedSwapV3 {
  sender: string;
  recipient: string;
  /** Signed: positive = token0 entered the pool, negative = it left. */
  amount0: bigint;
  amount1: bigint;
}

/**
 * Decode a Uniswap-V3 / Algebra style `Swap` log.
 *
 * topics = [topic0, sender, recipient]
 * data   = abi.encode(int256 amount0, int256 amount1, uint160 sqrtPriceX96,
 *                     uint128 liquidity, int24 tick) — 160 bytes
 */
export function decodeSwapV3Log(log: { topics: string[]; data: string }): DecodedSwapV3 | null {
  if (!log.data || body(log.data).length < 320) return null;
  return {
    sender: log.topics[1] ? '0x' + body(log.topics[1]).slice(24).toLowerCase() : '',
    recipient: log.topics[2] ? '0x' + body(log.topics[2]).slice(24).toLowerCase() : '',
    amount0: toSigned256(word(log.data, 0)),
    amount1: toSigned256(word(log.data, 1)),
  };
}

/** Encode `balanceOf(address)` calldata. */
export function encodeBalanceOf(owner: string): string {
  return SELECTOR.balanceOf + body(owner).toLowerCase().padStart(64, '0');
}

/** Decode a Uniswap-V2 `Sync` log: data = abi.encode(reserve0, reserve1). */
export function decodeSyncLog(log: { data: string }): { reserve0: bigint; reserve1: bigint } | null {
  if (!log.data || body(log.data).length < 128) return null;
  return { reserve0: word(log.data, 0), reserve1: word(log.data, 1) };
}

/** Exact bigint -> float division by 10^decimals, without precision loss on the integer part. */
export function formatUnits(value: bigint, decimals: number): number {
  if (value === 0n) return 0;
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const frac = value % base;
  // Number(whole) is safe for every realistic token supply; the fraction is
  // added back as a float, which is all the precision a renderer needs.
  return Number(whole) + Number(frac) / Number(base);
}

/** Encode a plain no-arg call. */
export function callData(selector: string): string {
  return selector;
}
