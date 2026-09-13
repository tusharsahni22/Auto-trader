# 09 — Contracts

Core type definitions and database schema. These are the interfaces the rest of the documents refer to; if a doc and this file disagree, this file wins.

---

## 1. Project structure

```
auto-trader/
├── apps/
│   ├── web/                      Next.js dashboard
│   └── api/                      Fastify gateway + WebSocket
├── services/
│   ├── collectors/               per-venue WS + REST ingestion
│   ├── feature-engine/           indicator + feature computation
│   ├── detector/                 regime classifier + archetype detectors
│   ├── agent-orchestrator/       agent invocation, verification, evidence graph
│   ├── decision-engine/          aggregation, calibration, gates
│   ├── ev-engine/                levels, distributions, costs, sizing
│   ├── risk-engine/              limits, heat, breakers, state machine
│   ├── lifecycle/                post-entry management
│   ├── execution/                paper simulator; live adapter behind a flag
│   └── research/                 replay, backtest, calibration fits, scorecards
├── packages/
│   ├── types/                    everything in §2 below
│   ├── indicators/               pure functions, heavily tested
│   ├── exchange-adapters/        normalized venue interface
│   ├── ai-providers/             the AIProvider abstraction
│   ├── prompts/                  versioned templates
│   └── config/                   limits, weights, thresholds — all versioned
├── database/migrations/
└── docker/
```

One rule about `packages/indicators`: pure functions only, no I/O, no clock access. They are the foundation of every number in the system and they need to be trivially testable against known-good values.

---

## 2. Core types

```typescript
// ─── identity ────────────────────────────────────────────────
type Asset      = 'BTC' | 'ETH';
type Direction  = 'LONG' | 'SHORT';
type Venue      = 'binance' | 'bybit' | 'okx' | 'coinbase' | 'deribit';
type Timeframe  = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

type Regime =
  | 'TRENDING_UP' | 'TRENDING_DOWN' | 'RANGE_BOUND'
  | 'LOW_VOL_COMPRESSION' | 'HIGH_VOL_EXPANSION' | 'POST_CAPITULATION';

type Archetype =
  | 'COMPRESSION_BREAKOUT' | 'LIQUIDATION_REVERSAL' | 'TREND_CONTINUATION'
  | 'FUNDING_SQUEEZE' | 'RANGE_FADE' | 'EVENT_VOL_EXPANSION'
  | 'FLOW_DIVERGENCE';

type Cluster =
  | 'PRICE_STRUCTURE' | 'VOLATILITY' | 'FLOW' | 'POSITIONING'
  | 'LIQUIDATION' | 'ORDERBOOK' | 'ONCHAIN' | 'NEWS' | 'MACRO' | 'EVENT';

type OpportunityState =
  | 'FORMING' | 'SCORED' | 'VETOED' | 'ARMED' | 'OPEN' | 'SCALING_OUT'
  | 'CLOSED_WIN' | 'CLOSED_LOSS' | 'CLOSED_TIMEOUT'
  | 'CLOSED_INVALIDATED' | 'CLOSED_KILLED' | 'EXPIRED';

// ─── the point-in-time contract ──────────────────────────────
interface Stamped {
  eventTime:  Date;   // when it happened in the world
  observedAt: Date;   // when this system could first know it
}

interface FeatureSnapshot extends Stamped {
  hash: string;                                   // sha256 of values
  asset: Asset;
  values: Record<string, number | null>;          // null = UNAVAILABLE
  dataConfidence: number;                         // [0,1]
  missingFeatures: string[];
  regime: { label: Regime; posterior: Record<Regime, number>;
            confidence: number; hoursInRegime: number };
}

// ─── evidence ────────────────────────────────────────────────
type Stance = 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'ABSTAIN';

interface Claim {
  text: string;
  stance: Stance;
  strength: number;                    // −1..1
  featureIds: string[];
  observedValues: Record<string, number>;
  agent: string;
  cluster: Cluster;                    // assigned, not agent-chosen
  verified: boolean;
}

interface DroppedClaim {
  claim: Claim;
  reason: 'CITATION_MISMATCH' | 'MISSING_FEATURE'
        | 'DUPLICATE_IN_CLUSTER' | 'SCHEMA_INVALID';
  claimedValue?: number;
  actualValue?: number;
}

interface AgentOutput {
  agent: string;
  promptVersion: string;
  snapshotHash: string;
  stance: Stance;
  strength: number;
  selfConfidence: number;
  claims: Claim[];
  abstainReason: string | null;
  missingInformation: string[];
  wouldChangeMyView: string;
}

interface EvidenceGraph {
  admitted: Claim[];
  dropped: DroppedClaim[];
  clusterStrengths: Partial<Record<Cluster, number>>;
  nClusters: number;
  nEffective: number;                  // N_eff, see 01 §5.2
  conflict: number;                    // [0,1], see 01 §5.3
}

// ─── probability ─────────────────────────────────────────────
interface CalibratedProbability {
  raw: number;                         // sigmoid(L), ordinal only
  calibrated: number;
  ci90: [number, number];
  method: 'NONE' | 'PLATT' | 'ISOTONIC';
  stratum: string;                     // `${archetype}:${regimeGroup}`
  sampleSize: number;
  vintage: Date;
  isCalibrated: boolean;               // false ⇒ minimum sizing only
}

// ─── expected value ──────────────────────────────────────────
interface Target { price: number; fraction: number; pHit: number; r: number; }

interface CostBreakdown {
  feesR: number; slippageR: number; fundingR: number; totalR: number;
  fundingSensitivity: { at72hR: number; atElevatedFundingR: number };
}

interface OutcomeDistribution {
  byOutcome: Record<
    'FULL_RUN' | 'PARTIAL_THEN_TRAIL' | 'PARTIAL_THEN_BREAKEVEN'
    | 'STOPPED' | 'TIME_STOP' | 'THESIS_INVALIDATED',
    { p: number; meanR: number }
  >;
  quantilesR: { p5: number; p25: number; p50: number; p75: number; p95: number };
  cvar5R: number;
  pProfit: number;
  expectedHoldHours: number;
  source: 'BOOTSTRAP' | 'MONTECARLO' | 'BLENDED';
  modelDisagreementR: number;
}

interface ExpectedValue {
  grossR: number; costR: number; netR: number; netUSD: number;
  netRAtLowerCI: number;               // hurdle H2, see 02 §6.3
  breakevenP: number;
  distribution: OutcomeDistribution;
  costs: CostBreakdown;
}

interface Sizing {
  kellyFraction: number;               // uncertainty-adjusted, 02 §7.2
  appliedFraction: number;             // quarter-Kelly
  riskPctOfEquity: number;
  notionalUSD: number;
  leverage: number;
  bindingConstraint:
    | 'MAX_RISK_PER_TRADE' | 'KELLY' | 'VOL_TARGET'
    | 'LIQUIDITY' | 'PORTFOLIO_HEAT';
  haircuts: { reason: string; multiplier: number }[];
}

// ─── analogs ─────────────────────────────────────────────────
interface HistoricalAnalogs {
  method: string; n: number; since: Date;
  hitTP1: number; hitStopFirst: number;
  medianR: number; worstR: number; bestR: number;
  medianHoldHours: number;
  medianMfeR: number; medianMaeR: number;
}

// ─── the opportunity ─────────────────────────────────────────
interface Opportunity extends Stamped {
  id: string;
  asset: Asset;
  direction: Direction;
  archetype: Archetype;
  regime: Regime;
  state: OpportunityState;
  isShadow: boolean;

  snapshotHash: string;
  evidence: EvidenceGraph;
  probability: CalibratedProbability;

  entry: { min: number; max: number; method: string; expiresAt: Date };
  stop:  { price: number; method: string; distancePct: number };
  targets: Target[];
  timeStop: { hardHours: number; softHours: number };

  ev: ExpectedValue;
  sizing: Sizing;
  analogs: HistoricalAnalogs;

  invalidations: Invalidation[];
  thesisDecay: number;                 // 1 → 0
  eventRisk: { level: 'LOW'|'MEDIUM'|'HIGH';
               nextEvent: ScheduledEvent | null; blackout: boolean };

  vetoReasons: VetoCode[];
  replayHash: string;
}

type VetoCode =
  | 'ARCHETYPE_REGIME_VETO' | 'DATA_CONFIDENCE' | 'UNVERIFIED_EVIDENCE'
  | 'CONFLICT' | 'INSUFFICIENT_EDGE' | 'NEGATIVE_NET_EV' | 'EVENT_BLACKOUT'
  | 'PORTFOLIO_HEAT' | 'CORRELATION_STACK' | 'LIQUIDITY'
  | 'STALE_CALIBRATION' | 'CIRCUIT_BREAKER' | 'SUPERSEDED_BY_CORRELATION';

interface Invalidation {
  condition: string;
  type: 'PRICE'|'DERIVATIVE'|'REGIME'|'STRUCTURE'|'NEWS'|'EVENT'|'CORRELATION';
  autoCheck: boolean;
  action: 'EXIT'|'REDUCE_50'|'TIGHTEN'|'REEVALUATE'|'FREEZE';
  triggeredAt: Date | null;
}

// ─── outcome ─────────────────────────────────────────────────
interface LedgerOutcome {
  opportunityId: string;
  wasTraded: boolean;                  // false ⇒ counterfactual control
  barrierTouched: 'UPPER' | 'LOWER' | 'TIME';
  realizedR: number;
  mfeR: number; maeR: number;
  hoursToMfe: number; hoursHeld: number;
  captureRatio: number;
  realizedCostR: number;
  predictedNetR: number;
  predictedP: number;
  exitReason: string;
}

// ─── risk ────────────────────────────────────────────────────
interface PortfolioState {
  equity: number;
  positions: Position[];
  heat: number;                        // sqrt(wᵀCw)
  nEffectivePositions: number;
  grossNotionalPct: number;
  correlationMatrix: number[][];
  activeBreakers: BreakerCode[];
  dayPnlPct: number; weekPnlPct: number;
  drawdownFromPeakPct: number;
}

type BreakerCode =
  | 'DAILY_LOSS' | 'WEEKLY_LOSS' | 'CONSECUTIVE_LOSSES' | 'DRAWDOWN'
  | 'EV_DIVERGENCE' | 'CALIBRATION_DEGRADED' | 'DATA_STALE'
  | 'FEED_DIVERGENCE' | 'SLIPPAGE_ANOMALY' | 'PROVIDER_OUTAGE'
  | 'EXCHANGE_ERROR';

interface RiskDecision {
  permitted: boolean;
  sizing: Sizing | null;
  vetoReasons: VetoCode[];
  signature: string;                   // execution accepts nothing unsigned
  evaluatedAt: Date;
  configVersion: string;
}
```

The `signature` on `RiskDecision` is the mechanism behind the "no LLM output reaches execution" guarantee in `03` §1. The execution adapter verifies it and rejects anything unsigned, so there is no code path from an agent response to an order — enforced, not merely intended.

---

## 3. Database schema

Abbreviated to the tables that carry the design. Standard audit columns omitted.

```sql
-- ─── time series (TimescaleDB hypertables) ──────────────────
CREATE TABLE candles (
  event_time   TIMESTAMPTZ NOT NULL,
  observed_at  TIMESTAMPTZ NOT NULL,
  venue        TEXT NOT NULL,
  symbol       TEXT NOT NULL,
  timeframe    TEXT NOT NULL,
  open NUMERIC, high NUMERIC, low NUMERIC, close NUMERIC, volume NUMERIC,
  PRIMARY KEY (venue, symbol, timeframe, event_time)
);
SELECT create_hypertable('candles','event_time', chunk_time_interval => INTERVAL '7 days');

CREATE TABLE derivatives (
  event_time TIMESTAMPTZ NOT NULL, observed_at TIMESTAMPTZ NOT NULL,
  venue TEXT, symbol TEXT,
  funding_rate NUMERIC, next_funding_time TIMESTAMPTZ,
  open_interest_usd NUMERIC, lsr_global NUMERIC, lsr_top_trader NUMERIC,
  basis_perp_spot NUMERIC,
  PRIMARY KEY (venue, symbol, event_time)
);
SELECT create_hypertable('derivatives','event_time', chunk_time_interval => INTERVAL '7 days');

-- retained forever: cannot be reacquired
CREATE TABLE liquidations (
  event_time TIMESTAMPTZ NOT NULL, observed_at TIMESTAMPTZ NOT NULL,
  venue TEXT, symbol TEXT, side TEXT, price NUMERIC,
  qty NUMERIC, notional_usd NUMERIC
);
SELECT create_hypertable('liquidations','event_time', chunk_time_interval => INTERVAL '7 days');

CREATE TABLE orderbook_snapshots (
  event_time TIMESTAMPTZ NOT NULL, observed_at TIMESTAMPTZ NOT NULL,
  venue TEXT, symbol TEXT,
  bids JSONB, asks JSONB,              -- 10 levels each
  mid NUMERIC, spread_bp NUMERIC,
  depth_usd_10bp_bid NUMERIC, depth_usd_10bp_ask NUMERIC,
  PRIMARY KEY (venue, symbol, event_time)
);
SELECT create_hypertable('orderbook_snapshots','event_time', chunk_time_interval => INTERVAL '1 day');

CREATE TABLE features (
  event_time TIMESTAMPTZ NOT NULL, observed_at TIMESTAMPTZ NOT NULL,
  asset TEXT NOT NULL, timeframe TEXT NOT NULL,
  values JSONB NOT NULL,               -- null entries mean UNAVAILABLE
  data_confidence NUMERIC NOT NULL,
  snapshot_hash TEXT NOT NULL,
  PRIMARY KEY (asset, timeframe, event_time)
);
SELECT create_hypertable('features','event_time', chunk_time_interval => INTERVAL '7 days');

-- ─── revision-aware series ──────────────────────────────────
CREATE TABLE macro_series (
  series_id TEXT, event_time TIMESTAMPTZ, observed_at TIMESTAMPTZ,
  value NUMERIC, revision INT DEFAULT 0,
  PRIMARY KEY (series_id, event_time, revision)
);

-- ─── news ───────────────────────────────────────────────────
CREATE TABLE news (
  id UUID PRIMARY KEY,
  event_time TIMESTAMPTZ,              -- stated publish time
  observed_at TIMESTAMPTZ NOT NULL,    -- YOUR ingest time — use this
  source TEXT, url TEXT UNIQUE, title TEXT, body TEXT,
  assets TEXT[], sentiment NUMERIC, importance INT,   -- 1..10
  dedupe_group UUID,
  embedding VECTOR(768)
);
CREATE INDEX ON news USING ivfflat (embedding vector_cosine_ops);

CREATE TABLE scheduled_events (
  id UUID PRIMARY KEY, name TEXT, tier INT,           -- 1..3
  scheduled_time TIMESTAMPTZ, assets TEXT[],
  hist_abs_move_4h NUMERIC, hist_sample_size INT,
  actual_impact NUMERIC, status TEXT
);

-- ─── decisions ──────────────────────────────────────────────
CREATE TABLE opportunities (
  id TEXT PRIMARY KEY,
  event_time TIMESTAMPTZ NOT NULL, observed_at TIMESTAMPTZ NOT NULL,
  asset TEXT, direction TEXT, archetype TEXT, regime TEXT,
  state TEXT NOT NULL, is_shadow BOOLEAN DEFAULT FALSE,
  snapshot_hash TEXT NOT NULL,
  evidence JSONB, probability JSONB, levels JSONB,
  ev JSONB, sizing JSONB, analogs JSONB,
  invalidations JSONB, thesis_decay NUMERIC,
  veto_reasons TEXT[], replay_hash TEXT,
  config_version TEXT NOT NULL
);
CREATE INDEX ON opportunities (archetype, regime, event_time);
CREATE INDEX ON opportunities (state) WHERE state IN ('ARMED','OPEN','SCALING_OUT');

CREATE TABLE opportunity_transitions (
  opportunity_id TEXT REFERENCES opportunities(id),
  at TIMESTAMPTZ NOT NULL,
  from_state TEXT, to_state TEXT, trigger TEXT, detail JSONB,
  PRIMARY KEY (opportunity_id, at)
);

CREATE TABLE agent_invocations (
  id UUID PRIMARY KEY,
  opportunity_id TEXT REFERENCES opportunities(id),
  agent TEXT, prompt_version TEXT, provider TEXT, model TEXT,
  temperature NUMERIC, seed BIGINT,
  snapshot_hash TEXT, snapshot JSONB,
  raw_response TEXT, parsed JSONB,
  claims_admitted INT, claims_dropped INT, drop_details JSONB,
  input_tokens INT, output_tokens INT, cost_usd NUMERIC, latency_ms INT,
  replay_hash TEXT, created_at TIMESTAMPTZ DEFAULT now()
);

-- ─── outcomes: the learning substrate ───────────────────────
CREATE TABLE ledger_outcomes (
  opportunity_id TEXT PRIMARY KEY REFERENCES opportunities(id),
  was_traded BOOLEAN NOT NULL,         -- FALSE rows are the control group
  barrier_touched TEXT,
  realized_r NUMERIC, mfe_r NUMERIC, mae_r NUMERIC,
  hours_to_mfe NUMERIC, hours_held NUMERIC, capture_ratio NUMERIC,
  realized_cost_r NUMERIC, predicted_net_r NUMERIC, predicted_p NUMERIC,
  exit_reason TEXT, labelled_at TIMESTAMPTZ
);

CREATE TABLE calibration_fits (
  id UUID PRIMARY KEY,
  stratum TEXT NOT NULL, method TEXT NOT NULL,
  params JSONB, sample_size INT,
  brier NUMERIC, brier_resolution NUMERIC, brier_reliability NUMERIC,
  log_loss NUMERIC, ece NUMERIC,
  fitted_at TIMESTAMPTZ, valid_from TIMESTAMPTZ, valid_to TIMESTAMPTZ
);

CREATE TABLE trial_registry (
  id UUID PRIMARY KEY,
  run_at TIMESTAMPTZ, config_hash TEXT, params JSONB,
  data_range TSTZRANGE, sharpe NUMERIC, deflated_sharpe NUMERIC,
  pbo NUMERIC, mean_r NUMERIC, n_trades INT, notes TEXT
);

-- ─── operations ─────────────────────────────────────────────
CREATE TABLE positions (
  id UUID PRIMARY KEY,
  opportunity_id TEXT REFERENCES opportunities(id),
  asset TEXT, direction TEXT, is_paper BOOLEAN NOT NULL,
  entry_price NUMERIC, size NUMERIC, current_stop NUMERIC,
  opened_at TIMESTAMPTZ, closed_at TIMESTAMPTZ,
  realized_pnl NUMERIC, fees_paid NUMERIC, funding_paid NUMERIC
);

CREATE TABLE config_versions (
  version TEXT PRIMARY KEY, effective_from TIMESTAMPTZ,
  config JSONB NOT NULL, changed_by TEXT, reason TEXT NOT NULL
);

CREATE TABLE audit_log (
  at TIMESTAMPTZ NOT NULL, actor TEXT, action TEXT,
  subject TEXT, detail JSONB
);

CREATE TABLE feed_outages (
  feed TEXT, started_at TIMESTAMPTZ, ended_at TIMESTAMPTZ, reason TEXT
);
```

Three tables carry more weight than their size suggests.

`ledger_outcomes` with `was_traded = FALSE` is the control group. Vetoed and never-triggered opportunities are labelled exactly like traded ones, which is the only way to evaluate whether your gates are rejecting bad trades or good ones (`07` §4.3).

`config_versions` with a mandatory `reason` is what stops limits from drifting upward after a good month. Every change is attributable and timestamped, and backtests record which version they ran under.

`feed_outages` lets backtests exclude periods where your own collectors were down. A backtest that trades happily through a two-hour gap in your data is testing a system that never existed (`06` §7).
