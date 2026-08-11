'use client';

import { useBattleStore } from '@/store/battle';
import { EXPLORER_ADDRESS } from '@/lib/chain/constants';
import { formatUsd } from '@/lib/util/format';

const ORIGIN_LABEL: Record<string, string> = {
  'eth_call': 'getReserves()',
  'balance-of': 'pool balances (V3)',
  'sync-event': 'live Sync event',
};

/**
 * Which venues are in this fight.
 *
 * A multi-DEX battlefield merges pools from PulseX, 9mm, 9inch, Liberty,
 * SwitchX and others, so the HUD names them and shows how much each is
 * actually contributing — depth, 24h trade count, and the swaps this session
 * has observed from each (backfill plus live, hence "seen" not "live").
 */
export function PoolsPanel() {
  const pools = useBattleStore((s) => s.pools);
  const target = useBattleStore((s) => s.target);

  if (pools.length === 0) return null;

  const totalObserved = pools.reduce((n, p) => n + p.observedSwaps, 0);

  return (
    <div className="pools-panel">
      <div className="panel-head">
        <span>{target.kind === 'token' ? 'ENLISTED POOLS' : 'POOL'}</span>
        <em>
          {pools.length} venue{pools.length === 1 ? '' : 's'}
          {totalObserved > 0 ? ` · ${totalObserved} seen` : ''}
        </em>
      </div>

      <div className="pool-rows">
        {pools.map((p) => (
          <a
            key={p.address}
            className="pool-row"
            href={`${EXPLORER_ADDRESS}${p.address}`}
            target="_blank"
            rel="noopener noreferrer"
            title={`${p.address}\nReserves via ${ORIGIN_LABEL[p.reserveOrigin] ?? p.reserveOrigin}\nBlock ${p.blockNumber.toLocaleString()}\n${p.observedSwaps} swaps observed this session (backfill + live)`}
          >
            <span className="pool-focus">{p.focusSymbol}</span>
            <span className="pool-dex">
              {p.dexLabel}
              <em>/{p.counterSymbol}</em>
            </span>
            <span className="pool-liq">{formatUsd(p.liquidityUsd)}</span>
            <span className="pool-tx">{p.txns24.toLocaleString()} tx</span>
            <span className={`pool-live ${p.observedSwaps > 0 ? 'active' : ''}`}>
              {p.observedSwaps}
            </span>
          </a>
        ))}
      </div>
    </div>
  );
}
