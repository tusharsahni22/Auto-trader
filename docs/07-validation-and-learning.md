# 07 — Validation & Learning Loop

**Answers:** *does this actually work, and how would I know?*
**Owns:** labelling, cross-validation, overfitting controls, benchmarks, the paper-trading protocol, recalibration.

---

## 1. The constraint everything else bends around

A swing engine on two assets generates 2–6 candidates per week. Over two years that is roughly 300–600 labelled outcomes. Every methodological choice in this document is a response to that scarcity.

To separate a true 55% win rate from a coin flip at 95% confidence and 80% power:

```
n ≈ (z₀.₉₇₅ + z₀.₈)² · p(1−p) / δ²
  = (1.96 + 0.84)² × 0.25 / 0.05²
  ≈ 780 trades
```

The continuous version — detecting a mean of +0.15R against a per-trade standard deviation of 1.2R — needs about 500. Better, but not a solution:

```
n ≈ 7.84 × 1.44 / 0.0225 ≈ 500 trades
```

At four signals a week that is two and a half years. You cannot measure your way out of this in a reasonable timeframe by counting trades alone. Three things actually help, and they are what §2–§5 build toward.

**Historical replay** produces several hundred labelled samples before you trade at all — for the deterministic layer only, but that is the layer that matters most.

**Measuring the full candidate set**, including vetoed and never-triggered opportunities, multiplies your sample. Every detection has an MFE, an MAE and a forward path whether or not you traded it. Vetoed opportunities are a control group, and without them you cannot tell whether your gates reject bad trades or good ones.

**Measuring more per trade** — realized R, MFE, MAE, time-to-MFE, capture ratio, calibration error — extracts far more information from each sample than a binary win/loss.

---

## 2. Labelling: the triple barrier

Every candidate, traded or not, gets a label by simulating three barriers forward from the decision timestamp.

```
Upper  first target price
Lower  stop price
Time   archetype maximum hold

Label  which barrier is touched first
Also   realized_R under the full management rules
       MFE_R, MAE_R, hours_to_MFE, hours_to_barrier
```

Three implementation details that determine whether the labels are trustworthy:

**Use intrabar data.** Labelling from 4h closes will miss stops that were hit and recovered within the bar. Use 1-minute or finer bars for barrier detection even when the signal is on 4h.

**Break ties conservatively.** If a single fine-grained bar touches both barriers, label it as the stop. You cannot know the order, and assuming the favourable one is exactly how backtests acquire fictional edge.

**Apply the real management rules.** Labels must reflect scale-outs, breakeven moves and trailing stops from `04`, not a naive target-or-stop assumption. Otherwise you are calibrating against a strategy you do not run.

Labelling windows overlap — a Monday signal and a Tuesday signal share forward path. This is the reason for the purging in §3, and ignoring it inflates apparent significance substantially.

---

## 3. Purged walk-forward cross-validation

Standard k-fold is invalid here. Overlapping labels leak information across the train/test boundary in both directions.

```
Timeline ───────────────────────────────────────────────────►

 [════ train ════]  ✂ purge ✂  [═ test ═]  ⊘ embargo ⊘  [═ train ═]

 purge    remove training samples whose LABEL WINDOW overlaps
          any test sample's decision time
 embargo  drop a fixed span (5 days) after the test set before
          training resumes — kills serial-correlation leakage
```

Configuration: anchored walk-forward with expanding train windows, a minimum 6-month initial train, 1-month test folds stepping forward monthly, purge equal to the maximum label horizon (96h), and a 5-day embargo. Report every fold separately, never only the average — a model that wins on average and loses in two of five folds is fitting regime-specific noise and will fail live.

The same purge and embargo apply to the analog search in `02` §3.2. An analog drawn from three days before the current signal shares most of its forward path with it, and using it is circular.

---

## 4. Metrics, in priority order

### 4.1 Calibration first

Before any return metric, answer: are the probabilities honest?

| Metric | Target | Meaning |
|---|---|---|
| Brier score | < base-rate Brier | Overall probabilistic accuracy |
| Brier *resolution* | > 0.01 | Does the score separate outcomes at all? The one that matters |
| Brier *reliability* | < 0.01 | Are stated probabilities honest? |
| Log loss | < base-rate log loss | Punishes confident errors properly |
| ECE, 10 bins | < 0.08 | Average calibration gap |
| Reliability diagram | On the dashboard | Visual, and the fastest way to spot a problem |

If the engine cannot beat the base rate on log loss, it has no edge and the dashboard should say so in plain language rather than displaying a score.

### 4.2 Then outcome quality

| Metric | Note |
|---|---|
| Mean realized R, with standard error | The headline number |
| Median R | Divergence from the mean reveals tail dependence |
| Expectancy per trade in currency, net of all costs | What you actually earn |
| Profit factor | Gross wins / gross losses |
| Capture ratio | `04` §8 — diagnoses management separately from signal |
| Max drawdown, and drawdown duration | Duration is the one that ends projects |
| Sharpe and Sortino, annualized | Report alongside deflated Sharpe (§5) |
| Longest losing streak vs predicted | Direct calibration check on the outcome distribution |

### 4.3 And the diagnostics that localize failure

Realized versus predicted EV, bucketed by score decile. Realized versus modelled slippage. Realized versus modelled funding. Win rate by archetype, by regime, and by archetype × regime. Agent MIC (`05` §7). Veto counterfactuals — the realized R of trades your gates rejected.

The veto counterfactual is the most useful diagnostic in the list and the one that is never built. If your `PORTFOLIO_HEAT` vetoes have a mean realized R of +0.4, your heat limit is costing you money and should be revisited. If they run at −0.2, it is earning its keep. Either way you now know.

---

## 5. Overfitting controls

You will try many configurations. Each one is a chance for noise to look like signal.

### 5.1 The trial registry

Every backtest run is logged: timestamp, config hash, parameter values, data range, and result. No exceptions, including runs you abandon mid-way and runs whose results you dislike. The count `N` of trials is an input to the statistics below, and an unlogged trial is a silent corruption of your own significance tests.

### 5.2 Deflated Sharpe Ratio

Raw Sharpe is meaningless once you have tried N configurations, because the maximum of N draws from a zero-skill distribution is systematically positive. Under the null, the expected maximum Sharpe across N independent trials is approximately:

```
E[max SR] ≈ σ_SR · [ (1 − γ)·Z⁻¹(1 − 1/N) + γ·Z⁻¹(1 − 1/(N·e)) ]

γ = 0.5772 (Euler–Mascheroni)
σ_SR = standard deviation of Sharpe ratios across your trials
```

Then, accounting for the non-normality of trade returns:

```
              ⎡  (SR − SR₀) · √(T − 1)                    ⎤
DSR = Z ⎢ ───────────────────────────────────────── ⎥
              ⎣  √(1 − γ₃·SR + ((γ₄ − 1)/4)·SR²)         ⎦

SR₀ = E[max SR]   γ₃ = skewness   γ₄ = kurtosis   T = observations
```

DSR is the probability that true skill is positive. **Require DSR > 0.95 before promoting anything.** Trade returns from a system with scale-outs are strongly negatively skewed and fat-tailed, so the correction term is not cosmetic — it typically knocks a meaningful amount off a raw Sharpe.

### 5.3 Probability of Backtest Overfitting

Combinatorially symmetric cross-validation. Split the data into S = 16 blocks. For each of the `C(16, 8)` train/test partitions, pick the configuration that performs best in-sample and record its out-of-sample rank among all configurations.

```
PBO = fraction of partitions where the in-sample-best
      configuration ranks below the OOS median
```

`PBO > 0.5` means your selection process is worse than choosing at random. **Require PBO < 0.30.** This measures the *selection procedure*, not a single strategy, which is exactly what you need when you have tried forty variants.

### 5.4 Complexity discipline

Every parameter you tune is a trial. Prefer values fixed from first principles over values fitted — the `λ = 0.3` cluster decay, the quarter-Kelly fraction, the 5% citation tolerance are all set by reasoning, not optimization, and that is deliberate. Before adding a parameter, ask whether you could instead derive it. Before adding a feature, check its correlation with existing features; a feature at 0.9 correlation with one you already have adds trials without adding information.

---

## 6. Benchmarks

A strategy is only good relative to something. Every evaluation reports against all four:

| Benchmark | Why |
|---|---|
| Buy and hold BTC | The honest bar. Most crypto strategies lose to it |
| 50/50 BTC/ETH, monthly rebalanced | Passive with the same universe |
| Random entry, same levels and management | Isolates entry timing from management. **The most diagnostic of the four** |
| Archetype detection, no agents, no calibration | Isolates what the AI and calibration layers actually add |

The random-entry benchmark is the one to build first. Generate entries at random timestamps, apply identical stops, targets, sizing and management, and run a thousand of them. If your engine does not clearly beat it, your signal contributes nothing and all your value is in the risk management — which is worth knowing, and is not a disaster, but it means you should stop spending on model calls.

---

## 7. The LLM backtesting problem

You raised this in §23 of your original design. It is more severe than point-in-time data handling can fix.

The problem: a model asked to analyze March 2024 BTC conditions may already know what happened in April 2024. Not through a data leak in your pipeline — through its training corpus. No amount of careful `observed_at` filtering addresses this, because the leak is inside the model.

**The honest position:** you cannot validly backtest the LLM layer on historical data. Accept it and design around it.

**What that means in practice.** Historical replay validates the deterministic layer only — archetype detection, feature computation, level derivation, calibration of the deterministic score, the EV engine, and the management rules. That is the large majority of the system, and it is the part where validation matters most. The agent contribution weight `κ` starts at zero (`01` §8) and rises only on live, forward evidence.

**A partial mitigation worth implementing.** Strip identifying information from snapshots: no dates, no absolute prices, no absolute market caps. Express everything in relative or ATR-normalized terms — *"price is 1.8 ATR above the 20-EMA, funding at the 54th percentile of its trailing 30-day range"*. A model cannot look up what happened next if it does not know when or where it is. Imperfect, since a sufficiently distinctive configuration is still recognizable, but it materially reduces contamination and costs nothing.

**And a contamination test you can actually run.** Feed the anonymized snapshot to the model and ask it to name the date and the asset. If it can do this materially better than chance, your anonymization is insufficient and any historical agent evaluation is void. Run this before trusting any historical agent result, and re-run it whenever a provider updates a model.

---

## 8. Paper trading protocol

Paper trading is not a demo. It is the experiment that determines whether this system is real, and it must be run with the discipline of one.

### 8.1 Rules

Run continuously, unattended, for a minimum of 60 calendar days. No manual intervention, no skipped signals, no "that one obviously wouldn't have worked" exclusions — the moment you start filtering by judgment, the sample is contaminated and the 60 days are wasted.

Model fills honestly: limit orders fill only when price trades *through* the level, not merely to it; market orders fill at modelled slippage from the live book, not at mid; stops fill with the 2× slippage multiplier from `02` §5.2; funding is charged at actual settlement timestamps.

Log everything: signal time, every agent response, the full snapshot, all gate evaluations, fills, every stop movement, and the exit with its reason.

Any config change restarts the clock. Every one of them.

### 8.2 Exit criteria — all required

These are the conditions for considering semi-automatic live execution at quarter size. Not for declaring success.

```
☐ ≥ 60 calendar days of continuous unattended operation
☐ ≥ 40 closed positions
☐ ECE ≤ 0.08 over the full period
☐ Log loss beats base rate
☐ Realized mean R within 1 SE of predicted mean R
☐ Realized slippage within 2× modelled, no systematic bias
☐ Realized funding within 20% of modelled
☐ Capture ratio ≥ 0.40
☐ Max drawdown ≤ the p95 drawdown from simulation
☐ Zero INV1 or INV3 violations in the final 30 days
☐ Kill-switch drill executed and passed
☐ Beats the random-entry benchmark with DSR > 0.95
☐ At least one full circuit-breaker trip handled correctly
```

Note what is absent: there is no profit threshold. A system that is well-calibrated, correctly costed and operationally sound but produces a mean R near zero has *told you the truth* — which is a successful outcome for the experiment, and a clear signal not to risk money. The failure mode to guard against is a profitable 60 days with poor calibration, because that is luck, and it will revert.

### 8.3 If it fails

Failing the criteria is the expected outcome of a first attempt and is not a reason to loosen them. Diagnose with §4.3, fix the specific defect, and restart the 60 days. Two or three cycles is normal.

---

## 9. Recalibration and drift

| Cadence | Action |
|---|---|
| Daily | Data quality report, invariant check summary, breaker status |
| Weekly | Calibration snapshot, open-position review, cost model vs realized |
| Monthly | Full recalibration fit, agent scorecards with MIC, archetype × regime stat refresh, veto counterfactual review |
| Quarterly | Walk-forward re-validation, correlation matrix refit, trial registry review, DSR/PBO recomputation |
| On trigger | Any breaker firing, any provider model change, any regime transition to a state with < 20 samples |

Drift detection runs continuously: population stability index on the feature distributions, calibration slope on a rolling 50-trade window, mean realized minus predicted R against its standard error, and agent rejection and abstention rates. The `EV_DIVERGENCE` breaker in `03` §5 is the automated response.

Recalibration must itself be walk-forward. Refitting on all data including the most recent period and then claiming the recent period as validation is circular — and it is the easiest mistake in the world to make when you are refitting monthly and under mild pressure for the numbers to look good.

---

## 10. Opportunity replay

Your §33 idea, and it is a good one. Every opportunity — traded, vetoed, or never triggered — is permanently reconstructable:

```
Opportunity #1842 · 2026-09-13 14:32 UTC · BTC LONG · COMPRESSION_BREAKOUT

  Feature snapshot at decision time            [full, 90 features]
  Regime: LOW_VOL_COMPRESSION (conf 0.74)
  Agent responses                              [4, raw + parsed]
  Claims admitted: 6   dropped: 2 (1 duplicate, 1 citation mismatch)
  N_eff 2.3 · raw score 0.71 · calibrated p 0.44 [CI 0.33–0.55]
  EV net +0.21R · sized 0.42% · bound by PORTFOLIO_HEAT
  Gates: all passed
  ───────────────────────────────────────────────────────────────
  Outcome: TP1 hit at +18h, trailed out at +1.31R
  MFE 1.84R · MAE 0.42R · capture 0.71 · hold 31h
  Realized vs predicted EV: +1.31 vs +0.21  (within p75–p95)
  Cost realized 0.11R vs modelled 0.10R
```

Beyond post-mortems, this store is what makes counterfactual analysis possible. Replay the full history with one component changed — a different cluster weight, no adversary agent, a wider breakeven trigger — and measure the difference on out-of-sample folds. That is how the engine improves over time without you guessing, and it is only possible because every decision was recorded completely at the moment it was made.
