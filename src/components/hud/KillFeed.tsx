'use client';

import { memo, useEffect, useState } from 'react';
import { useBattleStore } from '@/store/battle';
import type { RealSwap } from '@/lib/data/types';
import { EXPLORER_TX } from '@/lib/chain/constants';
import { TIER_LABEL } from '@/lib/data/classify';
import { formatAge, formatAmount, formatUsd, shortHash } from '@/lib/util/format';

const TIER_GLYPH: Record<string, string> = {
  infantry: '▪',
  tank: '◆',
  artillery: '▲',
  nuke: '☢',
};

const SOURCE_TAG: Record<string, string> = {
  websocket: 'WSS',
  'rpc-backfill': 'LOG',
  subgraph: 'SUB',
};

const SOURCE_TITLE: Record<string, string> = {
  websocket: 'Pushed live over the RPC WebSocket',
  'rpc-backfill': 'Read from chain history via eth_getLogs',
  subgraph: 'Indexed by the PulseX subgraph',
};

/**
 * The killfeed: every real trade, exactly as it happened on-chain.
 *
 * Shows the true USD size, the focus-token leg, which DEX it hit, and a link to
 * the transaction so any line can be verified against a block explorer. Trades
 * we could not price carry an explicit "unpriced" marker instead of a made-up
 * dollar figure.
 */
/**
 * One trade.
 *
 * Memoised on the swap and its rendered age. The feed re-renders on a one
 * second timer so ages stay honest, and every arriving swap re-renders it
 * again — without this, each of those rebuilt all ~34 rows and their long
 * title strings. An age reads "4m" for a whole minute, so in practice almost
 * every row now skips the work.
 */
const KfRow = memo(function KfRow({ s, age }: { s: RealSwap; age: string }) {
  return (
    <a
      className={`kf-row ${s.side}`}
      href={`${EXPLORER_TX}${s.txHash}`}
      target="_blank"
      rel="noopener noreferrer"
      title={`${TIER_LABEL[s.tier]} · ${s.txHash}\nBlock ${s.blockNumber || 'n/a'}\n${s.dexLabel} · ${s.amm.toUpperCase()}-style pool\nPaid/received ${formatAmount(s.counterAmount)} ${s.counterSymbol}\n${SOURCE_TITLE[s.source] ?? s.source}`}
    >
      <span className="kf-tier" data-tier={s.tier}>
        {TIER_GLYPH[s.tier]}
      </span>
      <span className="kf-side">{s.side === 'buy' ? 'BUY' : 'SELL'}</span>
      <span className="kf-usd">
        {s.usd === null ? <em className="unpriced">unpriced</em> : formatUsd(s.usd)}
      </span>
      <span className="kf-amount">
        {formatAmount(s.focusAmount)} {s.focusSymbol}
      </span>
      <span className="kf-dex" data-dex={s.dexLabel.split(' ')[0].toLowerCase()}>
        {s.dexLabel}
      </span>
      <span className="kf-src" data-src={s.source}>
        {SOURCE_TAG[s.source] ?? '?'}
      </span>
      <span className="kf-age">{age}</span>
      <span className="kf-hash">{shortHash(s.txHash, 6, 4)}</span>
    </a>
  );
});

export function KillFeed({ compact }: { compact: boolean }) {
  const feed = useBattleStore((s) => s.feed);
  const [, forceTick] = useState(0);

  // Ages are relative; re-render once a second so they stay honest.
  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const rows = feed.slice(0, compact ? 14 : 34);

  return (
    <div className="killfeed">
      <div className="panel-head">
        <span>MARKET FEED</span>
        <em>{feed.length} real swaps</em>
      </div>

      <div className="killfeed-rows">
        {rows.length === 0 && <div className="killfeed-empty">Waiting for on-chain swaps…</div>}

        {rows.map((s) => (
          <KfRow key={s.id} s={s} age={formatAge(s.timestamp)} />
        ))}
      </div>
    </div>
  );
}
