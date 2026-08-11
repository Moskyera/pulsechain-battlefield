# PulseChain Battlefield

A real-time 3D battlefield where **every unit, every explosion and every metre of front line comes from actual PulseChain on-chain activity**. No simulated trades, no synthetic volume, no random generators, no demo mode.

If the data can't be sourced, the app shows an error — never a plausible-looking default.

---

## Quick start

> **This machine's `npm` is broken** (`Cannot find module '…/npm/node_modules/isexe/…'`), which also breaks `npx`. Use `pnpm`, which is installed and working. To repair npm later, reinstall Node.js or run `corepack enable npm`.

```bash
pnpm install
```

```bash
pnpm dev
```

Then open http://localhost:3000.

Audit every live data source without starting the app:

```bash
pnpm verify:live
```

Point the audit at any token:

```bash
node scripts/verify-live-data.mjs 0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39
```

---

## What "real" means here

Every visual is a function of a measured on-chain quantity:

| Battlefield element | Driven by | Source |
|---|---|---|
| Front-line position | 24h price momentum blended with observed buy/sell flow | DexScreener + swaps this session decoded |
| Front-line shoves | A trade's real price impact (`swap USD ÷ group liquidity`) | Swap logs + DexScreener |
| Green army size | Counter-token reserves, summed across every enlisted pool | `getReserves()` / pool token balances |
| Red army size | Focus-token reserves, summed across every enlisted pool | `getReserves()` / pool token balances |
| Base brightness | That side's share of total pool value | On-chain reserves |
| Each projectile | One real `Swap` event | RPC WebSocket / `eth_getLogs` |
| Unit class | The swap's USD size (see thresholds below) | Swap amount × token price |
| Explosion size, camera shake | Unit class | — |
| Killfeed rows | The swap itself: side, size, venue, block, tx hash | On-chain, links to explorer |
| Force bar | Buy vs sell USD over the last 5 min of observed swaps | On-chain |

**Unit classes** — decided solely by the real USD value of the swap:

| Class | Delivery |
|---|---|
| Infantry | a rifleman near the line fires a tracer |
| Tank | armour rolls up and launches a rocket |
| Artillery | a vehicle further back launches a heavier rocket |
| Nuke | a launcher at the rear + screen flash + camera shake |

Rounds always land **inside enemy ground** — the impact point is a fraction of
the way from the front line to the enemy base, and bigger trades drive deeper
into their camp.

### The cutoffs adapt, and here is why

Measured across **~20,000 real swaps over 8.3 hours** on the preset tokens:

| Token | Median trade | ≥$500 | ≥$5,000 | ≥$25,000 |
|---|---|---|---|---|
| WPLS | $1.32 | 19/hr | 0.2/hr | **0** |
| HEX | $2.35 | 12/hr | **0** | **0** |
| PLSX | $4.85 | 2.5/hr | **0** | **0** |
| INC | $2.20 | 1.1/hr | **0** | **0** |

Not one trade exceeded $25,000. On a fixed `$500 / $5K / $25K` ladder this
battlefield is ~99% infantry, artillery is a curiosity and the nuke tier never
fires at all.

So there are two scales, and the legend is a button that switches between them:

- **ADAPTIVE** (default) ranks each trade against the most recent real swaps on
  *this* battlefield — top 20% / 5% / 0.7%. Live cutoffs are always displayed.
- **ABSOLUTE** is the fixed dollar ladder from the original spec.

Adaptive changes only which *bucket* a real trade lands in — from "big in
dollars" to "big for this market". Every number stays real either way.

### Where variety comes from without randomness

The battlefield never calls `Math.random()`. Where a visual needs variation — a projectile's lane, an arc's height, a soldier's position in formation — it is derived by hashing real on-chain bytes (the transaction hash, the pool address, the unit index). **The same transaction produces the same trajectory on every machine and every reload.**

### What is *not* real, and is labelled as such

- Terrain, bases, ramparts and the starfield are set dressing.
- **Intense mode** changes animation energy only. It never touches data.
- Sound is synthesised with the Web Audio API (no assets, nothing to 404).
- Backfilled history populates the feed and statistics but does **not** detonate on screen — replaying hours of explosions at load would be theatre. Live trades only.

---

## Battlefields

Three scopes, in decreasing size:

**GRAND WAR** (default) — every major PulseChain coin in one theatre:
`PLS + PLSX + INC + HEX + eHEX + PCOCK`. Each coin contributes its most active
pools across every DEX, merged into a single fight.

**Token** — one coin, every liquid pool of it across all DEXs.

**Pool** — one specific venue. Search a symbol and pick, or paste any address.

How much this matters for how alive the app feels:

| Battlefield | Trades / 24h | Rate |
|---|---|---|
| Single WPLS/USDC pool | ~2,900 | ~2 / min |
| WPLS token, all DEXs | ~28,500 | ~20 / min |
| **GRAND WAR, 26 pools** | **~81,900** | **~57 / min** |

Measured live: 26 pools, 6 coins, 5 DEXs, $10.4M combined liquidity.

Pools are ranked by **observed trade count**, not liquidity — a deep but idle
pool contributes nothing to watch. Quotas stop any one DEX or coin from taking
every slot (max 6 pools per DEX, 6 per war coin), which is how 9mm, 9inch,
Liberty, SwitchX, Uniswap and Finvesta get onto the field at all.

**Sides are defined relative to a pool's focus token**: the focus token leaving
a pool means the trader acquired it — a BUY — whether it sits on the base or the
quote side of that pool. In a war, a pool holding two of the war's coins
(HEX/WPLS, say) is claimed by whichever appears first in the war's token list,
so every pool has exactly one well-defined reading. The HUD names the focus coin
for every enlisted pool.

### About Piteas

Piteas is an *aggregator*, not a venue with its own pools. Its routes execute
against the underlying PulseX / 9mm / 9inch pools, so **Piteas-routed trades
already appear** here — they arrive as `Swap` events from whichever pools the
route touched. There is no separate feed to add.

---

## The armies

Each side fields **~20 individually modelled soldiers** rather than a few hundred
markers — a squad you can actually look at. Every soldier is built from
primitives and merged into one `BufferGeometry` with **baked vertex colours**, so
a single instanced draw call per side renders skin, olive fatigues, body armour,
a pack, boots and a gunmetal rifle. Team identity is an emissive wash on top, so
they read as soldiers first and green/red second. Tanks are modelled the same
way: tracks, road wheels, sloped hull, turret and gun.

Head count still scales with real reserve value (square-root), but saturates
quickly — the precise wall value is reported in the HUD, where a number belongs.

---

## Handling two AMM families

PulseChain runs a mix of AMM designs, and they disagree in ways that matter:

| DEX | `getReserves()` | Swap event shape |
|---|---|---|
| PulseX V1 / V2, 9inch | ✅ works | V2 (128-byte data, unsigned in/out) |
| 9mm, Liberty | ❌ reverts | V3 (160-byte data, **signed** amounts) |
| SwitchX | ✅ works | **V3** |

SwitchX is the reason this app **decodes swaps by the log's own shape (topic + data length), never by what kind of pool it appears to be**. Classifying by `getReserves()` would silently mis-decode every SwitchX trade.

Reserves use a separate probe: try `getReserves()`, and fall back to reading the pool's actual ERC-20 balances when it reverts. Both are real on-chain quantities.

> V3 pools legitimately show a gap between raw token balances and DexScreener's reported liquidity, because concentrated liquidity parks capital outside the active tick range. The audit script flags this as expected rather than as an error.

---

## Data sources

| Source | Role | Notes |
|---|---|---|
| **RPC WebSocket** | Live `Swap` + `Sync` events, `newHeads` | Primary real-time path |
| **RPC `eth_getLogs`** | Swap backfill on load | ~850 logs / 1000 blocks in ~470ms |
| **RPC `eth_call`** | Token metadata, reserves, balances | Authoritative |
| **DexScreener** | USD price, liquidity, volume, txn counts | One call prices a whole group |
| **PulseX subgraph** | Independent confirmation for PulseX pools | Strictly optional |

Every source's health is shown permanently in the HUD (`WSS` / `RPC` / `DEX` / `GRAPH`). If one degrades you see which and why; the battlefield keeps running on the rest.

### Endpoint findings, measured live

- `wss://rpc.pulsechain.com` **rejects the WebSocket handshake**. `wss://pulsechain-rpc.publicnode.com` works and is tried first; the client rotates through all endpoints, so nothing needs editing if that changes.
- The subgraph's flat `swaps(where: { pair: … })` filter reliably hits the indexer's **statement timeout**. Traversing `pair(id:) { swaps(…) }` returns the same data in ~2s. Only the traversal form is used.
- Most established pools (including every PulseX default) live in the **V1** subgraph, not V2. The client probes V2 then V1 and caches the answer per address.

### Rate limits

- The browser never calls a public RPC over HTTP directly. It goes through `/api/rpc`, which does endpoint failover, **read-only method allow-listing** (this endpoint can never relay a transaction) and batching — so N open tabs cost one origin's budget, not N.
- DexScreener responses are cached server-side and concurrent identical requests are de-duplicated. A 10-pool battlefield polls at 2.5s for ~24 requests/min against a 60/min ceiling, shared by all clients.
- Polling backs off automatically when the tab is hidden, and on HTTP 429.

---

## Architecture

```
src/
  lib/
    chain/      constants · abi (V2+V3 decode) · rpc (failover, settled batches)
                pool (both AMM families) · logs (backfill) · swapSocket (live)
    data/       dexscreener · subgraph · group (enlistment) · classify · engine
    sim/        field (data→render bridge) · combat (pools) · layout · runtime
    audio/      Web Audio synthesis
    util/       deterministic hashing · formatting
  app/api/      rpc · group · prices · subgraph · search
  components/   scene/ (R3F)   hud/ (overlay)
  store/        zustand — UI state only
```

**The performance-critical decision:** swaps arrive several per second, so live combat does **not** flow through React state. The engine writes to a plain mutable module (`lib/sim/field`), and the R3F frame loop reads and drains it. React state is reserved for things a human actually reads — the killfeed, the stat panels — which update far less often. Everything on the field is drawn with `InstancedMesh` (armies, projectiles, fireballs, shockwaves), so hundreds of units cost a handful of draw calls.

Explosions fade via per-instance colour under additive blending, because a shared material cannot carry per-instance opacity — brightness reads identically when the blend mode is additive.

Camera shake is applied to a group wrapping the battlefield rather than to the camera, so it never fights `OrbitControls` for the same transform. You keep full control of the view mid-blast.

---

## Performance and mobile

A lighter scene is selected automatically for phones, coarse pointers, ≤4 CPU cores, or `prefers-reduced-motion` — fewer units, no shadows, no starfield, capped DPR, smaller pools. The `🔋` control overrides the automatic choice either way.

The HUD reflows for narrow viewports: intel collapses to essentials, the feed drops columns, and the field keeps the screen.

Rendering caps are honest about themselves. If a burst of trades saturates the spawn queue, the surplus is still recorded in the feed and statistics, and the HUD reports `N not rendered` rather than quietly dropping it.

---

## Verification

`pnpm verify:live` talks to the public endpoints directly, with no Next.js server in the loop, and cross-checks the sources against each other. The two checks that matter most:

**Reserves reconcile with reported liquidity** — proves the decoding and USD maths:

```
PASS pulsex WPLS/USDC   computed $885,887 vs reported $885,890 (0.0%)
PASS pulsex WPLS/PLSX   computed $698,972 vs reported $699,395 (0.1%)
```

**Both USD legs of every decoded swap agree** — proves the swap decoder, for both AMM families:

```
PASS pulsex WPLS/USDC   839 swaps · 8 priced · worst leg drift 0.30%
PASS switchx HEX/WPLS   102 swaps (V3) · worst leg drift 0.87%
```

A swap's two legs must be worth nearly the same in USD; the residual drift is the pool fee plus slippage. A decoder bug — wrong decimals, wrong sign, wrong field offset — would blow this up immediately.

---

## Controls

| Control | Effect |
|---|---|
| Drag / scroll | Orbit and zoom the camera |
| `⚔ GRAND WAR` | All six coins in one combined theatre |
| Token presets | Multi-DEX battlefield for that single coin |
| `⌕ SEARCH` | Find a coin or a specific pool; paste any address |
| Legend (`ADAPTIVE`/`ABSOLUTE`) | Click to switch unit-class scales |
| `⚡ INTENSE` | More animation energy and shake. **Visual only.** |
| `🔊 SOUND` | Synthesised impact audio (needs a click to start) |
| `🔋` | Toggle the light scene |
| `☰ FEED` | Show/hide the transaction list on its own |
| `▤ INTEL` | Show/hide the left intel + pool panels on their own |
| `⤢` | Hide the entire HUD |

Every killfeed row links to the transaction, and every enlisted pool links to its contract, so any claim on screen can be checked against a block explorer.
