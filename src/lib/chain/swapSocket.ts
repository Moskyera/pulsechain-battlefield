/**
 * Live PulseChain event socket.
 *
 * Subscribes to `Swap` and `Sync` logs for the active pair, plus `newHeads`.
 * This is the true real-time path: a trade lands on the battlefield within one
 * block of being mined, with no polling delay.
 *
 * `newHeads` doubles as a free source of real block timestamps, so swaps that
 * arrive over the socket get their actual mined time rather than wall-clock.
 *
 * Endpoint note: `wss://pulsechain-rpc.publicnode.com` is listed first because
 * `wss://rpc.pulsechain.com` was rejecting the upgrade handshake when this was
 * built. The client rotates through every endpoint before giving up, so if that
 * changes nothing here needs editing.
 */

import { RPC_WS_ENDPOINTS, SWAP_TOPIC0, SWAP_V3_TOPIC0, SYNC_TOPIC0 } from './constants';
import type { RawLog } from '../data/classify';
import type { SourceState } from '../data/types';

export type SocketEvent =
  | { type: 'swap'; log: RawLog }
  | { type: 'sync'; log: RawLog }
  | { type: 'head'; blockNumber: number; timestamp: number }
  | { type: 'status'; state: SourceState; detail?: string | null; error?: string | null };

interface RpcFrame {
  id?: number;
  result?: unknown;
  error?: { message?: string };
  method?: string;
  params?: { subscription?: string; result?: unknown };
}

const RECONNECT_BASE_MS = 800;
const RECONNECT_MAX_MS = 15_000;
/** If nothing arrives for this long the socket is considered stale. */
const STALE_TIMEOUT_MS = 75_000;
const HEARTBEAT_MS = 20_000;

export class SwapSocket {
  private ws: WebSocket | null = null;
  private addresses: string[] = [];
  private endpointIndex = 0;
  private attempt = 0;
  private nextId = 1;
  private lastMessageAt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = true;
  /** Subscription id -> what it carries, so notifications route correctly. */
  private subKinds = new Map<string, 'logs' | 'heads'>();
  private pendingSubs = new Map<number, 'logs' | 'heads'>();

  constructor(private readonly onEvent: (e: SocketEvent) => void) {}

  get endpoint(): string {
    return RPC_WS_ENDPOINTS[this.endpointIndex % RPC_WS_ENDPOINTS.length];
  }

  start(addresses: string[]): void {
    this.addresses = addresses.map((a) => a.toLowerCase());
    this.stopped = false;
    this.attempt = 0;
    this.connect();
  }

  /** Re-point the socket at a different pair without tearing down the connection. */
  setAddresses(addresses: string[]): void {
    const next = addresses.map((a) => a.toLowerCase());
    if (
      next.length === this.addresses.length &&
      next.every((a, i) => a === this.addresses[i])
    ) {
      return;
    }
    this.addresses = next;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.unsubscribeLogs();
      this.subscribeLogs();
    }
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.subKinds.clear();
    this.pendingSubs.clear();
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    }
    this.emitStatus('idle', null, null);
  }

  private emitStatus(state: SourceState, detail: string | null, error: string | null): void {
    this.onEvent({ type: 'status', state, detail, error });
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
  }

  private connect(): void {
    if (this.stopped) return;
    if (typeof WebSocket === 'undefined') {
      this.emitStatus('error', null, 'WebSocket unavailable in this environment');
      return;
    }

    this.clearTimers();
    this.emitStatus('connecting', this.endpoint.replace('wss://', ''), null);

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.endpoint);
    } catch (err) {
      this.scheduleReconnect(err instanceof Error ? err.message : 'socket construction failed');
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.lastMessageAt = Date.now();
      this.subKinds.clear();
      this.pendingSubs.clear();
      this.send({ method: 'eth_subscribe', params: ['newHeads'] }, 'heads');
      this.subscribeLogs();
      this.emitStatus('live', this.endpoint.replace('wss://', ''), null);
      this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
    };

    ws.onmessage = (ev: MessageEvent) => {
      if (this.ws !== ws) return;
      this.lastMessageAt = Date.now();
      this.handleFrame(ev.data);
    };

    ws.onerror = () => {
      if (this.ws !== ws) return;
      // The browser gives no detail on WS errors; onclose carries the outcome.
      this.emitStatus('degraded', this.endpoint.replace('wss://', ''), 'socket error');
    };

    ws.onclose = (ev: CloseEvent) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.scheduleReconnect(ev.reason || `closed (code ${ev.code})`);
    };
  }

  private handleFrame(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let frame: RpcFrame;
    try {
      frame = JSON.parse(raw) as RpcFrame;
    } catch {
      return;
    }

    // Subscription confirmations.
    if (frame.id !== undefined && typeof frame.result === 'string') {
      const kind = this.pendingSubs.get(frame.id);
      if (kind) {
        this.subKinds.set(frame.result, kind);
        this.pendingSubs.delete(frame.id);
      }
      return;
    }

    if (frame.id !== undefined && frame.error) {
      const kind = this.pendingSubs.get(frame.id);
      this.pendingSubs.delete(frame.id);
      if (kind === 'logs') {
        this.emitStatus('degraded', null, frame.error.message ?? 'log subscription rejected');
      }
      return;
    }

    if (frame.method !== 'eth_subscription' || !frame.params) return;

    const payload = frame.params.result as
      | (RawLog & { removed?: boolean })
      | { number?: string; timestamp?: string }
      | undefined;
    if (!payload) return;

    if ('topics' in payload && Array.isArray(payload.topics)) {
      // Reorgs emit the same log with removed=true; drop those rather than
      // firing a second explosion for a trade that no longer exists.
      if (payload.removed) return;
      const topic0 = (payload.topics[0] ?? '').toLowerCase();
      if (topic0 === SWAP_TOPIC0 || topic0 === SWAP_V3_TOPIC0) {
        this.onEvent({ type: 'swap', log: payload });
      } else if (topic0 === SYNC_TOPIC0) {
        this.onEvent({ type: 'sync', log: payload });
      }
      return;
    }

    if ('number' in payload && payload.number) {
      const blockNumber = Number.parseInt(payload.number, 16);
      const timestamp = payload.timestamp ? Number.parseInt(payload.timestamp, 16) : 0;
      if (Number.isFinite(blockNumber) && Number.isFinite(timestamp)) {
        this.onEvent({ type: 'head', blockNumber, timestamp });
      }
    }
  }

  private send(msg: { method: string; params: unknown[] }, kind?: 'logs' | 'heads'): number {
    const id = this.nextId++;
    if (kind) this.pendingSubs.set(id, kind);
    try {
      this.ws?.send(JSON.stringify({ jsonrpc: '2.0', id, ...msg }));
    } catch {
      /* socket closed mid-send; onclose will drive the reconnect */
    }
    return id;
  }

  private subscribeLogs(): void {
    if (this.addresses.length === 0) return;
    this.send(
      {
        method: 'eth_subscribe',
        params: [
          'logs',
          {
            address: this.addresses.length === 1 ? this.addresses[0] : this.addresses,
            // topic0 as an array = OR-match: V2 swaps, V3 swaps and Sync, all
            // on one subscription across every pool in the battle group.
            topics: [[SWAP_TOPIC0, SWAP_V3_TOPIC0, SYNC_TOPIC0]],
          },
        ],
      },
      'logs',
    );
  }

  private unsubscribeLogs(): void {
    for (const [subId, kind] of this.subKinds) {
      if (kind !== 'logs') continue;
      this.send({ method: 'eth_unsubscribe', params: [subId] });
      this.subKinds.delete(subId);
    }
  }

  private heartbeat(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - this.lastMessageAt > STALE_TIMEOUT_MS) {
      // Silent socket: drop it and let the reconnect path pick a new endpoint.
      try {
        this.ws.close();
      } catch {
        /* noop */
      }
      return;
    }
    this.send({ method: 'eth_blockNumber', params: [] });
  }

  private scheduleReconnect(reason: string): void {
    this.clearTimers();
    if (this.stopped) return;

    this.attempt++;
    this.endpointIndex++;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(this.attempt, 5));
    this.emitStatus(
      this.attempt > RPC_WS_ENDPOINTS.length ? 'error' : 'degraded',
      `retry in ${Math.round(delay / 1000)}s`,
      reason,
    );
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}
