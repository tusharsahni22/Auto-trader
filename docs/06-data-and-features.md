# 06 — Data Layer & Feature Store

**Answers:** *what does the engine know, when did it know it, and how much should it trust it?*
**Owns:** ingestion, point-in-time correctness, feature computation, quality gates, storage.

> **Verify before building.** Endpoint paths, rate limits, field names and terms of service for every provider below change frequently, and the details here reflect a snapshot in time. Confirm each against current documentation before committing to it, and check terms of service before scraping anything that lacks an official API.

---

## 1. Principles

**The engine calculates; the models interpret.** No indicator, ratio or statistic is ever computed by an LLM. Everything numeric originates here, in tested code, and flows outward.

**Every row carries two timestamps.** When the event happened, and when your system could first have known about it. Conflating these is the single most common way backtests generate alpha that does not exist.

**Absence is a first-class state.** A missing feed is not zero, and it is not the last known value carried forward indefinitely. It is missing, it reduces `data_confidence`, and beyond a threshold it vetoes trading.

**Degrade gracefully.** Every feature has a declared tier. Tier-1 absence halts trading. Tier-3 absence shrinks the evidence graph and carries on.

---

## 2. Source matrix

### 2.1 Tier 1 — market and derivatives (free, and sufficient)

The good news for a free-first build: the data that matters most for a swing engine on BTC/ETH perpetuals is available at professional quality for nothing, because exchanges publish it to attract flow.

| Data | Source | Transport | Notes |
|---|---|---|---|
| OHLCV, all timeframes | Binance, Bybit, OKX | REST backfill + WS live | Primary venue Binance; others for divergence checks |
| Trades / CVD | Binance, Bybit | WS aggregate trade stream | Build cumulative volume delta yourself |
| Orderbook depth | Binance, Bybit | WS diff stream + periodic REST snapshot | Store 10-level snapshots at 1-minute resolution; full book is overkill here |
| Funding rate + history | Binance, Bybit, OKX | REST | Needed per-venue for divergence |
| Open interest | Binance, Bybit, OKX | REST, ~5-min resolution | Free OI history is coarser than live; note the gap |
| Liquidations | Binance, Bybit | WS force-order stream | **Must be captured live** — historical liquidation data is not freely available |
| Long/short ratio | Binance futures data endpoints | REST | Top-trader and global variants differ; use both |
| Basis / premium index | Binance, OKX | REST | Spot-perp and quarterly-perp |
| Spot reference | Coinbase, Kraken | WS | US spot flow proxy; useful for divergence |
| Options IV / DVOL | Deribit | REST, public | Free, high quality; deferred to Phase 8 by effort, not cost |

The liquidation row deserves a flag. Historical liquidation data is one of the few genuinely valuable free-tier feeds that you **cannot** backfill. Start the collector on day one, before anything else is built, even if nothing consumes it for two months. Every day you delay is a day permanently missing from your analog set.

### 2.2 Tier 2 — news, events, macro (free, adequate)

| Data | Source | Notes |
|---|---|---|
| Crypto news | Major outlet RSS feeds; aggregator APIs with free tiers | Deduplicate aggressively — the same story arrives 6–10 times |
| Exchange announcements | Exchange announcement feeds/APIs | Listings, delistings, maintenance, margin changes |
| Regulatory filings | SEC EDGAR full-text search (free, no key) | Genuinely underused; filings appear here before news covers them |
| Macro series | FRED API (free, excellent) | Yields, DXY components, CPI, employment — authoritative and revision-aware |
| Economic calendar | Free-tier financial data APIs | Verify licensing; several free tiers permit non-commercial use |
| Equity risk proxy | Index futures via a free market-data tier | For the `beta_ndx_30d` regime feature |

### 2.3 Tier 3 — on-chain (free tier is weak; be honest about it)

| Data | Free option | Quality |
|---|---|---|
| BTC mempool, fees, hashrate | mempool.space API | Good |
| ETH gas, blocks, contract activity | Public node RPC or a free-tier provider | Good |
| ETH staking / validators | Beacon chain explorers with free APIs | Good |
| Stablecoin supply, L2 TVL | DefiLlama (free, generous) | Good |
| Exchange netflows | — | **Poor.** Requires maintained address labels |
| Whale transaction tracking | — | **Poor.** Same problem |
| MVRV, SOPR, realized price | — | **Poor.** Computable from UTXO data in principle; a large project in practice |

Address labelling is the whole game for on-chain, and it is exactly what the paid providers sell. Do not spend three months rebuilding it badly.

Practical position: build the on-chain cluster with a well-defined interface, wire up the genuinely-free feeds (mempool, gas, staking, stablecoin supply, L2 activity), and leave flow-based features returning `UNAVAILABLE`. The evidence graph handles their absence automatically — the `ONCHAIN` cluster simply contributes nothing, and `N` drops. Nothing breaks.

### 2.4 Declared upgrade slots

When budget appears, this is the priority order and the reasoning:

| Priority | Feed | Why first |
|---|---|---|
| 1 | On-chain analytics (exchange flows, whale labels, MVRV/SOPR) | Fills the only genuinely blank cluster; ~$30–100/mo at entry tiers |
| 2 | Historical liquidation and orderbook archives | Retroactively deepens the analog set — the thing that most limits `02` §3.2 |
| 3 | Institutional news API with structured entities and timestamps | Better importance scoring, and *reliable publish timestamps* for point-in-time correctness |
| 4 | ETF flow data | Real signal, but no reliable free API and daily-only resolution |
| 5 | Tick-level historical trades | Only if you later move to intraday horizons |

The `missingInformation` field that agents populate (`05` §3) should be the tiebreaker. Let the system tell you what it is missing rather than guessing.

---

## 3. Point-in-time correctness

This section prevents the failure mode where the backtest shows a Sharpe of 2.4 and live trading shows nothing.

### 3.1 Two timestamps, always

```sql
event_time    TIMESTAMPTZ NOT NULL,  -- when it happened in the world
observed_at   TIMESTAMPTZ NOT NULL,  -- when this system could first know
```

Every query used for backtesting, analog search, or model training filters on `observed_at <= T`. Never on `event_time`. Enforce this with a repository layer that requires an `asOf` parameter — make the leak impossible to write rather than something you remember not to do.

### 3.2 Where the gaps hide

| Data | `event_time` | `observed_at` | Typical gap |
|---|---|---|---|
| Candle close | Bar close timestamp | Bar close + WS latency | < 1s |
| Open interest | Exchange sample time | Your poll time | up to 5 min |
| Liquidation | Exchange fill time | WS receipt | < 1s |
| News article | Stated publish time | Your ingest time | 1–30 min |
| SEC filing | Filing acceptance time | Your poll time | up to poll interval |
| Macro release | Scheduled release time | Provider publish + your poll | 1–60 min |
| On-chain metric | Block time | Indexer availability | 10 min – 4 h |
| ETF flows | Trade date | Next-day publication | 18–24 h |

The ETF row is the clearest illustration. Flow data for a Tuesday is published Wednesday evening. A backtest that reads Tuesday's flows on Tuesday morning is reading the future, and it will produce a spectacular equity curve that evaporates instantly in live trading.

### 3.3 Revisions are appended, never overwritten

Macro data gets restated. News articles get edited and retitled. Exchanges correct OI figures. Store every version:

```sql
CREATE TABLE macro_series (
  series_id   TEXT,
  event_time  TIMESTAMPTZ,   -- the period the number describes
  observed_at TIMESTAMPTZ,   -- when THIS version became available
  value       NUMERIC,
  revision    INT,
  PRIMARY KEY (series_id, event_time, revision)
);
```

The as-of query then takes the latest revision available at time `T`:

```sql
SELECT DISTINCT ON (series_id, event_time) value
FROM macro_series
WHERE observed_at <= $asOf
ORDER BY series_id, event_time, revision DESC;
```

### 3.4 The leakage checklist

Run this against every feature before it enters the store. One failure invalidates the whole backtest.

```
☐ Does it use any bar that had not closed at decision time?
☐ Does any rolling window extend past the decision timestamp?
☐ Are indicator warm-up periods computed only from prior data?
☐ Is normalization (z-scores, percentile ranks) fitted on trailing data only?
☐ Does the analog search exclude the ±5-day embargo window?
☐ Are labels computed strictly forward from the decision time?
☐ Are delisted or failed venues still represented (survivorship)?
☐ Are news timestamps ingest-time, not stated publish-time?
☐ Do backfilled rows carry a realistic observed_at, not the backfill date?
```

That last one is subtle and catches many people. When you backfill two years of candles today, `observed_at` must be set to the plausible historical observation time — not to today. Otherwise every historical row appears to have been known immediately, and the `asOf` filter silently does nothing.

---

## 4. Feature catalogue

Organized by evidence cluster, since that is how `01` §4 consumes them. Roughly 90 features in the MVP. Naming is `{asset}.{feature}[_{window}][_{transform}]`.

```
PRICE_STRUCTURE   ema_{20,50,100,200}_dist_atr · vwap_session_dist_atr
                  swing_high/low_{1h,4h,1d} · sr_level_nearest_dist_atr
                  sr_touch_count · range_high/low_20d · bos_flag
                  measured_move_target · dist_to_prior_poc_atr

VOLATILITY        atr_14_{15m,1h,4h,1d} · atr_ratio_14_100
                  rv_{7,30,90}d + pct_rank · bb_bandwidth + pct_rank
                  vol_of_vol_30d · parkinson_vol_30d

FLOW              volume_z_{20,100} · cvd_spot_{4,24}h · cvd_perp_{4,24}h
                  cvd_divergence_24h · spot_perp_volume_ratio
                  large_trade_share_24h · taker_buy_ratio

POSITIONING       funding_8h + pct_rank_30d · funding_ma_3p
                  funding_venue_dispersion · oi_usd · oi_change_{4,24}h_7d
                  oi_price_divergence · lsr_global · lsr_top_trader
                  basis_perp_spot · basis_quarterly

LIQUIDATION       liq_{1,4,24}h_usd + pct_rank · liq_side_ratio
                  liq_cascade_flag · liq_largest_single · est_liq_cluster_above/below

ORDERBOOK         depth_imbalance_{10,50}bp · spread_bp + pct_rank
                  depth_usd_10bp_{bid,ask} · absorption_flag
                  book_slope · resting_size_cluster_dist_atr

ONCHAIN           btc: mempool_fee_fast · hashrate_7d_change
                  eth: gas_gwei_median · staking_inflow_7d · validator_queue
                  both: exchange_netflow_24h [UNAVAILABLE free tier]
                        whale_tx_count_24h  [UNAVAILABLE free tier]
                        mvrv_z · sopr        [UNAVAILABLE free tier]
                  defillama: stablecoin_supply_change_7d · l2_tvl_change_7d

NEWS              sentiment_24h_weighted · importance_max_24h
                  article_count_24h · regulatory_flag_7d
                  exchange_announcement_flag_24h · topic_vector (pgvector)

MACRO             dxy_change_{1,5}d · us10y_change_{1,5}d
                  beta_ndx_30d · corr_gold_30d · macro_regime_label
                  next_tier1_event_hours

EVENT             hours_to_next_scheduled · event_tier · event_hist_abs_move_4h
                  options_expiry_hours · expiry_notional_est
```

Features marked `UNAVAILABLE` return null on the free tier and are handled by absence semantics, not by imputation.

---

## 5. Data quality gates and `data_confidence`

A single scalar in `[0, 1]`, computed on every snapshot, consumed by gate `G2` in `01` §7 and as a sizing multiplier in `02` §7.7.

### 5.1 Per-feed checks

| Check | Rule | Effect |
|---|---|---|
| Freshness | Age exceeds the feed's threshold | Scales that feed's score to zero over 2× the threshold |
| Completeness | Expected vs received rows in the window | Linear penalty |
| Sanity | Value inside physically plausible bounds | Reject row, alert |
| Continuity | Gap > 2 expected intervals | Penalty, attempt REST backfill |
| Cross-venue agreement | Mid-price dispersion across venues | > 0.5% trips `FEED_DIVERGENCE` (`03` §5) |
| Monotonicity | Timestamps strictly increasing per series | Reject out-of-order, alert |

Freshness thresholds by feed: trades and orderbook 10s; candles one bar interval plus 30s; funding 15 min; open interest 10 min; liquidations 60s; news 30 min; macro 6h; on-chain 4h.

### 5.2 Aggregation

```
data_confidence = Π over tiers:  (Σ tier_feed_scores / n_feeds) ^ tier_weight

tier weights:  tier1 = 1.00   tier2 = 0.30   tier3 = 0.15
```

Tier-1 degradation dominates, which is correct — losing the funding feed should matter far more than losing an RSS source.

### 5.3 Thresholds

```
data_confidence ≥ 0.90    normal operation
0.70 – 0.90               size multiplied by data_confidence, warn
< 0.70                    G2 VETO — no new positions, existing managed
tier-1 feed down > 5 min  DATA_STALE breaker, full halt on new entries
```

Existing positions continue to be managed during degradation, because their stops sit at the exchange and flattening on a data problem you do not understand is usually the worse error (`03` §6).

---

## 6. Storage

PostgreSQL with TimescaleDB for time series and pgvector for news embeddings. One database, three extensions — do not distribute this until volume forces you to.

```
Hypertables (chunked by time)
  candles              7d chunks    · compress after 30d   · retain 5y
  trades_agg           1d chunks    · compress after 7d    · retain 1y
  orderbook_snapshots  1d chunks    · compress after 7d    · retain 1y
  derivatives          7d chunks    · compress after 30d   · retain 5y
  liquidations         7d chunks    · compress after 30d   · retain forever
  features             7d chunks    · compress after 30d   · retain 5y

Regular tables
  news · events · opportunities · agent_invocations
  positions · fills · ledger_outcomes · calibration_fits
  config_versions · audit_log

Continuous aggregates
  candles_1h, candles_4h, candles_1d rolled up from 15m
  funding_daily, liquidations_hourly
```

Liquidations are retained forever because they cannot be re-acquired. Everything else can be backfilled if you lose it.

Storage estimate for BTC and ETH across three venues: candles and derivatives are trivial (under a GB per year compressed); aggregated trades run a few GB per year; minute-resolution 10-level orderbook snapshots are the bulk, roughly 20–40 GB per year uncompressed and under 10 GB with TimescaleDB compression. A single modest instance handles this comfortably for years.

---

## 7. Ingestion architecture

```
 WS collectors ──┐
 (per venue,     │
  per stream)    ├──► Redis Streams ──► normalizer ──► TimescaleDB
 REST pollers ───┤    (buffer, replay)  (dedupe,        (raw tables)
 (backfill,      │                       validate,          │
  gap fill)      │                       stamp times)       ▼
 RSS/webhook ────┘                                   feature workers
                                                     (BullMQ, per-bar)
                                                            │
                                                            ▼
                                                     features table
                                                            │
                                                            ▼
                                                  detectors + snapshot builder
```

Redis Streams rather than Kafka. At this volume Kafka is operational overhead without benefit, and Streams give you the consumer groups and replay you actually need. Revisit only if you add twenty venues.

Practical requirements for the collectors, all of which you will otherwise learn the hard way: automatic reconnect with exponential backoff and a gap-fill REST call on every reconnect; sequence-number validation on orderbook diff streams with a full resnapshot on any gap; clock-skew correction against exchange server time; idempotent writes keyed on `(venue, symbol, stream, sequence)`; and a persistent record of every disconnection window so that backtests can exclude periods where your own data was incomplete.

That last one is easy to skip and quietly important. A backtest that trades happily through a two-hour window where your collector was down is testing a system that never existed.
