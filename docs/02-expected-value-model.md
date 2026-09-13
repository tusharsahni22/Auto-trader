# 02 — Expected Value & Profit Model

**Answers:** *what is this trade worth, and how much should I put on?*
**Owns:** level derivation, outcome distributions, cost modelling, EV, position sizing.
**Consumes:** `calibratedWinProb` and its CI from `01`, volatility and liquidity features from `06`.

---

## 1. Why `riskReward: 2.8` is not a profit model

A reward-to-risk ratio describes the *geometry* of a trade. It says nothing about whether the trade makes money. Three things are missing from it, and each one is large enough to flip a strategy's sign.

**Probability.** A 2.8:1 setup needs a 26.3% win rate just to break even before costs. Without a calibrated probability the ratio is decorative.

**Path dependence.** Real swing trades do not resolve as "target or stop". They scale out at the first level and trail the rest, or they drift for two days and hit a time stop, or they get closed early because the thesis died. Each of those has a different payoff, and the mix of them is what you actually earn.

**Costs.** Fees, slippage and — for perpetuals held over days — funding. Section 5 shows these routinely consume 0.10R to 0.30R, which is frequently the entire edge.

What follows replaces the ratio with a distribution.

---

## 2. Level derivation — stops and targets are computed, never guessed

An LLM proposing `112000` as a target is picking a round number. Levels must come from volatility and liquidity structure, and they must be checked against whether price historically *reaches* them from setups like this one.

### 2.1 Stop placement

The stop is placed first, because it defines R and therefore everything downstream.

```
stop = structural_level  ∓  k · ATR(14)
```

`structural_level` is archetype-specific (`01` §3.1) — the compression range low, the liquidation wick extreme, the last higher-low. The ATR buffer `k` (typically 1.2–2.0) keeps you outside ordinary noise.

Two mandatory validity checks:

**Noise floor.** `stop_distance ≥ 1.0 × ATR(14)` on the signal timeframe. A stop inside one ATR is a coin flip against random walk, and §5.4 shows it also multiplies your cost ratio.

**Cost ceiling.** `total_cost_R ≤ 0.25`. If the stop is tight enough that fees, slippage and funding exceed a quarter of R, widen the stop or reject the setup. This check alone will kill a surprising number of otherwise attractive-looking trades, which is the point.

### 2.2 Target placement

Candidate levels come from five sources, and the engine takes the ones that survive:

| Source | Method |
|---|---|
| Volatility cone | Project `σ_horizon` at 1.0 / 1.6 / 2.2 standard deviations of the expected hold |
| Structure | Prior swing highs/lows, range boundaries, untested breakout retests |
| Liquidity | Resting-size clusters in the orderbook; estimated liquidation clusters from OI × leverage distribution |
| Measured move | Impulse-leg projection for continuation archetypes |
| Volume profile | High-volume nodes (magnets) and low-volume nodes (fast travel) |

Candidates within 0.3 ATR of each other are merged. The final three are chosen to be monotonically spaced with the first at roughly 1.0–1.3R, because §7 shows that the first scale-out does most of the work in reducing variance.

**The reachability check.** Every candidate target is validated against the MFE distribution of historical analogs (§4): if fewer than 15% of comparable setups ever traded that far, the target is dropped. This is what stops the system from projecting a 4R target that price has essentially never reached from this configuration.

### 2.3 Entry zone

For swing horizons the entry is a zone worked with limit orders, not a market fill. The zone is bounded by the trigger level and `0.5 × ATR` of favourable retracement, with an expiry — typically 8 bars on the signal timeframe. Section 8 handles the question of whether waiting for the better fill is actually worth it.

---

## 3. Three ways to get an outcome distribution

The engine computes the distribution three ways and uses the disagreement between them as a risk signal.

| Method | Role | Strength | Weakness |
|---|---|---|---|
| Closed-form double barrier | Sanity check and implied-drift solver | Exact, instant, no simulation noise | Gaussian, no time limit, no scale-outs |
| **Historical analog bootstrap** | **Primary** | Real fat tails, real path shapes, regime-aware | Limited samples, overlapping windows, non-stationarity |
| Monte Carlo | Secondary, handles management rules | Arbitrary rules, unlimited paths | Distributional assumptions |

### 3.1 Closed form, and the implied-drift trick

For log-price following `X_t = μt + σW_t` from 0, with an upper barrier `b = ln(TP/P₀) > 0` and a lower barrier `a = ln(SL/P₀) < 0`, the probability of touching the upper barrier first is:

```
                 1 − exp(−2μa/σ²)
P(TP first) = ────────────────────────────
              exp(−2μb/σ²) − exp(−2μa/σ²)
```

As `μ → 0` this collapses to the familiar `|a| / (|a| + b)` — the driftless gambler's-ruin result.

The useful part is running it backwards. You already have a calibrated probability from `01` §6. So rather than estimating drift from history — which is noisy and circular — **solve for the `μ` that makes the closed form reproduce the calibrated probability**. The expression is monotone in `μ`, so a 1-D bisection converges in a few iterations.

That implied `μ` is then the drift used in the Monte Carlo. The result is a simulation whose edge comes from the calibration layer rather than from a second, independent, unvalidated estimate of expected return. Everything traces back to one number that has actually been checked against outcomes.

### 3.2 Historical analog bootstrap — the primary method

This is the method that most directly answers "how much profit can it give", and it is also the one you can show a user without apology.

```
1. Build the signal's feature vector v — roughly 12 dimensions:
   regime posterior, rv_30d_rank, atr_ratio, trend_z, funding_rank,
   oi_change_24h, cvd_divergence, liq_1h_rank, ob_imbalance,
   dist_to_structure_atr, hours_to_next_event, archetype one-hot

2. Standardize against the trailing 2y distribution.

3. Find the k = 50 nearest historical snapshots by Mahalanobis distance,
   across BOTH assets, EXCLUDING any snapshot within a ±5-day embargo
   of the current timestamp (prevents leakage through overlap).

4. For each analog, extract the actual forward 5-minute path over the
   archetype's maximum hold horizon.

5. RESCALE each path: divide returns by that analog's ATR at signal time,
   multiply by the current ATR. Without this step you mix 2021's 6%
   daily ranges with 2024's 1.5% ranges and get nonsense.

6. Apply THIS trade's barriers and management rules to each rescaled
   path → 50 realized R outcomes.

7. Block-bootstrap resample (block size 10) to 2,000 draws for a smooth
   distribution and to get CIs on the EV itself.
```

Step 5 is the one people skip and it is the one that matters most. Step 3's embargo is the one that silently manufactures fake alpha if you skip it.

The `historicalAnalogs` block on the opportunity object comes straight out of this, and it is the single most trust-building thing the UI can show: *"50 comparable setups since 2021: 56% reached the first target, median +0.61R, worst −1.00R, median hold 28 hours."* That is a claim a user can interrogate. `confidence: 0.78` is not.

### 3.3 Monte Carlo

Needed because the bootstrap has only 50 genuinely independent paths, and complex management rules need more resolution.

```
Process   dX = μ dt + σ dW,  innovations Student-t with ν = 4
          rescaled to match target σ
μ         implied drift from §3.1
σ         EWMA realized vol (λ = 0.94) on 1h returns, blended 70/30
          with ATR-implied vol; scaled to the simulation step
Steps     5-minute granularity over the max hold horizon
Paths     10,000
Rules     full lifecycle logic from doc 04 applied to every path
```

Student-t with ν = 4 rather than Gaussian is not fussiness. Crypto 4h returns have excess kurtosis in the 5–10 range; Gaussian innovations systematically understate the probability of touching *both* barriers, which biases EV upward for wide targets and downward for tight stops.

### 3.4 Blending and disagreement

```
EV_final = 0.60 · EV_bootstrap + 0.40 · EV_montecarlo
```

If `|EV_bootstrap − EV_montecarlo| > 0.30 R`, flag `MODEL_DISAGREEMENT`. This usually means the current configuration has few good historical analogs — a genuinely novel setup — and it should reduce size by 40% rather than be silently averaged away. Novelty is a risk, not an opportunity.

---

## 4. Outcome taxonomy

Every simulated path resolves into exactly one of these, and each is reported with its probability:

| Outcome | Definition | Typical R |
|---|---|---|
| `FULL_RUN` | All targets hit in sequence | +2.0 to +3.5 |
| `PARTIAL_THEN_TRAIL` | TP1 hit, remainder trailed out | +0.8 to +1.8 |
| `PARTIAL_THEN_BREAKEVEN` | TP1 hit, remainder stopped at breakeven | +0.4 to +0.6 |
| `STOPPED` | Stop hit before any target | −1.0 |
| `TIME_STOP` | Horizon expired, closed at market | −0.4 to +0.6 |
| `THESIS_INVALIDATED` | Closed early on invalidation trigger | −0.7 to +0.3 |

The shape of this distribution matters as much as its mean. Two setups with identical +0.21R expected value are very different trades if one earns it from a 60% chance of +0.5R and the other from a 12% chance of +3.0R. The second has far higher variance, a much longer losing streak distribution, and needs smaller size for the same psychological and financial survivability — which is exactly what the log-utility sizing in §7 handles automatically.

---

## 5. The cost model

This section is where most of the honest work is, and where your original design had nothing at all.

### 5.1 Fees

Model the realistic fill mix rather than assuming all-taker or all-maker:

| Leg | Assumed fill | Rate (Binance USDⓈ-M, VIP0) |
|---|---|---|
| Entry (limit ladder in zone) | 70% maker / 30% taker | 0.0200% / 0.0500% |
| Stop (always market) | 100% taker | 0.0500% |
| Target (resting limit) | 85% maker / 15% taker | 0.0200% / 0.0500% |

Round-trip blended: roughly **0.065%** on a successful trade, **0.079%** on a stop-out. Use per-exchange, per-tier values from config — do not hardcode.

### 5.2 Slippage

Two models, selected by available data:

**Depth walk (preferred).** With an L2 orderbook snapshot, walk the book for the intended notional and compute the volume-weighted fill versus mid. Accurate, and it also produces the liquidity cap for §7.5.

**Square-root impact (fallback).** `slippage_bps ≈ γ · σ_daily_bps · sqrt(Q / ADV)` with `γ ≈ 0.4` calibrated from your own paper-trading fills. For retail-scale size on BTC/ETH perps this lands in the 1–3 bps range in normal conditions and 10–30 bps during liquidation cascades — so the model must be conditioned on current volatility, not averaged.

Stops get a **2× slippage multiplier**. Stops fill precisely when the book is thinnest and moving against you. Modelling stop slippage at the same rate as entry slippage is one of the most common ways backtests lie.

### 5.3 Funding — the swing trader's silent tax

For a multi-day perp hold this is often the largest cost, and it is the one your original design ignored entirely.

```
funding_cost_pct = Σ over settlement timestamps within the expected hold:
                     funding_rate(t) × direction_sign

direction_sign = +1 for LONG (pays when funding positive)
                 −1 for SHORT (receives when funding positive)
```

Three points that matter:

**It is discrete, not continuous.** Funding settles at fixed times (00:00, 08:00, 16:00 UTC on Binance). A 7-hour hold may cross zero settlements or one, depending on entry time. Model the actual timestamps; a hold that straddles a settlement costs a full period.

**Forecast it, do not extrapolate it.** Current funding is a poor predictor of funding three days out. Use the mean of the trailing 3 periods blended with the 30-day mean, and widen the uncertainty band accordingly. When funding is at a 95th-percentile extreme, mean-reversion is the base case.

**It is directionally asymmetric, and that changes which trades are good.** In a high-positive-funding regime, a long pays carry while a short earns it. A short setup with an apparently worse gross edge can have better net EV purely from carry. The engine must surface this, because it inverts the intuition that the stronger signal is the better trade. This is a real, recurring, exploitable asymmetry and it falls straight out of doing the cost arithmetic properly.

### 5.4 Converting to R, and why tight stops are a trap

```
cost_R = total_cost_pct / stop_distance_pct
```

The denominator is what makes this dangerous. Identical dollar costs become wildly different fractions of R depending on stop width:

| Stop distance | Fees+slip (0.14%) | Funding 36h @0.01%/8h | **Total cost in R** |
|---|---|---|---|
| 0.60% | 0.233 R | 0.075 R | **0.31 R** |
| 1.00% | 0.140 R | 0.045 R | **0.19 R** |
| 1.81% | 0.077 R | 0.025 R | **0.10 R** |
| 3.00% | 0.047 R | 0.015 R | **0.06 R** |

And the same 1.81% stop with funding at 0.05%/8h over 36h: funding alone becomes 0.124R, total **0.20R**.

The universal retail instinct — "tighten the stop to improve risk-reward" — is arithmetically backwards once costs are modelled. A tighter stop improves the *nominal* ratio while roughly tripling the cost drag and raising the probability of a noise stop-out. The engine enforces the `cost_R ≤ 0.25` ceiling from §2.1 precisely to block this.

---

## 6. Expected value and the hurdle

### 6.1 Computation

```
EV_gross_R = Σ over outcomes: p(outcome) × R(outcome)
EV_net_R   = EV_gross_R − cost_R
EV_net_USD = EV_net_R × risk_amount_USD
```

Alongside the point estimate, report the full distribution from §3: `p5`, `p25`, `p50`, `p75`, `p95`, `CVaR5`, and `P(R > 0)`.

### 6.2 Breakeven, with costs

For a single-target trade with payoff ratio `b` and cost `c` in R:

```
EV_net = p·b − (1−p) − c = 0    ⟹    p_breakeven = (1 + c) / (1 + b)
```

At `b = 2.5`: breakeven is 28.6% with zero costs, **31.4%** at `c = 0.10`, and **34.3%** at `c = 0.20`. Costs move the bar by three to six percentage points of win rate — which is larger than most real edges.

### 6.3 The hurdle

Two conditions, both required:

```
H1   EV_net_R ≥ +0.15 R                    (point estimate)
H2   EV_net_R at p = p_CI_lower_25  >  0   (robustness to calibration error)
```

H1 alone is weaker than it looks. Since `dEV/dp = (1 + b)`, at `b = 2.5` a 5-percentage-point error in `p` moves EV by 0.175R — more than the hurdle itself. H2 is the real gate: recompute EV using the 25th percentile of the Beta posterior on `p` (`01` §6.3) and require it to stay positive. A trade whose EV depends on `p` being at the optimistic end of its confidence interval is not a trade.

This is `G6` in the gate list, and it will reject a lot. That is the correct behaviour. `NO_SETUP` should be the engine's most frequent output.

---

## 7. Position sizing

### 7.1 Kelly on the outcome distribution

The textbook binary Kelly assumes two outcomes. With a scale-out ladder you have six. Solve the general problem numerically over the simulated paths:

```
f* = argmax_f  E[ ln(1 + f · R_path) ]      f ∈ (0, 0.5)
```

Golden-section search over the 10,000 simulated `R_path` values. This handles partial exits, trailing stops and time stops without approximation, and it automatically penalizes the high-variance payoff shapes discussed in §4.

### 7.2 The Bayesian haircut

Kelly is famously sensitive to errors in `p`, and over-betting is punished far more harshly than under-betting. So do not compute `f*` at the point estimate. Draw from the posterior:

```
for s in 1..1000:
    p_s ~ Beta(k + 0.5, n − k + 0.5)        // from 01 §6.3
    recompute the outcome distribution at p_s
    f*_s = argmax_f E[ln(1 + f·R)]

kellyFraction = 25th percentile of { f*_s }
```

Taking the 25th percentile rather than the mean means a wide confidence interval automatically shrinks the position. A stratum with 31 samples sizes far smaller than one with 310 at the same point estimate — without any hand-tuned rule.

This is what `kellyFraction` on the opportunity object reports. It is materially lower than naive Kelly; on a typical setup, naive Kelly might read 0.19 while the uncertainty-adjusted figure reads 0.08.

### 7.3 Fractional Kelly

Apply a quarter:

```
appliedFraction = 0.25 × kellyFraction
```

Quarter-Kelly captures roughly 44% of the log-growth of full Kelly at approximately a quarter of the variance, and it is far more forgiving of the model error that certainly exists here. Half-Kelly is defensible only after several hundred live trades of demonstrated calibration.

### 7.4 The constraint stack

Final risk is the minimum of five constraints, and the engine records which one bound:

```
risk_pct = min(
    MAX_RISK_PER_TRADE,          // 0.50% of equity — hard cap
    appliedFraction,             // quarter-Kelly, uncertainty-adjusted
    vol_target_cap,              // see 7.5
    liquidity_cap,               // see 7.6
    heat_remaining               // portfolio budget, doc 03 §3
)
```

**Kelly's real job here is as a warning light, not a throttle.** At realistic edges, quarter-Kelly usually lands above the 0.50% cap, so the cap binds and Kelly appears to do nothing. But when `appliedFraction` falls *below* the cap — say 0.3% — that is the model telling you the edge is too thin to justify even your standard risk unit, and you should take the smaller size. That asymmetric use is the whole value of computing it.

### 7.5 Volatility targeting

Keep the risk *unit* constant in volatility terms so that a 0.5% risk means the same thing in a calm market and a chaotic one:

```
vol_target_cap = TARGET_DAILY_VOL_CONTRIBUTION / (σ_daily_asset × notional_per_risk_unit)
```

With `TARGET_DAILY_VOL_CONTRIBUTION = 0.35%` of equity per position, positions shrink automatically as realized vol expands. Without this, a fixed 0.5% risk in a 6%-daily-vol regime produces wildly larger equity swings than the same 0.5% in a 1.5% regime.

### 7.6 Liquidity cap

```
liquidity_cap : notional ≤ 8% of resting depth within 10 bps of mid
```

Prevents the position from being larger than you can exit during stress. At retail scale on BTC/ETH this rarely binds — but it binds exactly when it matters, during cascades, which is when it needs to.

### 7.7 Additional haircuts

Multiplicative, applied to the result of §7.4:

| Condition | Multiplier |
|---|---|
| `MODEL_DISAGREEMENT` (§3.4) | 0.60 |
| `data_confidence` below 1.0 | × `data_confidence` |
| Calibration vintage > 45 days | 0.50 |
| Archetype × regime cell has `n < 20` | 0.50 |
| Regime confidence < 0.60 | 0.70 |
| Engine in cold-start Stage B (`01` §8) | fixed minimum size |

---

## 8. The expected value of waiting

A capability worth building because it converts a binary decision into a better one: often the answer is neither "take it" nor "skip it" but "bid lower".

For a proposed entry zone, compute:

```
EV_now    = EV at the current market price (market entry)
EV_limit  = EV if filled at the zone's favourable edge
p_fill    = P(price touches the zone edge before the trigger invalidates)
            — estimated from the same analog paths in §3.2
EV_miss   = 0 (no trade)

EV_wait   = p_fill × EV_limit + (1 − p_fill) × EV_miss
```

Recommend the limit approach when `EV_wait > EV_now × 1.15` — a 15% margin so that marginal cases default to the certain fill. The uplift is usually meaningful: a 0.4-ATR better entry on a 1.8-ATR stop improves R on every target by roughly 20%, and the same calculation tells you when chasing is destroying the edge you detected.

---

## 9. What the user actually sees

The opportunity detail view leads with the profit answer, in this order:

```
BTC LONG · COMPRESSION_BREAKOUT · LOW_VOL_COMPRESSION regime

  Net expected value          +0.21 R        ≈ +$10.50 at your size
  Calibrated win probability   44%           90% CI: 33% – 55%
  Breakeven needed             31.4%         margin: +12.6 pp
  Expected hold                31 hours

  Outcome distribution (R)
     p5   ▏−1.02
     p25  ▏−1.00
     p50  ▏ 0.00
     p75  ▕ 1.16
     p95  ▕ 2.61
     CVaR₅ −1.04     ·     P(profit) 44%

  Costs                        −0.10 R
     fees 0.055 · slippage 0.022 · funding 0.025
     ⚠ funding rises to 0.19 R if the hold extends past 72h

  50 historical analogs since 2021
     56% reached TP1 · median +0.61 R · worst −1.00 R · median hold 28h

  Evidence: 2 independent clusters (N_eff 2.3 from 6 agent claims)
  Size bound by: PORTFOLIO_HEAT
```

Every number on that screen is traceable to a computation in this document. There is no opaque AI score anywhere on it, which is the entire design intent.
