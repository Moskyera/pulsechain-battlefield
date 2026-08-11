import { NextResponse } from 'next/server';
import { resolveBattleGroup } from '@/lib/data/group';
import { PoolNotFoundError } from '@/lib/chain/pool';
import { WAR_PRESETS } from '@/lib/chain/constants';
import type { BattleTarget } from '@/lib/data/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const isAddress = (v: string) => /^0x[0-9a-fA-F]{40}$/.test(v);

/**
 * Resolve a battlefield.
 *
 *   /api/group?war=pulse-war         -> every major PulseChain coin's pools,
 *                                        merged into one combined theatre
 *   /api/group?token=0x…&symbol=HEX  -> every liquid pool trading that token,
 *                                        across all PulseChain DEXs
 *   /api/group?pool=0x…              -> one specific pool
 *
 * Reads each pool contract on-chain (authoritative: token ordering, decimals,
 * reserve strategy, live holdings) and enriches with DexScreener USD data.
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const war = params.get('war')?.trim() ?? '';
  const token = params.get('token')?.trim() ?? '';
  const pool = params.get('pool')?.trim() ?? '';

  let target: BattleTarget;
  if (war) {
    const preset = WAR_PRESETS.find((w) => w.id === war);
    if (!preset) {
      return NextResponse.json({ error: `Unknown war preset: ${war}` }, { status: 400 });
    }
    target = {
      kind: 'war',
      id: preset.id,
      label: preset.label,
      tokens: preset.tokens.map((t) => ({ address: t.address.toLowerCase(), symbol: t.symbol })),
    };
  } else if (token) {
    if (!isAddress(token)) {
      return NextResponse.json({ error: '`token` must be a 0x address' }, { status: 400 });
    }
    target = {
      kind: 'token',
      address: token.toLowerCase(),
      symbol: params.get('symbol')?.trim().slice(0, 16) || 'TOKEN',
    };
  } else if (pool) {
    if (!isAddress(pool)) {
      return NextResponse.json({ error: '`pool` must be a 0x address' }, { status: 400 });
    }
    target = {
      kind: 'pool',
      address: pool.toLowerCase(),
      label: params.get('label')?.trim().slice(0, 32) || `${pool.slice(0, 6)}…${pool.slice(-4)}`,
    };
  } else {
    return NextResponse.json({ error: 'Provide `war`, `token` or `pool`' }, { status: 400 });
  }

  try {
    const group = await resolveBattleGroup(target);
    return NextResponse.json(group, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    const status = err instanceof PoolNotFoundError ? 404 : 502;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to resolve battlefield' },
      { status },
    );
  }
}
