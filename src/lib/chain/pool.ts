/**
 * Reads any PulseChain AMM pool — V2-style or V3-style — straight from its
 * contract.
 *
 * PulseChain runs a mix: PulseX (V1 + V2) and 9inch are classic constant-product
 * pairs; 9mm and Liberty run V3-style concentrated liquidity; SwitchX answers
 * `getReserves()` like a V2 pair yet emits V3-shaped swap events.
 *
 * So pools are probed, not assumed:
 *   - `getReserves()` succeeds  -> read reserves from it (cheapest, exact)
 *   - `getReserves()` reverts   -> read the pool's actual token balances
 *
 * Both are real on-chain quantities. Swap *decoding* is decided separately, by
 * the shape of each log, because (see SwitchX) the two do not always agree.
 */

import {
  SELECTOR,
  decodeReserves,
  decodeString,
  decodeUint8,
  encodeBalanceOf,
  formatUnits,
  wordAddress,
} from './abi';
import { ethCall, hexToNumber, rpcBatch, rpcBatchSettled } from './rpc';
import { PULSEX_V1_FACTORY, PULSEX_V2_FACTORY, dexLabel } from './constants';
import type { PoolMeta, Reserves, TokenMeta } from '../data/types';

const ZERO = '0x0000000000000000000000000000000000000000';
const isAddress = (v: string) => /^0x[0-9a-fA-F]{40}$/.test(v);

export class PoolNotFoundError extends Error {
  constructor(address: string) {
    super(`No AMM pool contract found at ${address} on PulseChain`);
    this.name = 'PoolNotFoundError';
  }
}

function labelForFactory(factory: string | null): string | null {
  if (!factory) return null;
  const f = factory.toLowerCase();
  if (f === PULSEX_V2_FACTORY.toLowerCase()) return 'PulseX V2';
  if (f === PULSEX_V1_FACTORY.toLowerCase()) return 'PulseX V1';
  return null;
}

/**
 * Resolve one pool: token ordering, decimals, symbols, and how to read reserves.
 * Two batched round-trips regardless of pool type.
 */
export async function fetchPoolMeta(
  address: string,
  hint?: { dexId?: string; labels?: string[] },
): Promise<PoolMeta> {
  if (!isAddress(address)) throw new PoolNotFoundError(address);

  const probe = await rpcBatchSettled([
    ethCall(address, SELECTOR.token0),
    ethCall(address, SELECTOR.token1),
    ethCall(address, SELECTOR.getReserves),
    ethCall(address, SELECTOR.factory),
  ]);

  const t0Res = probe[0];
  const t1Res = probe[1];
  if (!t0Res.ok || !t1Res.ok) throw new PoolNotFoundError(address);

  const token0Addr = wordAddress(String(t0Res.result ?? ''), 0);
  const token1Addr = wordAddress(String(t1Res.result ?? ''), 0);
  if (!isAddress(token0Addr) || token0Addr === ZERO || token1Addr === ZERO) {
    throw new PoolNotFoundError(address);
  }

  // A successful getReserves() is the cheap path; a revert means V3-style, where
  // the pool's token balances are the equivalent quantity.
  const reserveMode: PoolMeta['reserveMode'] = probe[2].ok ? 'getReserves' : 'balanceOf';

  const factoryRes = probe[3];
  const factoryHex = factoryRes.ok ? String(factoryRes.result ?? '') : '';
  const factory = factoryHex.length >= 66 ? wordAddress(factoryHex, 0) : null;

  const tokenCalls = await rpcBatchSettled([
    ethCall(token0Addr, SELECTOR.decimals),
    ethCall(token0Addr, SELECTOR.symbol),
    ethCall(token1Addr, SELECTOR.decimals),
    ethCall(token1Addr, SELECTOR.symbol),
  ]);

  const readToken = (address: string, decIdx: number, symIdx: number): TokenMeta => {
    const dec = tokenCalls[decIdx];
    const sym = tokenCalls[symIdx];
    return {
      address,
      // 18 is the ERC-20 default; a token that won't answer decimals() is
      // overwhelmingly likely to be an 18dp token with a non-standard ABI.
      decimals: dec.ok ? decodeUint8(String(dec.result ?? '0x')) : 18,
      symbol: (sym.ok ? decodeString(String(sym.result ?? '')) : '') || '???',
    };
  };

  return {
    address: address.toLowerCase(),
    token0: readToken(token0Addr, 0, 1),
    token1: readToken(token1Addr, 2, 3),
    factory,
    reserveMode,
    dexId: hint?.dexId ?? 'unknown',
    dexLabel:
      labelForFactory(factory) ??
      (hint?.dexId ? dexLabel(hint.dexId, hint.labels) : 'PulseChain AMM'),
  };
}

/** Read a pool's current holdings, by whichever method its contract supports. */
export async function fetchPoolReserves(meta: PoolMeta): Promise<Reserves> {
  if (meta.reserveMode === 'getReserves') {
    const [reservesRaw, blockRaw] = await rpcBatch([
      ethCall(meta.address, SELECTOR.getReserves),
      { method: 'eth_blockNumber', params: [] },
    ]);
    const { reserve0, reserve1 } = decodeReserves(String(reservesRaw ?? '0x'));
    return {
      reserve0Raw: reserve0.toString(),
      reserve1Raw: reserve1.toString(),
      amount0: formatUnits(reserve0, meta.token0.decimals),
      amount1: formatUnits(reserve1, meta.token1.decimals),
      blockNumber: hexToNumber(blockRaw),
      fetchedAt: Date.now(),
      origin: 'eth_call',
    };
  }

  // V3-style: the pool's ERC-20 balances are what it actually holds.
  const [bal0Raw, bal1Raw, blockRaw] = await rpcBatch([
    ethCall(meta.token0.address, encodeBalanceOf(meta.address)),
    ethCall(meta.token1.address, encodeBalanceOf(meta.address)),
    { method: 'eth_blockNumber', params: [] },
  ]);

  const b0 = BigInt(String(bal0Raw ?? '0x0'));
  const b1 = BigInt(String(bal1Raw ?? '0x0'));

  return {
    reserve0Raw: b0.toString(),
    reserve1Raw: b1.toString(),
    amount0: formatUnits(b0, meta.token0.decimals),
    amount1: formatUnits(b1, meta.token1.decimals),
    blockNumber: hexToNumber(blockRaw),
    fetchedAt: Date.now(),
    origin: 'balance-of',
  };
}

/** Current head block number. */
export async function fetchBlockNumber(): Promise<number> {
  const [raw] = await rpcBatch([{ method: 'eth_blockNumber', params: [] }]);
  return hexToNumber(raw);
}
