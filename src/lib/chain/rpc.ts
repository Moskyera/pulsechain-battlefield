/**
 * JSON-RPC client for PulseChain with endpoint failover, request batching and
 * exponential backoff.
 *
 * Used on both sides of the app:
 *  - server side, from /api/rpc (which is what the browser talks to, so public
 *    endpoints see one origin instead of one-per-tab),
 *  - directly, from scripts/verify-live-data.mjs.
 */

import { RPC_HTTP_ENDPOINTS } from './constants';

export interface RpcRequest {
  method: string;
  params: unknown[];
}

interface JsonRpcEnvelope {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: unknown[];
}

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

/** Endpoints are rotated on failure so a single flaky node cannot stall the app. */
let endpointCursor = 0;

const DEFAULT_TIMEOUT_MS = 12_000;

async function postBatch(
  endpoint: string,
  payload: JsonRpcEnvelope[],
  timeoutMs: number,
): Promise<JsonRpcResponse[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload.length === 1 ? payload[0] : payload),
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!res.ok) {
      throw new RpcError(`${endpoint} responded ${res.status}`, res.status);
    }
    const json = (await res.json()) as JsonRpcResponse | JsonRpcResponse[];
    return Array.isArray(json) ? json : [json];
  } finally {
    clearTimeout(timer);
  }
}

export type SettledRpc =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

/**
 * Execute a batch and report each call's outcome independently.
 *
 * Needed because a reverting `eth_call` is a legitimate, informative answer —
 * `getReserves()` reverting is exactly how we discover a pool is V3-style.
 * Treating that as a transport failure would rotate endpoints and retry a call
 * that is deterministically going to revert everywhere.
 *
 * Transport-level failures still trigger endpoint failover; only per-call
 * errors are passed through.
 */
export async function rpcBatchSettled(
  requests: RpcRequest[],
  opts: { timeoutMs?: number; attempts?: number } = {},
): Promise<SettledRpc[]> {
  if (requests.length === 0) return [];

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const attempts = opts.attempts ?? RPC_HTTP_ENDPOINTS.length * 2;

  const payload: JsonRpcEnvelope[] = requests.map((r, i) => ({
    jsonrpc: '2.0',
    id: i + 1,
    method: r.method,
    params: r.params,
  }));

  let lastError: unknown = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const endpoint = RPC_HTTP_ENDPOINTS[endpointCursor % RPC_HTTP_ENDPOINTS.length];
    try {
      const responses = await postBatch(endpoint, payload, timeoutMs);
      const byId = new Map<number, JsonRpcResponse>();
      for (const r of responses) byId.set(r.id, r);

      return payload.map((p): SettledRpc => {
        const r = byId.get(p.id);
        if (!r) return { ok: false, error: `missing response for ${p.method}` };
        if (r.error) return { ok: false, error: r.error.message };
        return { ok: true, result: r.result };
      });
    } catch (err) {
      lastError = err;
      endpointCursor++;
      if (attempt > 0 && attempt % RPC_HTTP_ENDPOINTS.length === 0) {
        await new Promise((r) => setTimeout(r, Math.min(2000, 200 * 2 ** attempt)));
      }
    }
  }

  throw new RpcError(
    `all RPC endpoints failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

/**
 * Execute a batch of JSON-RPC calls. Results are returned in the same order as
 * the requests. Throws if any individual call errors, or when every endpoint
 * has been exhausted. Use `rpcBatchSettled` when a revert is an expected answer.
 */
export async function rpcBatch(
  requests: RpcRequest[],
  opts: { timeoutMs?: number; attempts?: number } = {},
): Promise<unknown[]> {
  if (requests.length === 0) return [];

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const attempts = opts.attempts ?? RPC_HTTP_ENDPOINTS.length * 2;

  const payload: JsonRpcEnvelope[] = requests.map((r, i) => ({
    jsonrpc: '2.0',
    id: i + 1,
    method: r.method,
    params: r.params,
  }));

  let lastError: unknown = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const endpoint = RPC_HTTP_ENDPOINTS[endpointCursor % RPC_HTTP_ENDPOINTS.length];
    try {
      const responses = await postBatch(endpoint, payload, timeoutMs);
      const byId = new Map<number, JsonRpcResponse>();
      for (const r of responses) byId.set(r.id, r);

      return payload.map((p) => {
        const r = byId.get(p.id);
        if (!r) throw new RpcError(`missing response for ${p.method}`);
        if (r.error) throw new RpcError(`${p.method}: ${r.error.message}`, r.error.code);
        return r.result;
      });
    } catch (err) {
      lastError = err;
      endpointCursor++;
      // Backoff only once we've tried every endpoint in this round.
      if (attempt > 0 && attempt % RPC_HTTP_ENDPOINTS.length === 0) {
        await new Promise((r) => setTimeout(r, Math.min(2000, 200 * 2 ** attempt)));
      }
    }
  }

  throw new RpcError(
    `all RPC endpoints failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

/** Convenience wrapper for a single call. */
export async function rpcCall<T = unknown>(
  method: string,
  params: unknown[],
  opts?: { timeoutMs?: number; attempts?: number },
): Promise<T> {
  const [result] = await rpcBatch([{ method, params }], opts);
  return result as T;
}

/** `eth_call` against `to` with raw calldata, at the latest block. */
export function ethCall(to: string, data: string): RpcRequest {
  return { method: 'eth_call', params: [{ to, data }, 'latest'] };
}

export function hexToNumber(hex: unknown): number {
  if (typeof hex !== 'string') return 0;
  const n = Number.parseInt(hex, 16);
  return Number.isFinite(n) ? n : 0;
}

export function numberToHex(n: number): string {
  return '0x' + Math.max(0, Math.floor(n)).toString(16);
}
