import { NextResponse } from 'next/server';
import { searchPulseChain, fetchTokenPairs, fetchPairSnapshot } from '@/lib/data/dexscreener';
import type { MarketSnapshot } from '@/lib/data/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const isAddress = (v: string) => /^0x[0-9a-fA-F]{40}$/.test(v);

/**
 * Battlefield picker backend.
 *
 * Accepts a free-text query ("HEX", "PLSX/WPLS"), a pair address, or a token
 * address. For a bare address we can't know which it is, so we try it as a pair
 * first and fall back to listing that token's markets — which is exactly the
 * "paste anything" behaviour the picker promises.
 */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get('q')?.trim() ?? '';
  if (q.length < 2) {
    return NextResponse.json({ results: [], kind: 'empty' as const });
  }

  try {
    if (isAddress(q)) {
      const asPair = await fetchPairSnapshot(q).catch(() => null);
      if (asPair) {
        return NextResponse.json({ results: [asPair], kind: 'pair' as const });
      }

      const asToken = await fetchTokenPairs(q).catch(() => [] as MarketSnapshot[]);
      if (asToken.length > 0) {
        const results = asToken
          .slice()
          .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))
          .slice(0, 25);
        return NextResponse.json({ results, kind: 'token' as const });
      }

      return NextResponse.json({
        results: [],
        kind: 'none' as const,
        error:
          'DexScreener has no PulseChain market for that address. It may still load as a raw pair contract.',
      });
    }

    const results = (await searchPulseChain(q)).slice(0, 25);
    return NextResponse.json({ results, kind: 'search' as const });
  } catch (err) {
    return NextResponse.json(
      { results: [], kind: 'error' as const, error: err instanceof Error ? err.message : 'Search failed' },
      { status: 502 },
    );
  }
}
