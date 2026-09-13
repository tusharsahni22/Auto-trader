# 03 — Risk Engine & Portfolio Layer

**Answers:** *is this allowed, and how does it interact with what is already on?*
**Owns:** hard limits, portfolio heat, circuit breakers, kill switch, the opportunity state machine, reconciliation.
**Absolute rule:** no LLM output reaches this layer. Everything here is deterministic code with unit tests.

---

## 1. Why this layer is deterministic

The risk engine is the only component whose failure is unrecoverable. A bad signal costs you one trade. A bad risk engine costs you the account.

So the contract is narrow and absolute. The risk engine receives a fully-formed opportunity with a calibrated probability and an EV estimate, and it answers with a permission and a size. It cannot be argued with. There is no field on the opportunity object that an agent can set which influences a limit, no confidence threshold that relaxes a cap, and no prompt anywhere in this layer.

Concretely, the things that are impossible by construction:

- An agent cannot widen a stop, extend a time stop, or increase a size.
- An agent cannot clear a circuit breaker or re-enable trading after a halt.
- An agent cannot mark data as fresh, or override `data_confidence`.
- A high `confidence` value cannot bypass any gate in `01` §7.
- No code path exists from an LLM response to an order. The execution adapter accepts only risk-engine-signed intents.

Every limit below lives in a single versioned config file, and every change to it is logged with a timestamp and a reason. When you inevitably want to raise a limit after a good month, the log is what protects you from yourself.

---

## 2. The limit set

Defaults for a paper account. All are config, none are hardcoded.

### 2.1 Per-trade

| Limit | Default | Note |
|---|---|---|
| `MAX_RISK_PER_TRADE` | 0.50% of equity | The binding constraint in most cases |
| `MIN_RISK_PER_TRADE` | 0.10% | Below this, skip — not worth the cost drag |
| `MAX_NOTIONAL_PER_TRADE` | 25% of equity | Caps effective leverage independent of stop width |
| `MAX_LEVERAGE` | 3× | Liquidation price must sit ≥ 4× stop distance away |
| `MIN_STOP_DISTANCE` | 1.0 × ATR(14) | Noise floor (`02` §2.1) |
| `MAX_COST_RATIO` | 0.25 R | Cost ceiling (`02` §2.1) |
| `MIN_EV_NET` | +0.15 R | Plus the CI-lower condition (`02` §6.3) |

The leverage rule is worth stating explicitly: liquidation must be at least four stop-distances away. If a 3× position on a 1.8% stop would liquidate at 2.5%, the stop is inside the liquidation zone in a wick and you own a lottery ticket, not a trade.

### 2.2 Portfolio

| Limit | Default |
|---|---|
| `MAX_PORTFOLIO_HEAT` | 1.50% of equity (correlation-adjusted, §3) |
| `MAX_CONCURRENT_POSITIONS` | 3 |
| `MAX_POSITIONS_PER_ASSET` | 1 |
| `MAX_GROSS_NOTIONAL` | 60% of equity |
| `MAX_SAME_DIRECTION_CORRELATED` | 1 (§4) |

### 2.3 Rate and exposure

| Limit | Default | Rationale |
|---|---|---|
| `MAX_NEW_POSITIONS_PER_DAY` | 3 | Bounds the damage from a detector bug |
| `MAX_NEW_POSITIONS_PER_HOUR` | 1 | Stops cascade entries during a single event |
| `MIN_TIME_BETWEEN_SAME_ASSET` | 8 hours | Prevents re-entering a trade you just lost |
| `MAX_EVENT_WINDOW_EXPOSURE` | 0.75% heat | Reduced budget when a tier-1 event is < 8h out |

---

## 3. Portfolio heat, done correctly

Summing per-position risk assumes the positions are independent. On BTC and ETH they are emphatically not.

### 3.1 The calculation

```
w = vector of CURRENT open risk per position, as % of equity
    (distance from market to the current stop × size ÷ equity —
     a position trailed to breakeven contributes ~0)

C = correlation matrix of asset returns, EWMA λ = 0.97 on 4h returns,
    floored at 0.60 for any BTC/ETH pair

heat   = sqrt( wᵀ C w )
N_eff  = (Σ wᵢ)² / (wᵀ C w)
```

### 3.2 What that means in practice

Two positions, long BTC and long ETH, 0.5% risk each, correlation 0.85:

```
wᵀCw  = 0.25 + 0.25 + 2(0.5)(0.5)(0.85) = 0.925
heat  = sqrt(0.925) = 0.96%          (naive sum would say 1.00%)
N_eff = (1.0)² / 0.925 = 1.08 positions
```

You are carrying 96% of the risk of a doubled single position and receiving 4% of diversification benefit. `N_eff = 1.08` says it plainly: that is one trade wearing two tickets.

Contrast the same two positions in opposite directions:

```
wᵀCw  = 0.25 + 0.25 − 2(0.5)(0.5)(0.85) = 0.075
heat  = 0.27%
N_eff = 13.3
```

Which is also misleading in its own way — a BTC-long/ETH-short pair is a *spread* trade whose risk is the residual after the common factor cancels. It is genuinely low-heat, but it is also a completely different strategy from what the archetypes in `01` detect, and both legs' stops can be hit in a whipsaw. Treat `N_eff > 5` as a flag for manual review rather than as free capacity.

Note the "current open risk" definition in §3.1. This is what makes scaling out actually free up budget: a position moved to breakeven contributes roughly zero to heat, so the engine can take a new one. That is the correct behaviour and it falls out of the definition rather than needing a special rule.

### 3.3 The check

```
heat_with_candidate = sqrt( [w; w_new]ᵀ C' [w; w_new] )
if heat_with_candidate > MAX_PORTFOLIO_HEAT:
    w_new = largest size satisfying the constraint      // binary search
    if w_new < MIN_RISK_PER_TRADE: VETO(PORTFOLIO_HEAT)
    else: record bindingConstraint = "PORTFOLIO_HEAT"
```

Shrink before you reject. A half-size position that fits the budget is usually better than nothing — provided it clears `MIN_RISK_PER_TRADE`, below which cost drag makes it pointless.

---

## 4. Correlation stacking

A separate, blunter rule sitting on top of heat, because heat alone permits a configuration you do not want.

```
if an open position exists in a correlated asset (|ρ| > 0.75)
   AND the candidate is in the same effective direction
   AND heat would exceed 1.0%:
      VETO(CORRELATION_STACK)
```

The reasoning is about failure modes rather than variance. Long BTC plus long ETH is a single bet on crypto beta. When it goes wrong it goes wrong on both legs simultaneously and at the same moment — typically a macro shock or a liquidation cascade, exactly the conditions where slippage is also worst. Your realized loss in that scenario is meaningfully worse than the heat calculation predicts, because heat uses normal-conditions correlation and tail correlation runs toward 1.0.

If both assets genuinely present setups, take the one with higher net EV and record the other as `SUPERSEDED_BY_CORRELATION` so the ledger can later tell you whether the selection rule was choosing well.

---

## 5. Circuit breakers

Automatic, deterministic, and they fail closed. Each has a defined trigger, scope, duration and release condition.

| Breaker | Trigger | Scope | Duration | Release |
|---|---|---|---|---|
| `DAILY_LOSS` | Realized + unrealized ≤ −2.0% equity since 00:00 UTC | No new entries | To 00:00 UTC | Automatic |
| `WEEKLY_LOSS` | ≤ −5.0% equity over 7 rolling days | No new entries | 7 days | Manual review |
| `CONSECUTIVE_LOSSES` | 4 stop-outs in a row | No new entries | Until reviewed | Manual |
| `DRAWDOWN` | ≥ 10% from equity peak | Full halt | Until reviewed | Manual + recalibration |
| `EV_DIVERGENCE` | Rolling 30-trade mean realized R < predicted mean − 2 SE | Size capped 50% | Until recalibrated | Automatic on refit |
| `CALIBRATION_DEGRADED` | ECE > 0.10, or log loss ≥ base rate for 2 months | Size capped 50% | Until refit | Automatic on refit |
| `DATA_STALE` | Any critical feed older than its threshold (`06` §5) | No new entries, existing managed | Until fresh | Automatic |
| `FEED_DIVERGENCE` | Cross-exchange mid prices differ > 0.5% | Full halt | Until resolved | Automatic |
| `SLIPPAGE_ANOMALY` | Realized slippage > 3× modelled, 3 fills running | No new entries | Until reviewed | Manual |
| `PROVIDER_OUTAGE` | All AI providers failing | Deterministic-only mode | Until restored | Automatic |
| `EXCHANGE_ERROR` | Order rejects or API errors > 5 in 10 min | Full halt | Until reviewed | Manual |

Two design notes. `EV_DIVERGENCE` is the most valuable breaker in the list and the one nobody builds — it catches the case where the engine is still producing signals but the world has changed underneath it, well before the drawdown breaker would. And `PROVIDER_OUTAGE` degrades rather than halts, because the deterministic core is designed to function without the agents; that is a deliberate consequence of keeping AI as testimony rather than verdict.

---

## 6. Kill switch

A single control, prominent, that does the following in order:

```
1. Stop signal generation.        (immediate, in-process flag)
2. Cancel all working orders.     (with retry and verification)
3. Apply the flatten policy:
      FREEZE   — hold positions, keep stops live   [default for paper]
      FLATTEN  — close everything at market
      HEDGE    — open an offsetting position
4. Persist a full state snapshot for post-mortem.
5. Alert on every configured channel.
6. Require an explicit, logged human action to re-arm.
```

`FREEZE` is the default because reflexively flattening during a data outage or an exchange glitch has caused more losses than it has prevented — you crystallize a loss on information you do not trust. `FLATTEN` is appropriate when you have lost confidence in the engine itself rather than in the feed.

The re-arm path must be deliberate: a confirmation, a typed reason, and an entry in the audit log. The kill switch should also be exercised on a schedule — a monthly drill in paper mode — because an untested kill switch is a decorative button.

---

## 7. The opportunity state machine

Your original states stopped at entry. This version covers the full life.

```
                        ┌───────────┐
                        │ NO_SETUP  │ ◄──────────────────┐
                        └─────┬─────┘                    │
                   detector fires                        │
                              ▼                          │
                        ┌───────────┐                    │
                        │  FORMING  │ ── conditions decay ┤
                        └─────┬─────┘                    │
                   all criteria met                      │
                              ▼                          │
                  ┌───────────────────────┐              │
                  │   SCORED              │              │
                  │ evidence → calibration│              │
                  └───────┬───────┬───────┘              │
                          │       │                      │
                   gates fail   gates pass               │
                          ▼       ▼                      │
                   ┌──────────┐ ┌───────────┐            │
                   │  VETOED  │ │   ARMED   │            │
                   │ (logged) │ │ awaiting  │            │
                   └────┬─────┘ │  trigger  │            │
                        │       └─────┬─────┘            │
                        │      ┌──────┴──────┐           │
                        │  triggered    zone expires     │
                        │      ▼             │           │
                        │ ┌──────────┐       │           │
                        │ │  OPEN    │       └───────────┤
                        │ └────┬─────┘                   │
                        │      │ TP1 hit                 │
                        │      ▼                         │
                        │ ┌──────────────┐               │
                        │ │ SCALING_OUT  │               │
                        │ └──────┬───────┘               │
                        │        ▼                       │
                        │ ┌──────────────────────────┐   │
                        │ │ CLOSED_*                 │   │
                        │ │  WIN │ LOSS │ TIMEOUT    │   │
                        │ │  INVALIDATED │ KILLED    │   │
                        │ └──────────┬───────────────┘   │
                        │            ▼                   │
                        │     ┌──────────────┐           │
                        └────►│ LEDGER       │───────────┘
                              │ labelled     │
                              └──────────────┘
```

Every transition is persisted with a timestamp, the triggering condition, and a snapshot reference. `VETOED` opportunities go to the ledger too — they are a control group, and without them you cannot tell whether your gates are rejecting bad trades or good ones. Track the counterfactual outcome of every veto.

A separate `SHADOW` flag runs alongside any state: shadow opportunities are fully scored and fully tracked but never sized. That is how the meta-model and new archetypes get evaluated without risking anything.

---

## 8. Invariants and reconciliation

Checked every 60 seconds. Any violation trips `EXCHANGE_ERROR` and alerts.

```
INV1  Every OPEN position has a live stop order at the exchange.
INV2  Exchange position size == internal position size, per symbol.
INV3  No working orders exist for a symbol with no internal position.
INV4  Sum of position risk == computed portfolio heat (±0.01%).
INV5  Account equity matches the internal ledger (±0.1%).
INV6  No position has been open longer than its time stop + 1 bar.
INV7  Every order sent carries a risk-engine signature and an opportunity id.
```

INV1 and INV3 are the ones that catch real incidents. A position without a stop — because the stop order was rejected, or cancelled during a partial fill, or lost in a reconnect — is the standard way automated systems produce their worst single loss. Check for it constantly, and treat a missing stop as an emergency: re-place it immediately, and if that fails, flatten.

In paper mode, INV2 and INV5 reconcile against the simulator, which means the same code path is exercised before it ever faces a real exchange.
