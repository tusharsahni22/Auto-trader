# BTC/ETH Opportunity Intelligence Engine — Master Plan

**Version:** 1.0
**Date:** 2026-09-13
**Horizon:** Swing (4h – 5 days)
**Execution ceiling for v1:** Paper trading. Live execution is gated behind explicit exit criteria in `docs/08-roadmap.md`.
**Data posture:** Free/public sources first, with declared upgrade slots for paid feeds.

---

## 0. What this document is

Your original architecture is a good *data and orchestration* design. It gets market data, derivatives, news, on-chain and macro into a set of AI agents, and it correctly refuses to let an LLM place orders.

What it does not yet have is a **decision engine**. It produces a weighted score and a confidence number, but nothing in the design makes that score mean anything. A `confidence: 0.78` that has never been checked against outcomes is a decoration. Likewise `riskReward: 2.8` describes the *geometry* of a trade, not its *expected value* — a 2.8:1 setup that wins 20% of the time loses money, and after perpetual funding and fees it loses money faster than it looks.

This plan keeps your architecture and adds the two things you asked for:

1. **A decision layer that can actually choose** — regime conditioning, setup archetypes with their own historical statistics, evidence deduplication so correlated agents stop double-counting, and a calibration step that converts scores into probabilities that have been checked against reality.
2. **A profit model** — a full outcome distribution per trade rather than a target price, with fees, slippage and funding subtracted, expressed both in R and in currency, with an honest uncertainty band.

Everything else in the plan exists to serve those two.

---

## 1. The five gaps that matter

Before the enhancements, here is the diagnosis. These are ordered by how much they cost you.

### Gap 1 — The confidence number is uncalibrated

Your opportunity object carries `confidence: 0.78` and `agentConsensus` scores. Nothing maps those to observed frequencies. If you sort every historical opportunity by score and the 0.78 bucket wins 51% of the time while the 0.55 bucket wins 53%, your score is noise and you have no way to know.

**Fix:** a calibration layer (`docs/01-decision-engine.md` §6). Raw ensemble score goes in, empirically-fitted win probability comes out, with a reliability diagram and Brier score you check every month. Until a score is calibrated it is not allowed to size a position — it can only rank a watchlist.

### Gap 2 — Agreeing agents are not independent evidence

You flagged this yourself in §29 and then did not design for it. It is the single biggest source of overconfidence in multi-agent systems. Your Technical Agent sees rising volume. Your Derivatives Agent sees rising open interest. Your Quant Agent flags a volume anomaly. That is **one** fact — a volume expansion — counted three times, and the ensemble score jumps as if three independent witnesses corroborated each other.

**Fix:** an **evidence graph** (`docs/01-decision-engine.md` §4). Every agent claim must cite the specific feature IDs it rests on. Claims sharing feature provenance are collapsed before aggregation. On top of that, the ensemble combines log-odds using an *effective* independent-signal count derived from the historical correlation of agent outputs, not a naive weighted sum.

### Gap 3 — There is no profit model, only a ratio

`riskReward: 2.8` assumes you either hit the target or the stop. In reality a swing trade on BTC ends in one of at least five ways: first target hit then reversal, full target run, stopped out, time-stopped at a small gain, or thesis-invalidated and closed manually. Each has a probability and a payoff. The expected value is the sum over all of them, minus costs.

And the costs are not small. Worked example, BTC long, entry 104,800, stop 102,900 (a 1.81% stop):

| Cost component | Price terms | In units of R |
|---|---|---|
| Taker fees, round trip (0.05% × 2) | 0.100% | 0.055 R |
| Slippage, 2 bps each side | 0.040% | 0.022 R |
| Funding, 36h hold at 0.010%/8h | 0.045% | 0.025 R |
| **Total (benign conditions)** | **0.185%** | **≈ 0.10 R** |
| Same trade, funding elevated to 0.050%/8h | 0.365% | **≈ 0.20 R** |

A setup with a gross edge of +0.25R nets +0.15R at best and +0.05R when funding is hot. That is the difference between a strategy and a rounding error, and your current design never computes it. Worse, tighten the stop to 0.6% and the same costs become **0.31 R** — tight stops are eaten alive, which is exactly the opposite of the usual intuition.

**Fix:** `docs/02-expected-value-model.md`. Path simulation against the actual management rules, full cost model including funding accrued over the *expected* hold time, EV reported net.

### Gap 4 — The design stops at entry

Your state machine ends at `EXECUTION_ELIGIBLE`. But for a 4h–5d horizon, most of the variance in realized profit comes *after* entry: whether you moved to breakeven too early, whether you scaled out at the first target, whether you held through a macro print, whether the thesis quietly died while the price went nowhere.

**Fix:** `docs/04-trade-lifecycle.md` — a thesis-decay score recomputed on every feature update, a scale-out ladder derived from the MFE distribution rather than from round numbers, and a time-stop.

### Gap 5 — BTC and ETH are effectively one asset

Two 0.5%-risk positions, one long BTC and one long ETH, at a realistic correlation of 0.85:

```
portfolio heat = sqrt(wᵀ C w) = sqrt(0.25 + 0.25 + 2(0.5)(0.5)(0.85)) = 0.96%
```

versus 1.00% if you naively add them. You took on essentially the full risk of a doubled position and got 4% of diversification benefit. The effective number of independent positions is `(Σw)² / (wᵀCw) = 1.08`. You have one trade on, not two.

**Fix:** `docs/03-risk-and-portfolio.md` — correlation-adjusted heat as the binding constraint, and explicit netting when both assets point the same direction.

---

## 2. Enhanced architecture

The shape of your original pipeline survives. What changes is that a thick deterministic layer now sits between the agents and the output, and a learning loop feeds back into it.

```
        ┌──────────────────────────────────────────────────────────┐
        │  INGEST          market · derivatives · on-chain ·        │
        │                  news · macro · events                    │
        └────────────────────────────┬─────────────────────────────┘
                                     │
        ┌────────────────────────────▼─────────────────────────────┐
        │  POINT-IN-TIME FEATURE STORE                              │
        │  every row stamped (event_time, observed_at)              │
        │  data-quality gates → data_confidence ∈ [0,1]             │
        └────────────────────────────┬─────────────────────────────┘
                                     │
                 ┌───────────────────┼───────────────────┐
                 ▼                   ▼                   ▼
        ┌────────────────┐  ┌────────────────┐  ┌────────────────┐
        │ REGIME         │  │ ARCHETYPE      │  │ ANOMALY        │
        │ CLASSIFIER     │  │ DETECTOR       │  │ DETECTOR       │
        │ 6 regimes      │  │ 7 setup types  │  │ statistical    │
        └───────┬────────┘  └───────┬────────┘  └───────┬────────┘
                └───────────────────┼───────────────────┘
                                    │  candidate + regime + features
                                    ▼
        ┌──────────────────────────────────────────────────────────┐
        │  AI AGENT MESH  (4 agents in v1, event-triggered only)    │
        │  every claim must cite feature_ids; citations are         │
        │  verified against the snapshot before use                 │
        └────────────────────────────┬─────────────────────────────┘
                                     │  verified claims
                                     ▼
        ┌──────────────────────────────────────────────────────────┐
        │  EVIDENCE GRAPH                                           │
        │  dedupe claims by shared feature provenance               │
        │  → independent evidence set + N_eff                       │
        └────────────────────────────┬─────────────────────────────┘
                                     │
                                     ▼
        ┌──────────────────────────────────────────────────────────┐
        │  ENSEMBLE  →  CALIBRATION  →  p(win | archetype, regime)  │
        │  correlation-aware log-odds  isotonic / Platt             │
        └────────────────────────────┬─────────────────────────────┘
                                     │  calibrated probability
                                     ▼
        ┌──────────────────────────────────────────────────────────┐
        │  EXPECTED VALUE ENGINE                                    │
        │  levels from volatility + liquidity structure             │
        │  outcome distribution via analog bootstrap + MC           │
        │  minus fees / slippage / funding                          │
        │  → EV in R, EV in $, p5/p50/p95, CVaR                     │
        └────────────────────────────┬─────────────────────────────┘
                                     │
                                     ▼
        ┌──────────────────────────────────────────────────────────┐
        │  RISK ENGINE   (deterministic, no LLM, hard vetoes)       │
        │  EV hurdle · per-trade cap · portfolio heat · liquidity   │
        │  event blackout · data confidence · circuit breakers      │
        └────────────────────────────┬─────────────────────────────┘
                                     │
              ┌──────────────────────┼──────────────────────┐
              ▼                      ▼                      ▼
           VETOED                 WATCH              PAPER POSITION
        (reason logged)        (alert only)                 │
                                                            ▼
                                              ┌──────────────────────┐
                                              │  LIFECYCLE MANAGER   │
                                              │  thesis decay ·      │
                                              │  scale-out · trail · │
                                              │  time stop           │
                                              └──────────┬───────────┘
                                                         ▼
                                              ┌──────────────────────┐
                                              │  OUTCOME LEDGER      │
                                              │  triple-barrier      │
                                              │  labels, MFE/MAE     │
                                              └──────────┬───────────┘
                                                         │
             ┌───────────────────────────────────────────┘
             ▼
   ┌──────────────────────┐
   │  LEARNING LOOP       │──→ recalibration · agent scorecards ·
   │  monthly cadence     │    archetype stat refresh · drift alarms
   └──────────────────────┘
```

The arrow from the outcome ledger back into calibration is the part your original design was missing entirely, and it is what turns this from a dashboard into an engine.

---

## 3. The enhanced opportunity object

This replaces the JSON in your §3. Every added field exists to answer either "should I take this?" or "what is it worth?".

```jsonc
{
  "id": "opp_2026-09-13T14:32:00Z_BTC_001",
  "asset": "BTC",
  "direction": "LONG",

  // ── WHAT KIND OF TRADE IS THIS ──────────────────────────────
  "archetype": "COMPRESSION_BREAKOUT",
  "regime": { "label": "LOW_VOL_COMPRESSION", "confidence": 0.74 },
  "archetypePriorInRegime": {          // from the outcome ledger
    "n": 47, "winRate": 0.51, "medianR": 0.80, "meanR": 0.34
  },

  // ── HOW CONFIDENT, HONESTLY ─────────────────────────────────
  "rawEnsembleScore": 0.71,
  "calibratedWinProb": 0.44,           // ← the number that matters
  "calibratedWinProbCI90": [0.33, 0.55],
  "nEffectiveSignals": 2.3,            // 6 agents, 2.3 independent
  "calibrationVintage": "2026-08-31",  // stale ⇒ size gets haircut

  // ── LEVELS, DERIVED NOT GUESSED ─────────────────────────────
  "entry":    { "min": 104500, "max": 105200, "method": "VWAP_BAND_RETEST" },
  "stop":     { "price": 102900, "method": "ATR_2.0_BELOW_STRUCTURE",
                "distancePct": 1.81 },
  "targets": [
    { "price": 107000, "fraction": 0.40, "pHit": 0.58, "r": 1.16 },
    { "price": 109500, "fraction": 0.35, "pHit": 0.34, "r": 2.47 },
    { "price": 112000, "fraction": 0.25, "pHit": 0.19, "r": 3.79 }
  ],
  "timeStop": { "hours": 72, "action": "CLOSE_AT_MARKET" },

  // ── WHAT IS IT WORTH ────────────────────────────────────────
  "expectedValue": {
    "grossR": 0.31,
    "costR": 0.10,
    "netR": 0.21,
    "netUSD": 10.50,                   // at the sized position
    "distributionR": { "p5": -1.02, "p25": -1.00, "p50": 0.00,
                       "p75": 1.16,  "p95": 2.61 },
    "cvar5R": -1.04,
    "pProfit": 0.44,
    "expectedHoldHours": 31,
    "costBreakdown": { "feesR": 0.055, "slippageR": 0.022, "fundingR": 0.025 }
  },

  // ── HOW BIG ─────────────────────────────────────────────────
  "sizing": {
    "kellyFraction": 0.083,
    "appliedFraction": 0.021,          // quarter-Kelly, then haircuts
    "riskPctOfEquity": 0.42,
    "notionalUSD": 24200,
    "bindingConstraint": "PORTFOLIO_HEAT",
    "haircuts": ["CALIBRATION_UNCERTAINTY", "DATA_CONFIDENCE_0.91"]
  },

  // ── WHY, WITH RECEIPTS ──────────────────────────────────────
  "evidence": [
    { "claim": "Realized vol in 12th percentile of trailing 90d",
      "stance": "BULLISH", "strength": 0.6,
      "featureIds": ["btc.rv_30d_pct_rank"], "observedValue": 0.12,
      "agent": "technical", "verified": true, "cluster": "VOLATILITY" },
    { "claim": "OI +8% while funding flat — new positioning, not leverage chase",
      "stance": "BULLISH", "strength": 0.5,
      "featureIds": ["btc.oi_change_24h", "btc.funding_8h"],
      "agent": "derivatives", "verified": true, "cluster": "POSITIONING" }
  ],
  "evidenceClusters": ["VOLATILITY", "POSITIONING", "FLOW"],
  "droppedClaims": [
    { "claim": "Volume surging", "reason": "DUPLICATE_OF_CLUSTER_FLOW" },
    { "claim": "RSI at 71 on daily", "reason": "CITATION_MISMATCH",
      "claimedValue": 71, "actualValue": 58.3, "agent": "technical" }
  ],

  // ── WHAT KILLS IT ───────────────────────────────────────────
  "invalidations": [
    { "condition": "4h close < 102900", "type": "PRICE", "autoCheck": true },
    { "condition": "funding_8h > 0.04% for 2 consecutive periods",
      "type": "DERIVATIVE", "autoCheck": true },
    { "condition": "regime flips to HIGH_VOL_EXPANSION",
      "type": "REGIME", "autoCheck": true }
  ],
  "thesisDecayScore": 1.00,            // recomputed continuously, 1 → 0

  // ── EVENT EXPOSURE ──────────────────────────────────────────
  "eventRisk": {
    "level": "MEDIUM",
    "nextEvent": { "name": "US CPI", "inHours": 9.4,
                   "historicalAbsMove4h": 0.021 },
    "blackoutApplied": false
  },

  // ── ANALOGS: THE TRUST-BUILDING PANEL ───────────────────────
  "historicalAnalogs": {
    "method": "kNN_50_in_feature_space",
    "n": 50, "since": "2021-01-01",
    "hitTP1": 0.56, "hitStopFirst": 0.40,
    "medianR": 0.61, "worstR": -1.00, "bestR": 3.79,
    "medianHoldHours": 28
  },

  "state": "PAPER_OPEN",
  "vetoReasons": [],
  "replayHash": "sha256:a3f2…"         // prompts + model ids + feature snapshot
}
```

Two fields deserve special attention because they are the whole point.

`calibratedWinProb: 0.44` sitting next to `rawEnsembleScore: 0.71` is the system telling you the truth: the agents are enthusiastic, but historically this combination of evidence in this regime resolves favourably 44% of the time. At a 2.47R average payoff that is still a positive-EV trade — but you would never have known from the 0.71.

`droppedClaims` with a `CITATION_MISMATCH` is an automated hallucination catch. The technical agent asserted RSI was 71; the feature store says 58.3; the claim was discarded and the agent's reliability score was debited. Without this, that fabricated number silently props up the score.

---

## 4. What I am deliberately telling you not to build

Ambition is not the constraint here. Statistical power is. A swing engine on two assets produces somewhere between 2 and 6 candidates a week. Over two years that is roughly 300–600 labelled outcomes total. To distinguish a genuine 55% win rate from a coin flip at conventional significance you need:

```
n ≈ (z₀.₉₇₅ + z₀.₈)² · p(1−p) / δ²
  = (1.96 + 0.84)² × 0.25 / 0.05²
  ≈ 780 trades
```

That is three to four years of live signals. You will not out-sample this problem. Three consequences follow, and they shape the whole plan:

**Do not build fifteen agents.** Four, with verified citations and tracked marginal contribution. Every extra agent adds correlated noise and burns budget, and you will never have the data to prove agent nine earns its place. An agent stays only if removing it measurably worsens out-of-sample log-loss (`docs/05-ai-agent-layer.md` §7).

**Do not build a deep meta-model.** Regularized logistic regression with hierarchical pooling across archetypes. Gradient boosting on 400 samples memorizes noise, and the backtest will look wonderful.

**Do not evaluate on win rate.** Binary outcomes are the lowest-information measurement available. Use continuous metrics — realized R, MFE, MAE — which carry far more signal per sample and let you detect a working engine in months rather than years (`docs/07-validation-and-learning.md` §4).

Also dropped from v1: Kafka (Redis Streams is sufficient at this volume), options IV surface (Deribit is free but the modelling effort is large — deferred to Phase 8), fifteen-exchange adapters (three is plenty), and fully automated execution (not in this plan at all).

---

## 5. The MVP, precisely

Ten weeks of evenings, roughly. Everything below is Phase 1–4 in `docs/08-roadmap.md`.

Ingest BTC and ETH from Binance and Bybit — candles across 15m/1h/4h/1d, funding, open interest, liquidations, orderbook depth snapshots. Compute the feature set deterministically into TimescaleDB with point-in-time stamps. Classify regime. Detect three archetypes only: compression breakout, liquidation reversal, and trend continuation. Run four agents on event triggers. Dedupe evidence, aggregate with correlation awareness, calibrate against whatever history you have (initially a flat prior — and the system should *say* it is uncalibrated rather than pretend). Size with the EV engine. Enforce risk gates. Open paper positions. Manage them to close. Log everything to the outcome ledger. Show it on a dashboard and push alerts to Telegram.

The MVP is complete when it has run 60 unattended days and produced a reliability diagram — not when the dashboard looks good.

---

## 6. Honest expectations

Three things worth saying plainly, because plans like this tend to imply otherwise.

Most systematic retail crypto strategies have no edge after costs. The cost table in §1 is the reason: an apparent edge of 0.2R is entirely consumed by fees, slippage and funding, and funding in particular is a silent tax that scales with your holding period — precisely the wrong property for a swing system. The engine's first job is to tell you honestly when it has nothing, and `NO_SETUP` should be its most common output by a wide margin.

The AI agents are the least important component in this plan. The feature store, the calibration layer and the outcome ledger are where the value is. If you built this system with zero LLMs and replaced the agents with simple rule-based scores, it would still work — worse, but it would work. The reverse is not true.

Finally, a calibrated probability is not a guarantee. A 44% win probability means that across many trades, roughly 44 in 100 resolve favourably; it says nothing about the next one. The system should never be presented, to you or anyone else, as identifying profitable trades. It identifies *candidates with measurable, positive expected value after costs* — and it will be wrong often, by design.

---

## Document map

| Document | Covers |
|---|---|
| [`docs/01-decision-engine.md`](docs/01-decision-engine.md) | Regime classifier, archetypes, evidence graph, correlation-aware aggregation, calibration, gates |
| [`docs/02-expected-value-model.md`](docs/02-expected-value-model.md) | Level derivation, outcome distributions, cost model, EV, Bayesian fractional Kelly sizing |
| [`docs/03-risk-and-portfolio.md`](docs/03-risk-and-portfolio.md) | Deterministic vetoes, portfolio heat, circuit breakers, kill switch, state machine |
| [`docs/04-trade-lifecycle.md`](docs/04-trade-lifecycle.md) | Thesis decay, scale-outs, trailing, time stops, re-evaluation |
| [`docs/05-ai-agent-layer.md`](docs/05-ai-agent-layer.md) | Agent contracts, citation verification, abstention, provider abstraction, agent scoring |
| [`docs/06-data-and-features.md`](docs/06-data-and-features.md) | Sources, point-in-time correctness, quality gates, feature catalogue |
| [`docs/07-validation-and-learning.md`](docs/07-validation-and-learning.md) | Labeling, purged walk-forward CV, PBO, paper protocol, recalibration |
| [`docs/08-roadmap.md`](docs/08-roadmap.md) | Phases with hard exit criteria |
| [`docs/09-contracts.md`](docs/09-contracts.md) | TypeScript types and database schema |
