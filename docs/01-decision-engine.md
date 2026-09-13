# 01 — Decision Engine

**Answers:** *should this trade be taken at all?*
**Owns:** regime classification, archetype detection, evidence deduplication, ensemble aggregation, probability calibration, hard gates.
**Does not own:** how much profit (`02`), how much size (`02` §7), what happens after entry (`04`).

---

## 1. Design principle

The decision engine is deterministic code that consumes AI output as *testimony*, not as a verdict. An agent can raise evidence; it cannot set a probability, cannot bypass a gate, and cannot cite a number that the feature store does not corroborate.

The pipeline is strictly ordered, and each stage can only reduce or reshape conviction — never inflate it past what the calibration layer permits:

```
features ──► regime ──► archetype candidate ──► agent claims
                                                     │
                                      citation verification (drop liars)
                                                     ▼
                                      evidence graph (drop duplicates)
                                                     ▼
                                      correlation-aware aggregation
                                                     ▼
                                      calibration → p(win)
                                                     ▼
                                      hard gates → VETO or pass
```

---

## 2. Regime classifier

A breakout signal in a chop regime is not a weak signal, it is a *negative-expectancy* signal. Conditioning on regime is the cheapest large improvement available to you, which is why it comes first.

### 2.1 Regime features

All computed on 4h bars unless stated, all expressed as percentile ranks against a trailing 2-year window so that thresholds are scale-free and survive bull/bear transitions.

| Feature | Definition | Purpose |
|---|---|---|
| `rv_30d_rank` | Realized vol, 30d close-to-close, percentile rank | vol regime |
| `atr_ratio` | ATR(14) / ATR(100) | vol expansion vs contraction |
| `trend_z` | (EMA20 − EMA100) / ATR(14) | trend direction and strength |
| `adx_14` | ADX on daily | trend persistence |
| `hurst_200` | Hurst exponent, DFA method, 200 bars | trending (>0.55) vs mean-reverting (<0.45) |
| `acf1_4h` | Lag-1 autocorrelation of 4h returns, 200 bars | momentum vs reversal |
| `funding_30d_rank` | Mean 8h funding, 30d, percentile rank | leverage regime |
| `beta_ndx_30d` | Rolling 30d beta of BTC to Nasdaq futures | risk-on/off coupling |
| `drawdown_from_ath` | Current drawdown from 2y high | cycle position |

### 2.2 The six regimes

| Regime | Signature | Assumed duration |
|---|---|---|
| `TRENDING_UP` | `trend_z > 1.0`, `adx_14 > 22`, `hurst > 0.55` | 2–8 weeks |
| `TRENDING_DOWN` | `trend_z < −1.0`, `adx_14 > 22`, `hurst > 0.55` | 2–8 weeks |
| `RANGE_BOUND` | `|trend_z| < 0.5`, `adx_14 < 18`, `acf1 < 0` | 1–6 weeks |
| `LOW_VOL_COMPRESSION` | `rv_30d_rank < 0.20`, `atr_ratio < 0.7` | 1–3 weeks |
| `HIGH_VOL_EXPANSION` | `rv_30d_rank > 0.80`, `atr_ratio > 1.4` | 3 days – 2 weeks |
| `POST_CAPITULATION` | 24h liquidations > 99th pct **and** funding flipped negative **and** price < −10% over 72h | 3–10 days |

The duration column is a **prior, not a measurement.** These are the dwell times the thresholds were chosen to produce; nothing has measured them yet. Phase 2 replaces them with the empirical dwell-time distribution from the historical replay, and if the measured values differ materially the thresholds are wrong, not the market.

### 2.3 Implementation path

**Phase 2 (rules).** Score each regime with a weighted rule set, take the argmax, and emit `confidence = softmax margin`. Cheap, transparent, debuggable, and good enough to start conditioning on.

**Phase 6 (HMM).** A 4-to-6 state Gaussian HMM fitted on `(r_t, |r_t|, volume_z, funding_z)` over 4h bars. The HMM gives you two things rules cannot: a genuine posterior over regimes (so you can blend archetype priors instead of hard-switching) and a transition matrix, which lets the engine say *"72% chance we remain in compression over the next 24h"*. Fit with purged walk-forward — never on the full history.

Emit alongside every classification: `label`, `posterior` over all six, `hoursInRegime`, and `pRegimePersists24h`. Late-stage regimes are less trustworthy than fresh ones, and sizing should reflect that.

---

## 3. Setup archetypes

One global score across all trade types is a category error — a breakout and a mean-reversion trade have different payoff shapes, different hold times, different failure modes, and must carry their own statistics.

Each archetype is a first-class object with a detection predicate, its own level-derivation rules, its own historical statistics per regime, and a regime whitelist.

### 3.1 The catalogue

```
┌────────────────────────┬─────────────────────────────────────────────┐
│ COMPRESSION_BREAKOUT   │ Bollinger bandwidth < 20th pct for ≥ 12 bars│
│                        │ + range break with volume > 2σ              │
│                        │ + OI rising, funding not extreme            │
│ stop   2.0 × ATR(14) below the compression range low                 │
│ target volatility-cone projection at 1.0σ / 1.6σ / 2.2σ of hold      │
│ hold   12–48h     whitelist LOW_VOL_COMPRESSION, RANGE_BOUND         │
│ fails  when the break has no OI confirmation — that is a liquidity   │
│        sweep, not a breakout. Require OI Δ > 0 or veto.              │
├────────────────────────┼─────────────────────────────────────────────┤
│ LIQUIDATION_REVERSAL   │ 1h liquidations > 99th pct, one-sided > 80% │
│                        │ + funding flips against the flushed side    │
│                        │ + price reclaims the wick 50% within 4h     │
│ stop   below the liquidation wick extreme, 0.5 × ATR buffer          │
│ target prior consolidation VWAP, then range midpoint                 │
│ hold   8–36h      whitelist POST_CAPITULATION, HIGH_VOL_EXPANSION    │
│ fails  in sustained trends — a cascade in TRENDING_DOWN is a         │
│        continuation, not a reversal. Hard-vetoed there.              │
├────────────────────────┼─────────────────────────────────────────────┤
│ TREND_CONTINUATION     │ regime trending + pullback to EMA20/VWAP    │
│                        │ + pullback volume < impulse volume          │
│                        │ + OI falls on pullback (weak hands out)     │
│ stop   beyond the last higher-low / lower-high, 1.5 × ATR buffer     │
│ target measured move of the prior impulse leg, 0.6 / 1.0 / 1.4×      │
│ hold   24–96h     whitelist TRENDING_UP, TRENDING_DOWN               │
│ fails  at trend exhaustion — veto if this is the 4th+ pullback in    │
│        the leg, or if momentum diverges on 4h.                       │
├────────────────────────┼─────────────────────────────────────────────┤
│ FUNDING_SQUEEZE        │ funding > 95th pct for ≥ 3 periods          │
│                        │ + OI at local high + LSR skewed             │
│                        │ + price failing to make new highs           │
│ stop   above the failed high, 1.0 × ATR                              │
│ target prior liquidation cluster below (heatmap proxy)               │
│ hold   6–24h      whitelist any except POST_CAPITULATION             │
│ fails  when strong spot demand absorbs the unwind. Require spot CVD  │
│        confirmation or downgrade to WATCH.                           │
├────────────────────────┼─────────────────────────────────────────────┤
│ RANGE_FADE             │ price at range extreme (≥ 2 prior touches)  │
│                        │ + RSI divergence + orderbook absorption     │
│ stop   1.2 × ATR beyond the range boundary                           │
│ target range midpoint, then opposite third                           │
│ hold   12–48h     whitelist RANGE_BOUND only                         │
│ fails  catastrophically on range breaks. Position at half size, and  │
│        veto if compression is building (breakout risk).              │
├────────────────────────┼─────────────────────────────────────────────┤
│ EVENT_VOL_EXPANSION    │ scheduled catalyst < 24h + IV/RV elevated   │
│                        │ + positioning light (OI below 40th pct)     │
│ Directionally agnostic in v1 → emits WATCH and a blackout window,    │
│ not a directional trade. Becomes tradeable only in Phase 8 with      │
│ options data. Listed here so the event engine has somewhere to route.│
├────────────────────────┼─────────────────────────────────────────────┤
│ FLOW_DIVERGENCE        │ spot CVD and perp CVD diverge > 2σ over 24h │
│                        │ + exchange netflow confirms                 │
│ stop   2.0 × ATR against the spot-implied direction                  │
│ target prior swing in the spot-implied direction                     │
│ hold   24–72h     whitelist all except HIGH_VOL_EXPANSION            │
│ fails  when the divergence is a basis/arb artefact rather than       │
│        directional demand. Check basis before accepting.             │
└────────────────────────┴─────────────────────────────────────────────┘
```

MVP builds the first three. The rest are Phase 6.

### 3.2 The archetype × regime expectancy matrix

This table *is* the engine's institutional memory. It is populated by historical replay (§8) and then updated live from the outcome ledger.

```
                        TREND_UP  TREND_DN  RANGE  LOW_VOL  HIGH_VOL  POST_CAP
COMPRESSION_BREAKOUT      ✓         ✓         ✓      ✓✓       ✗         ✗
LIQUIDATION_REVERSAL      ✗         ✗         ✓      ✗        ✓✓        ✓✓
TREND_CONTINUATION        ✓✓        ✓✓        ✗      ✗        ✓         ✗
FUNDING_SQUEEZE           ✓         ✓         ✓      ✓        ✓         ✗
RANGE_FADE                ✗         ✗         ✓✓     ✓        ✗         ✗
FLOW_DIVERGENCE           ✓         ✓         ✓      ✓        ✗         ✓

✓✓ primary   ✓ permitted   ✗ hard veto
```

Each permitted cell stores `{n, winRate, meanR, medianR, stdR, medianHoldHours, lastUpdated}`. A cell with `n < 20` is flagged low-confidence and forces minimum sizing. The `✗` cells are not soft penalties — they are vetoes, enforced in §7.

---

## 4. The evidence graph

This is the fix for the problem you identified and did not solve: six agents agreeing is not six confirmations.

### 4.1 Every claim carries provenance

An agent cannot say "momentum is strong". It must emit:

```jsonc
{
  "claim": "Open interest rose 8.2% over 24h while funding stayed below the 60th percentile",
  "stance": "BULLISH",
  "strength": 0.5,              // agent's own magnitude, −1..1
  "featureIds": ["btc.oi_change_24h", "btc.funding_8h_pct_rank"],
  "observedValues": { "btc.oi_change_24h": 0.082,
                      "btc.funding_8h_pct_rank": 0.54 }
}
```

### 4.2 Citation verification

Before any claim enters the graph, every `observedValue` is compared against the feature snapshot the agent was given.

```
|claimed − actual| / max(|actual|, ε) > 0.05   →   claim REJECTED
featureId not in snapshot                      →   claim REJECTED
```

Rejected claims are logged to `droppedClaims` with `reason: CITATION_MISMATCH` and debit the agent's reliability score. If an agent's rejection rate over a 30-claim rolling window exceeds 15%, it is automatically suspended and an alert fires. This turns hallucination from a silent corruption into a monitored, measurable failure mode — arguably the single highest-value control in the whole system.

### 4.3 Cluster assignment and collapse

Every feature belongs to exactly one **evidence cluster**:

| Cluster | Example features |
|---|---|
| `PRICE_STRUCTURE` | swing highs/lows, S/R levels, EMA relationships, measured moves |
| `VOLATILITY` | ATR, Bollinger bandwidth, realized vol ranks, vol-of-vol |
| `FLOW` | volume, CVD, spot/perp volume split, trade-size distribution |
| `POSITIONING` | open interest, funding, long/short ratio, basis |
| `LIQUIDATION` | liquidation volume, one-sidedness, cascade detection |
| `ORDERBOOK` | depth imbalance, spread, absorption, resting-size clusters |
| `ONCHAIN` | exchange netflows, whale transfers, MVRV, SOPR, staking |
| `NEWS` | article sentiment × importance, regulatory, exchange notices |
| `MACRO` | DXY, yields, equity beta, rate expectations |
| `EVENT` | scheduled catalysts, time-to-event, historical event impact |

Within a cluster, claims are collapsed:

```
effective_strength(cluster) = max_i(|sᵢ|) + λ · Σ_{i ≠ argmax} |sᵢ|

λ = 0.3
```

The strongest claim in a cluster counts fully; siblings contribute at 30%. Not zero — a second independent read of the same cluster does carry a little information — but nowhere near full credit. The collapsed strength inherits the sign of the strongest claim; if signs conflict within a cluster, the conflict is recorded and the net strength is reduced by the opposing magnitude (see §6.3).

### 4.4 Why this is the important part

Consider a real case. Volume expands sharply. The technical agent calls it a breakout confirmation. The derivatives agent notes OI rising alongside it. The quant agent flags a 4.2σ volume anomaly. The news agent finds an article *about the volume spike*.

Naive aggregation: four bullish claims, ensemble score jumps to 0.85.
Evidence graph: three of those claims resolve to `FLOW`, collapse to one strength of roughly `0.6 + 0.3(0.5 + 0.4) = 0.87` in a single cluster; the OI claim lands in `POSITIONING`. Two clusters, not four claims. Score lands near 0.62.

That gap — 0.85 versus 0.62 — is the difference between a position that gets sized up into a crowded move and one that gets sized appropriately.

---

## 5. Correlation-aware aggregation

Clusters are less correlated than raw claims, but they are not independent either: `FLOW` and `POSITIONING` move together; `VOLATILITY` and `LIQUIDATION` move together. So the ensemble shrinks.

### 5.1 Log-odds accumulation

Start from the archetype prior, which anchors everything:

```
L_prior = logit( winRate[archetype][regime] )       // from §3.2
```

Each cluster contributes:

```
lⱼ = w_cluster[j] · effective_strength(j) · reliability[agent, regime] · κ
```

where `w_cluster` are the cluster weights (below), `reliability` is the agent's Beta-posterior mean accuracy in the current regime (`05` §7), and `κ` is a scale constant fitted during calibration — it is *not* hand-tuned.

### 5.2 The shrinkage

```
N      = number of contributing clusters
C      = correlation matrix of cluster scores, estimated from ≥ 250
         historical snapshots, Ledoit-Wolf shrunk toward the identity
w      = vector of |lⱼ|

N_eff  = (Σⱼ |lⱼ|)² / (wᵀ C w)

L      = L_prior + (N_eff / N) · Σⱼ lⱼ
```

The behaviour at the limits is exactly right. If all clusters were perfectly correlated, `N_eff = 1` and the formula reduces to the *average* cluster contribution — one witness, not N. If perfectly independent, `N_eff = N`, and you get the full sum. Everything in between interpolates smoothly.

In practice on BTC/ETH you should expect `N_eff` between 1.5 and 3.0 even when eight clusters are firing. Publishing `nEffectiveSignals` on the opportunity object keeps this visible rather than buried.

### 5.3 Conflict handling

Contradiction is information, and averaging it away is a mistake. Compute:

```
conflict = Σ|lⱼ over minority sign| / Σ|lⱼ over all|
```

If `conflict > 0.35`, the opportunity is downgraded to `WATCH` regardless of net score, and the conflicting clusters are surfaced prominently in the UI. A genuinely strong setup should not have a third of its evidence pointing the other way; when it does, you are usually early.

### 5.4 Starting cluster weights

Hand-set for cold start, then re-fitted by the meta-model once `n ≥ 300` (§6.3). These are priors, not truths.

| Cluster | Weight | Rationale |
|---|---|---|
| `POSITIONING` | 0.18 | Best-documented short-horizon edge in crypto perps |
| `PRICE_STRUCTURE` | 0.16 | Defines the levels; necessary but widely known |
| `FLOW` | 0.15 | Confirms or denies structure |
| `LIQUIDATION` | 0.12 | High signal, low frequency |
| `VOLATILITY` | 0.10 | Mostly a sizing input, some directional content |
| `ORDERBOOK` | 0.09 | Strong but decays fast at swing horizon |
| `ONCHAIN` | 0.08 | Slow-moving; free-tier quality is poor (see `06`) |
| `NEWS` | 0.06 | Usually priced before you can act |
| `MACRO` | 0.04 | Sets the backdrop, rarely times an entry |
| `EVENT` | 0.02 | Mostly used as a veto, not a signal |

`NEWS` is deliberately low. By the time an RSS feed delivers an article, the move is typically done. News earns its keep as an *invalidator* (`04` §3), not as an entry trigger.

---

## 6. Calibration — the layer that makes scores mean something

`p_raw = sigmoid(L)` is an ordinal score. It ranks opportunities. It is not a probability until it has been checked against outcomes.

### 6.1 Method by sample size

| Labelled samples in stratum | Method |
|---|---|
| `n < 50` | **No calibration.** Emit `calibrated: false`, use the archetype base rate with a wide CI, force minimum sizing |
| `50 ≤ n < 300` | **Platt scaling** — `p = sigmoid(a · logit(p_raw) + b)`, two parameters, fitted by MLE |
| `n ≥ 300` | **Isotonic regression** — monotone, non-parametric, no functional-form assumption |

Strata are `(archetype, regime_group)` where regime groups collapse the six regimes into three (trending / ranging / volatile) to preserve sample size. Fitting per-cell on six regimes would leave you with a dozen samples each.

### 6.2 Hierarchical pooling

Do not fit each stratum in isolation. Fit a global Platt `(a, b)` across all strata, then per-stratum deviations shrunk toward the global fit by `n / (n + n₀)` with `n₀ = 75`. A stratum with 25 samples sits mostly on the global curve; a stratum with 400 samples moves substantially toward its own. This is the standard partial-pooling trade-off and it is essential at your sample sizes.

### 6.3 Uncertainty on the probability

A point estimate of `p` is not enough — sizing must know how much to trust it. For an isotonic bin containing `k` wins out of `n`, place a Jeffreys prior and take the posterior:

```
p | data  ~  Beta(k + 0.5,  n − k + 0.5)

calibratedWinProb     = posterior mean
calibratedWinProbCI90 = [q₀.₀₅, q₀.₉₅]
```

The width of that interval feeds directly into the sizing haircut in `02` §7.4. A 44% win probability known to ±3pp and one known to ±14pp are not the same trade.

### 6.4 Monitoring

Recomputed monthly and on every recalibration, per stratum and globally:

- **Brier score** with Murphy decomposition into reliability, resolution and uncertainty. Resolution is what you care about — it measures whether the score separates outcomes at all. Reliability measures whether it is honest about it.
- **Log loss**, against a baseline of always predicting the base rate. If the engine cannot beat the base rate on log loss, it has no edge and should say so on the dashboard.
- **Expected calibration error**, 10 equal-mass bins.
- **Reliability diagram**, rendered on the dashboard, not hidden in a notebook.

Alarm thresholds: `ECE > 0.10`, or log loss worse than base rate for two consecutive months, triggers `CALIBRATION_DEGRADED` — which caps sizing at 50% until refit.

### 6.5 The meta-model (Phase 6, optional)

Once `n ≥ 300`, a level-1 model may replace the linear ensemble. Constraints are tight and deliberately unambitious:

**Model:** elastic-net logistic regression. Not gradient boosting. With 400 samples and 25 features, GBMs memorize noise and produce beautiful, worthless backtests.
**Features:** 10 cluster scores, regime posterior (6), archetype one-hot (7), `data_confidence`, `hours_to_next_event`, `rv_30d_rank`, `N_eff`, `conflict`.
**Selection:** nested purged walk-forward CV with embargo (`07` §3) for λ and the L1/L2 mix.
**Promotion rule:** replaces the linear ensemble only if it beats it on out-of-sample log loss in **every** walk-forward fold, not on the average. A model that wins on average and loses in two of five folds is fitting regime-specific noise.

Until promoted, it runs in shadow mode with its predictions logged but unused.

---

## 7. Hard gates

Evaluated after calibration, deterministic, no AI involvement, in this order. First failure wins and is recorded in `vetoReasons`.

```
G1  ARCHETYPE_REGIME_VETO     cell is ✗ in the §3.2 matrix
G2  DATA_CONFIDENCE           data_confidence < 0.70            (see 06 §5)
G3  UNVERIFIED_EVIDENCE       > 30% of claims failed citation check
G4  CONFLICT                  conflict > 0.35                → WATCH not VETO
G5  INSUFFICIENT_EDGE         p_calibrated < breakeven_p + 0.05  (see 02 §6)
G6  NEGATIVE_NET_EV           EV_net < +0.15 R                   (see 02 §6)
G7  EVENT_BLACKOUT            tier-1 macro event within 4h and
                              archetype ≠ EVENT_VOL_EXPANSION
G8  PORTFOLIO_HEAT            would push heat > 1.5%             (see 03 §3)
G9  CORRELATION_STACK         same-direction position in the
                              correlated asset already open      (see 03 §4)
G10 LIQUIDITY                 required size > 8% of 1% -depth book
G11 STALE_CALIBRATION         calibration vintage > 45 days   → size cap 50%
G12 CIRCUIT_BREAKER           any breaker tripped                (see 03 §5)
```

G5 deserves a note. The breakeven win probability for a payoff ratio `b` is `1/(1+b)`. At `b = 2.5` that is 28.6%. Requiring `p_calibrated ≥ 33.6%` demands a real 5-percentage-point margin over breakeven — enough to survive calibration error rather than sitting exactly on the knife edge.

---

## 8. Cold start — how this behaves on day one

With zero history, every statistic above is undefined. The honest answer is to run the engine in a reduced mode and say so, rather than emit confident-looking numbers backed by nothing.

**Stage A — historical replay (do this before writing any UI).** Run the deterministic archetype detector across 2021-01-01 to present on 4h bars for BTC and ETH. Label every detection with the triple-barrier method (`07` §2). This yields several hundred labelled outcomes and populates the §3.2 matrix, the cluster correlation matrix `C`, and an initial Platt calibration — all before the system has ever traded.

The honest limitation: you cannot reconstruct LLM agent claims for 2021 without severe point-in-time contamination (the models know what happened). So historical replay calibrates the **deterministic score only**. The agent contribution `κ` starts at 0 and is raised only as live agent claims accumulate. This split is deliberate and should be visible on the dashboard as two scores: `deterministic` (calibrated from replay) and `blended` (calibrated live, initially identical).

**Stage B — live, uncalibrated (weeks 1–8).** Opportunities are emitted as `WATCH` only. Paper positions open at fixed minimum size regardless of score, so that the outcome ledger accumulates unbiased samples across the score range. Sizing by an uncalibrated score would bias the very data you need to calibrate with — this is not a detail, it is the difference between a usable dataset and a useless one.

**Stage C — live, calibrated (from n ≥ 50 per stratum).** Platt calibration active, EV-based sizing enabled, agents contributing at a `κ` scaled by their accumulated reliability.

**Stage D — mature (from n ≥ 300).** Isotonic calibration, meta-model eligible for shadow evaluation.

The dashboard must display the current stage and the sample counts behind every probability. A user — including you, six months from now — should never see `p = 0.44` without also seeing whether it rests on 31 samples or 310.
