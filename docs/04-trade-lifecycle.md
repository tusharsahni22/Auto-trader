# 04 — Trade Lifecycle Management

**Answers:** *the trade is on — now what?*
**Owns:** thesis decay, invalidation monitoring, scale-outs, stop movement, time stops, exit quality measurement.

---

## 1. Why this document exists

Your original design ends at `EXECUTION_ELIGIBLE`. For a 4h–5d horizon that is roughly half the problem.

Consider two systems with identical entries — same signals, same levels, same sizes. One scales out 40% at the first target and trails the rest with a Chandelier stop. The other holds everything to the final target or the stop. Across the same set of trades these produce materially different equity curves, different maximum drawdowns, and different Sharpe ratios. Nothing about the entry logic distinguishes them.

The lever is measurable. Track **capture ratio** — realized R divided by the maximum favourable excursion the trade offered:

```
capture = realized_R / MFE_R
```

A system entering well but exiting badly runs a capture ratio around 0.25. A well-managed system on the same entries runs 0.45–0.60. You cannot reach 1.0 and should not try; that requires selling the exact high. But the gap between 0.25 and 0.50 is a doubling of returns from entries you already had, which is a far cheaper improvement than finding better signals.

---

## 2. Thesis decay

A trade should be exited when the reason for it stops being true — not only when price hits a level. Price-based stops catch the fast failures. Thesis decay catches the slow ones, which at swing horizons are more common: the setup quietly dissolves while price does nothing, and you sit in dead risk for two days paying funding.

### 2.1 The score

At entry, snapshot each evidence cluster's strength. On every feature update, recompute and compare:

```
decay = Σⱼ wⱼ · clamp( strengthⱼ(now) / strengthⱼ(entry), 0, 1.2 )
        ────────────────────────────────────────────────────────
                              Σⱼ wⱼ
```

Using the same cluster weights as `01` §5.4, over the clusters that were actually present at entry. The 1.2 ceiling allows a strengthening thesis to register without letting one cluster mask the collapse of the others.

### 2.2 Actions

| `decay` | Action |
|---|---|
| ≥ 0.80 | Thesis intact. No action. |
| 0.60 – 0.80 | Note on dashboard. No action. |
| 0.40 – 0.60 | **Tighten**: move stop to the tighter of current stop or 1.2 × ATR from market. Cancel any pending add. |
| 0.25 – 0.40 | **Reduce**: close 50% at market. Trail the remainder aggressively. |
| < 0.25 | **Exit**: close at market, label `THESIS_INVALIDATED`. |

Every decay-driven action is logged with the per-cluster breakdown, because the ledger needs to be able to answer whether decay exits were saving money or cutting winners early. If analysis later shows decay exits systematically underperform simply holding to the stop, the thresholds move — or the mechanism gets retired. It is a hypothesis, not a truth.

---

## 3. Invalidation monitors

Distinct from decay. Invalidations are discrete, binary conditions specified at entry and checked continuously.

| Type | Example | Check frequency | Action |
|---|---|---|---|
| `PRICE` | 4h close below 102,900 | Bar close | Exit at market |
| `DERIVATIVE` | Funding > 0.04% for 2 consecutive periods | Each settlement | Reduce 50% |
| `REGIME` | Regime flips to `HIGH_VOL_EXPANSION` | Each classification | Tighten + re-evaluate |
| `STRUCTURE` | Compression range low breaks on volume | Per bar | Exit at market |
| `NEWS` | Article with importance ≥ 8 opposing the thesis | On ingest | Freeze + re-evaluate |
| `EVENT` | Unscheduled tier-1 announcement | On ingest | Reduce 50% + freeze adds |
| `CORRELATION` | BTC/ETH correlation breaks down below 0.4 | Hourly | Re-evaluate heat |

The distinction between "exit" and "re-evaluate" matters. Price and structure invalidations are mechanical and execute immediately. News and regime invalidations route to a re-evaluation cycle (§7) because they need interpretation — and interpretation takes seconds, which at this horizon you can afford.

---

## 4. The scale-out ladder

Fractions are not folklore. They are derived from the conditional continuation probabilities in the analog set.

### 4.1 The continuation decision

Standing at level `L₁`, already reached, holding a remaining fraction. Continuing to `L₂` is worth it when:

```
E[hold]  = p(L₂ before trail | reached L₁) · R(L₂)
         + (1 − p) · R(trail_stop)
         − Δfunding(expected extra hold)

E[exit]  = R(L₁)

hold if  E[hold] > E[exit]
```

`p(L₂ | L₁)` comes directly from the analog paths in `02` §3.2: of the analogs that reached `L₁`, what fraction went on to `L₂` before retracing to the trail stop. This is a count, not a model.

### 4.2 Choosing fractions

Run the decision at each level and allocate accordingly. A representative result for a compression breakout:

```
                    p(reach)   p(continue | reached)   E[hold] vs E[exit]
TP1  @ 1.16 R         0.58              —                     —
TP2  @ 2.47 R         0.34            0.59              1.31 vs 1.16  → hold
TP3  @ 3.79 R         0.19            0.56              1.78 vs 2.47  → exit

⟹  ladder: 40% at TP1, 35% at TP2, 25% trailed beyond TP2
```

The final tranche trails rather than resting at TP3 because the conditional analysis says the third target is not reliably reached — but the paths that do get there run far, and a trail captures that tail better than a fixed limit.

Re-derive the ladder per archetype per regime whenever the analog set updates. Liquidation reversals, for instance, typically want a much larger first tranche — they revert fast and give it back faster.

---

## 5. Stop movement

### 5.1 Breakeven — the most expensive piece of folk wisdom

"Move to breakeven once you're up 1R" is the most common rule in retail trading and it is usually wrong. It converts winners into scratches because normal retracement after the first push is routine.

Make it empirical instead. Among analogs that *ultimately won*, measure what fraction retraced to entry after first reaching `+X R`:

```
X = 0.5 R   →  38% of eventual winners retraced to entry   ✗
X = 1.0 R   →  22%                                          ✗
X = 1.3 R   →  17%                                          ✓
X = 2.0 R   →   9%                                          ✓

⟹ breakeven trigger at +1.3 R  (first X with retrace rate < 20%)
```

Below the threshold you are destroying more winners than you are saving losers. Above it the protection is close to free. The 20% tolerance is a parameter — tune it on realized data, not on preference.

### 5.2 Trailing

Activates only after TP1, never before. Archetype-dependent:

| Archetype | Trail method |
|---|---|
| `TREND_CONTINUATION` | Chandelier: highest high since entry − 3.0 × ATR(14) |
| `COMPRESSION_BREAKOUT` | Chandelier at 2.5 × ATR, tightening to 2.0 after TP2 |
| `LIQUIDATION_REVERSAL` | Structure: below the last 1h swing low, 0.5 ATR buffer |
| `RANGE_FADE` | No trail — fixed targets only; ranges do not trend |
| `FUNDING_SQUEEZE` | Time-weighted tightening: 3.0 ATR at entry → 1.5 ATR by hour 12 |

Stops move in one direction only. A trail that can loosen is not a trail, and this must be enforced in code with an assertion, not left to convention.

### 5.3 Volatility adjustment

When realized vol expands sharply mid-trade, an ATR-based trail widens automatically — which is correct for avoiding noise but means your open risk silently grows. The heat calculation in `03` §3 uses *current* stop distance, so this is captured automatically and may block new entries. That is the intended behaviour: a vol expansion should consume portfolio budget.

---

## 6. Time stops

Capital sitting in a trade that is going nowhere has two costs: funding, and the opportunity cost of the heat it occupies.

### 6.1 The hazard curve

From the analog paths, compute for each elapsed hour `h` the probability that a position still open, with roughly the current unrealized R, finishes profitably:

```
h = 12   P(finish > 0 | open, unrealized ≈ 0) = 0.44
h = 24                                          0.39
h = 36                                          0.33
h = 48                                          0.27   ← below breakeven p
h = 72                                          0.21
```

Exit when this crosses the cost-adjusted breakeven probability from `02` §6.2. In the example above, with breakeven at 31.4%, the crossing sits between hours 36 and 48 — so the time stop lands at 40 hours, not at a round 48 or 72.

### 6.2 Rules

```
HARD time stop     archetype max hold (12–96h). Close at market.
SOFT time stop     hazard crossing. Close unless decay ≥ 0.8 AND
                   unrealized R > 0.3, in which case extend by 25%
                   once only.
EVENT time stop    close before any tier-1 event if unrealized R < 0.5
                   and the thesis is not event-related.
```

The soft-stop extension is capped at one use per position. Without the cap, "it's still working" extends indefinitely, which is how a swing trade becomes an accidental investment.

---

## 7. Re-evaluation and what the AI may do post-entry

Re-evaluation is triggered by: a news item of importance ≥ 7 mentioning the asset, a regime change, a funding regime flip, a liquidation spike above the 95th percentile, detection of an opposing archetype, decay crossing a threshold, or the approach of a tier-1 event.

The agents participate, under a strictly asymmetric authority model:

| Agents **may** | Agents **may not** |
|---|---|
| Lower conviction, raising the decay score's effect | Raise conviction or cancel a decay action |
| Recommend reducing or closing | Recommend adding to a position |
| Flag a new invalidation condition | Remove or weaken an existing invalidation |
| Trigger an exit review | Move a stop, in any direction |
| Note that an assumption has broken | Extend a time stop |

This asymmetry is deliberate and worth defending. Post-entry is precisely when narrative pressure is strongest — you are in the trade, it is moving against you, and a fluent argument for holding is very easy for a language model to produce and very tempting to accept. Giving agents only the power to *reduce* exposure means the worst case of a hallucinated post-entry analysis is an early exit. The worst case of the reverse is unbounded.

---

## 8. Exit quality measurement

Recorded for every closed position and reviewed monthly. These metrics diagnose the management layer specifically, separately from signal quality.

| Metric | Definition | Healthy range |
|---|---|---|
| Capture ratio | `realized_R / MFE_R` | 0.45 – 0.60 |
| Winner pain | `MAE_R` on winning trades | < 0.5 |
| Premature exit rate | Closed positions where price later reached the original TP | < 25% |
| Stop-out efficiency | Stopped trades where price never recovered to entry within the horizon | > 60% |
| Time-stop value | Mean R of time-stopped trades vs. holding them to the hard stop | Should be positive |
| Decay-exit value | Same comparison for decay exits | Should be positive |

The last two are the audit on this document's own mechanisms. If time stops and decay exits are not measurably beating "just hold to the stop", they are complexity without benefit and should be removed. Build them, measure them, and be prepared to delete them — that is the difference between an engine that improves and one that just accumulates features.
