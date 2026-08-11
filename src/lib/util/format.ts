/** Display formatting. Values are never rounded in a way that changes meaning. */

export function formatUsd(value: number | null | undefined, opts: { compact?: boolean } = {}): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);

  if (opts.compact !== false && abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (opts.compact !== false && abs >= 10_000) return `$${(value / 1_000).toFixed(1)}K`;
  if (abs >= 1) return `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  if (abs >= 0.01) return `$${value.toFixed(3)}`;
  if (abs === 0) return '$0';
  return `$${value.toPrecision(3)}`;
}

/** Token prices span many orders of magnitude on PulseChain; keep them readable. */
export function formatPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1000) return `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  if (abs >= 1) return `$${value.toFixed(4)}`;
  if (abs >= 0.0001) return `$${value.toFixed(6)}`;
  if (abs === 0) return '$0';
  return `$${value.toExponential(4)}`;
}

export function formatAmount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  if (abs >= 1) return value.toFixed(3);
  if (abs === 0) return '0';
  return value.toPrecision(3);
}

export function formatPercent(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}%`;
}

/** Short relative time for the killfeed: "3s", "2m", "1h". */
export function formatAge(timestampSec: number, nowMs = Date.now()): string {
  const delta = Math.max(0, Math.floor(nowMs / 1000) - timestampSec);
  if (delta < 60) return `${delta}s`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h`;
  return `${Math.floor(delta / 86400)}d`;
}

export function shortHash(hash: string, lead = 6, tail = 4): string {
  if (!hash || hash.length <= lead + tail + 2) return hash || '—';
  return `${hash.slice(0, lead)}…${hash.slice(-tail)}`;
}

export function formatBlock(block: number | null | undefined): string {
  if (!block) return '—';
  return `#${block.toLocaleString('en-US')}`;
}
