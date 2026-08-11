import { NextResponse } from 'next/server';
import { fetchSubgraphPair, fetchSubgraphSwaps, fetchSubgraphHead } from '@/lib/data/subgraph';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PulseX subgraph enrichment for one pair. Polled by the client every ~6s.
 *
 * Returns indexed reserves/volume, the indexer's recent swaps (with its own USD
 * valuation), and how far behind the chain head the indexer is running.
 *
 * A failure here is never fatal: the response carries `error` and the HUD marks
 * the subgraph degraded while RPC + DexScreener carry the battlefield.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const pair = url.searchParams.get('pair')?.trim() ?? '';
  const includeSwaps = url.searchParams.get('swaps') !== '0';
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 40));

  if (!/^0x[0-9a-fA-F]{40}$/.test(pair)) {
    return NextResponse.json({ error: 'Provide `pair` as a 0x pair address' }, { status: 400 });
  }

  const [pairResult, swapsResult] = await Promise.allSettled([
    fetchSubgraphPair(pair),
    includeSwaps ? fetchSubgraphSwaps(pair, limit) : Promise.resolve(null),
  ]);

  const pairData = pairResult.status === 'fulfilled' ? pairResult.value : null;
  const swapsData = swapsResult.status === 'fulfilled' ? swapsResult.value : null;

  const errors: string[] = [];
  if (pairResult.status === 'rejected') {
    errors.push(
      pairResult.reason instanceof Error ? pairResult.reason.message : 'subgraph pair query failed',
    );
  }
  if (swapsResult.status === 'rejected') {
    errors.push(
      swapsResult.reason instanceof Error
        ? swapsResult.reason.message
        : 'subgraph swap query failed',
    );
  }

  let head: { blockNumber: number; timestamp: number; hasErrors: boolean } | null = null;
  const version = pairData?.version ?? swapsData?.version ?? null;
  if (version) {
    head = await fetchSubgraphHead(version).catch(() => null);
  }

  return NextResponse.json(
    {
      pair: pairData,
      version,
      swaps: swapsData?.swaps ?? [],
      head,
      error: errors.length ? errors.join('; ') : null,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
