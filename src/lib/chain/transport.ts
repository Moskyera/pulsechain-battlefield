/**
 * RPC transport abstraction.
 *
 * The browser never talks to a public RPC node over HTTP directly — it goes
 * through /api/rpc, which does endpoint failover, method allow-listing and
 * short-lived caching. That keeps one origin hitting the public nodes instead
 * of one per open tab, which is what keeps us inside their rate limits.
 *
 * (The WebSocket is the exception: it must be a direct browser->node socket,
 * and it is not subject to CORS.)
 */

import type { RpcRequest } from './rpc';

export type RpcTransport = (requests: RpcRequest[]) => Promise<unknown[]>;

export class TransportError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

/** Browser-side transport: batches through the app's own API route. */
export const browserRpc: RpcTransport = async (requests) => {
  if (requests.length === 0) return [];

  const res = await fetch('/battlefield/api/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requests }),
    cache: 'no-store',
  });

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) detail = body.error;
    } catch {
      /* body was not JSON — keep the status line */
    }
    throw new TransportError(detail, res.status);
  }

  const body = (await res.json()) as { results?: unknown[]; error?: string };
  if (body.error) throw new TransportError(body.error);
  return body.results ?? [];
};
