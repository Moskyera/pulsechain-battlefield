import { NextResponse } from 'next/server';
import { rpcBatch, type RpcRequest } from '@/lib/chain/rpc';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Read-only JSON-RPC proxy for PulseChain.
 *
 * Why proxy at all: public nodes rate-limit per source IP. Routing every tab
 * through one server origin (with failover across three endpoints) is what
 * keeps a busy battlefield inside those limits.
 *
 * Only these methods are accepted. The allow-list is deliberately read-only —
 * this endpoint can never be used to relay a transaction.
 */
const ALLOWED_METHODS = new Set([
  'eth_blockNumber',
  'eth_chainId',
  'eth_call',
  'eth_getLogs',
  'eth_getBlockByNumber',
]);

const MAX_BATCH = 64;

export async function POST(req: Request) {
  let payload: { requests?: RpcRequest[] };
  try {
    payload = (await req.json()) as { requests?: RpcRequest[] };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const requests = payload.requests;
  if (!Array.isArray(requests) || requests.length === 0) {
    return NextResponse.json({ error: 'Expected a non-empty `requests` array' }, { status: 400 });
  }
  if (requests.length > MAX_BATCH) {
    return NextResponse.json(
      { error: `Batch too large: ${requests.length} > ${MAX_BATCH}` },
      { status: 413 },
    );
  }

  for (const r of requests) {
    if (typeof r?.method !== 'string' || !ALLOWED_METHODS.has(r.method)) {
      return NextResponse.json(
        { error: `Method not allowed: ${String(r?.method)}` },
        { status: 403 },
      );
    }
    if (!Array.isArray(r.params)) {
      return NextResponse.json({ error: `Missing params for ${r.method}` }, { status: 400 });
    }
  }

  try {
    const results = await rpcBatch(requests);
    return NextResponse.json(
      { results },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'RPC request failed' },
      { status: 502 },
    );
  }
}
