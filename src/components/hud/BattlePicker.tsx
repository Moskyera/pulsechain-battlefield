'use client';

import { useEffect, useRef, useState } from 'react';
import { PRESET_TOKENS, WAR_PRESETS, dexLabel } from '@/lib/chain/constants';
import { useBattleStore } from '@/store/battle';
import { formatUsd } from '@/lib/util/format';
import type { MarketSnapshot } from '@/lib/data/types';

const isAddress = (v: string) => /^0x[0-9a-fA-F]{40}$/.test(v);

/**
 * Battlefield selector.
 *
 * The presets are *tokens*, not pools: choosing one enlists every liquid pool
 * trading it across all PulseChain DEXs, so the field carries the token's whole
 * flow rather than one venue's slice of it.
 *
 * Search still resolves to a single pool when you want one specific venue, and
 * a pasted token address opens a multi-DEX battlefield for that token.
 */
export function BattlePicker({ compact }: { compact: boolean }) {
  const target = useBattleStore((s) => s.target);
  const selectWar = useBattleStore((s) => s.selectWar);
  const selectToken = useBattleStore((s) => s.selectToken);
  const selectPool = useBattleStore((s) => s.selectPool);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MarketSnapshot[]>([]);
  const [searching, setSearching] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const requestId = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setMessage(null);
      setSearching(false);
      return;
    }

    const id = ++requestId.current;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        const body = (await res.json()) as { results?: MarketSnapshot[]; error?: string };
        if (id !== requestId.current) return;
        setResults(body.results ?? []);
        setMessage(body.error ?? (body.results?.length ? null : 'No PulseChain markets found'));
      } catch {
        if (id !== requestId.current) return;
        setResults([]);
        setMessage('Search failed');
      } finally {
        if (id === requestId.current) setSearching(false);
      }
    }, 350);

    return () => clearTimeout(timer);
  }, [query]);

  const close = () => {
    setOpen(false);
    setQuery('');
  };

  return (
    <div className="pair-picker">
      <div className="preset-row">
        {WAR_PRESETS.map((w) => {
          const active = target.kind === 'war' && target.id === w.id;
          return (
            <button
              key={w.id}
              type="button"
              className={`preset war ${active ? 'active' : ''}`}
              onClick={() =>
                selectWar(
                  w.id,
                  w.label,
                  w.tokens.map((t) => ({ address: t.address.toLowerCase(), symbol: t.symbol })),
                )
              }
              title={`${w.note}: ${w.tokens.map((t) => t.symbol).join(' + ')} — every liquid pool of all of them, on every DEX, in one theatre`}
            >
              ⚔ {w.label}
              <em>{w.tokens.map((t) => t.symbol).join('+')}</em>
            </button>
          );
        })}

        {PRESET_TOKENS.map((t) => {
          const active = target.kind === 'token' && target.address === t.address.toLowerCase();
          return (
            <button
              key={t.address}
              type="button"
              className={`preset ${active ? 'active' : ''}`}
              onClick={() => selectToken(t.address, t.symbol)}
              title={`${t.note} — enlists every liquid ${t.symbol} pool across all PulseChain DEXs`}
            >
              {t.symbol}
              <em>ALL DEX</em>
            </button>
          );
        })}
        <button
          type="button"
          className={`preset search-toggle ${open ? 'active' : ''}`}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {compact ? '⌕' : '⌕ SEARCH'}
        </button>
      </div>

      {open && (
        <div className="search-panel">
          <input
            className="search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Symbol, token address, or pool address…"
            spellCheck={false}
            autoComplete="off"
            /* eslint-disable-next-line jsx-a11y/no-autofocus */
            autoFocus
          />

          <div className="search-status">
            {searching && <span>searching…</span>}
            {!searching && message && <span>{message}</span>}
            {!searching && isAddress(query.trim()) && (
              <span className="raw-actions">
                <button
                  type="button"
                  className="raw-load"
                  onClick={() => {
                    const q = query.trim();
                    selectToken(q, `${q.slice(2, 6).toUpperCase()}`);
                    close();
                  }}
                >
                  as token (all DEXs)
                </button>
                <button
                  type="button"
                  className="raw-load"
                  onClick={() => {
                    const q = query.trim();
                    selectPool(q, `${q.slice(0, 6)}…${q.slice(-4)}`);
                    close();
                  }}
                >
                  as single pool
                </button>
              </span>
            )}
          </div>

          <div className="search-results">
            {results.map((r) => (
              <div key={r.pairAddress} className="search-result-row">
                <button
                  type="button"
                  className="search-result"
                  onClick={() => {
                    selectPool(
                      r.pairAddress,
                      `${r.baseToken.symbol}/${r.quoteToken.symbol} · ${dexLabel(r.dexId, r.labels)}`,
                    );
                    close();
                  }}
                  title="Fight over this single pool"
                >
                  <span className="sr-pair">
                    {r.baseToken.symbol} / {r.quoteToken.symbol}
                  </span>
                  <span className="sr-dex">{dexLabel(r.dexId, r.labels)}</span>
                  <span className="sr-liq">{formatUsd(r.liquidityUsd)}</span>
                  <span className="sr-vol">{r.txns.h24.buys + r.txns.h24.sells} tx</span>
                </button>
                <button
                  type="button"
                  className="sr-all"
                  onClick={() => {
                    selectToken(r.baseToken.address, r.baseToken.symbol);
                    close();
                  }}
                  title={`Enlist every ${r.baseToken.symbol} pool across all DEXs`}
                >
                  ALL DEX
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
