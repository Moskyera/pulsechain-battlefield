import { NextResponse } from 'next/server';
import { fetchPairSnapshot, fetchTokenPairs } from '@/lib/data/dexscreener';
import type { MarketSnapshot } from '@/lib/data/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const isAddress = (v: string) => /^0x[0-9a-fA-F]{40}$/.test(v);

/**
 * Price refresh for a whole battlefield, polled every ~2.5s.
 *
 * The key property: one DexScreener request refreshes *every* enlisted pool,
 * because `/token-pairs/v1` returns all of a token's markets at once. An
 * eight-pool battlefield therefore costs the same rate-limit budget as a
 * single-pool one — roughly 24 requests/min against a 60/min ceiling, shared
 * across all connected clients by the server-side cache.
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const token = params.get('token')?.trim() ?? '';
  const pool = params.get('pool')?.trim() ?? '';

  try {
    let markets: MarketSnapshot[];

    if (token) {
      if (!isAddress(token)) {
        return NextResponse.json({ error: '`token` must be a 0x address' }, { status: 400 });
      }
      markets = await fetchTokenPairs(token);
    } else if (pool) {
      if (!isAddress(pool)) {
        return NextResponse.json({ error: '`pool` must be a 0x address' }, { status: 400 });
      }
      const one = await fetchPairSnapshot(pool);
      markets = one ? [one] : [];
    } else {
      return NextResponse.json({ error: 'Provide `token` or `pool`' }, { status: 400 });
    }

    return NextResponse.json({ markets }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    const status = (err as { status?: number })?.status === 429 ? 429 : 502;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Price refresh failed' },
      { status },
    );
  }
}
