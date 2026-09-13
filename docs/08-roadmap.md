# 08 — Roadmap

Sequenced so that the cheapest way to discover the project is not viable comes early, and the expensive, satisfying work comes after the evidence justifies it.

---

## The sequencing principle

The tempting order is: build the dashboard, wire up the agents, watch it produce opinions, then find out months later whether any of it had edge.

The right order inverts that. **Phase 2 is a go/no-go gate that costs two weeks and answers the only question that matters: do these setups have any historical edge at all?** It requires no AI, no UI, and no live infrastructure. If the answer is no, you have spent six weeks instead of six months, and you know exactly which archetypes to redesign.

Everything before Phase 2 exists to make Phase 2 possible. Everything after exists because Phase 2 said yes.

Estimates assume evening-and-weekend work by someone already fluent in the Node/TypeScript/Postgres stack. Phase durations are effort, not calendar — Phase 5 in particular has a 60-day wall-clock component that no amount of effort shortens.

---

## Phase 0 — Foundations and collectors · ~1.5 weeks

Monorepo, Docker Compose with Postgres + TimescaleDB + pgvector + Redis, config and secrets handling, structured logging, and the exchange adapter interface.

Then, before anything else: **start the liquidation collector.**

This is the one instruction in the roadmap to follow literally and immediately. Historical liquidation data cannot be bought cheaply or backfilled for free (`06` §2.1). Every day the collector is not running is a day permanently absent from your analog set. Write a crude version in an afternoon, run it on a cheap VPS, and improve it later. Same logic, slightly less urgently, for orderbook snapshots.

```
Exit criteria
☐ Liquidation and orderbook collectors running continuously, writing to Timescale
☐ Candle/funding/OI backfill for BTC and ETH, 2021→present, from ≥ 2 venues
☐ observed_at correctly set on backfilled rows (NOT the backfill date — see 06 §3.4)
☐ Reconnect + gap-fill verified by killing the process mid-stream
☐ Disconnection windows logged to a table
```

---

## Phase 1 — Feature engine · ~2 weeks

The ~90 features of `06` §4, computed into the features hypertable with point-in-time stamps. Data quality gates and `data_confidence`. The `asOf` repository layer that makes leakage structurally difficult to write.

```
Exit criteria
☐ Full feature history computed 2021→present
☐ Every leakage checklist item in 06 §3.4 verified, with a test per item
☐ Spot-check ≥ 10 indicator values against TradingView — exact match
☐ asOf queries provably exclude future data (test with a deliberate future row)
☐ data_confidence responds correctly to a simulated feed outage
```

The TradingView spot-check is worth doing properly. Indicator implementations disagree on warm-up handling, EMA seeding and session boundaries far more than people expect, and an off-by-one in ATR quietly corrupts every stop and every R calculation downstream.

---

## Phase 2 — Regime, archetypes, historical replay · ~2 weeks · **GO / NO-GO**

Rule-based regime classifier. Three archetype detectors: compression breakout, liquidation reversal, trend continuation. Triple-barrier labelling with intrabar resolution. The archetype × regime expectancy matrix. Purged walk-forward harness. The random-entry benchmark.

Then run the replay across 2021→present and read the answer.

```
Exit criteria — the gate
☐ ≥ 250 labelled historical opportunities across both assets
☐ At least ONE archetype × regime cell with n ≥ 30 and mean R > +0.15
   after full modelled costs
☐ That cell's advantage over random-entry survives purged walk-forward
   in ≥ 4 of 5 folds
☐ DSR > 0.95 with the trial count honestly registered
☐ PBO < 0.30
```

If no cell clears this, **stop and redesign the archetypes.** Do not proceed to build agents on top of detectors with no demonstrated edge — you will simply be adding expensive interpretation to noise. Iterate here, where a cycle costs days rather than months. This is the whole reason Phase 2 sits before Phase 4.

If exactly one cell clears it, that is fine and quite normal. Build the engine around that one and add others as they earn their place.

---

## Phase 3 — Expected value and risk engines · ~2 weeks

Level derivation from volatility and liquidity structure. The full cost model including discrete funding settlements. Analog bootstrap with ATR rescaling and embargo. Monte Carlo with Student-t innovations and the implied-drift solver. Outcome distributions. Bayesian fractional Kelly and the constraint stack. Then the deterministic risk engine: all limits, correlation-adjusted portfolio heat, every circuit breaker, the kill switch, invariants, and the state machine.

```
Exit criteria
☐ Cost model reproduces the 02 §5.4 table exactly
☐ Closed-form barrier probability agrees with Monte Carlo to < 1% (driftless case)
☐ Implied-drift solver converges and round-trips: solve μ from p, recover p
☐ Analog search verified to exclude the ±5-day embargo
☐ Every circuit breaker has a test that trips it and verifies the halt
☐ Kill switch tested under a simulated partial-fill state
☐ Invariant checker detects a manually-removed stop within 60 seconds
```

The risk engine gets the highest test coverage of anything in the project. It is the only component whose failure is unrecoverable.

---

## Phase 4 — Agents, evidence graph, calibration · ~2 weeks

Provider abstraction with fallback. Four agents with strict schemas. Citation verification. Evidence graph with cluster collapse. Correlation-aware aggregation with `N_eff`. Platt calibration over the Phase 2 replay labels. Cost controls, caching, budgets. Snapshot anonymization and the contamination test.

```
Exit criteria
☐ Citation verification catches a deliberately fabricated value in a test
☐ Agent suspension triggers at a 15% rejection rate
☐ N_eff demonstrably drops when agents cite overlapping features
☐ Ensemble falls back cleanly to deterministic-only with all providers down
☐ Daily cost budget enforced with a hard cutoff
☐ Contamination test run: models cannot identify date/asset from anonymized
  snapshots better than chance
☐ Deterministic score calibrated from replay; κ (agent weight) starts at 0
```

---

## Phase 5 — Paper trading and lifecycle · ~2 weeks build, then 60 days running

Paper execution simulator with honest fills. Lifecycle manager: thesis decay, invalidation monitors, data-derived scale-out ladder, empirical breakeven trigger, archetype-specific trails, hazard-curve time stops. The outcome ledger. Post-entry re-evaluation with the asymmetric agent authority model.

Then start the 60-day clock and **do not touch it**.

```
Exit criteria
☐ All of 07 §8.2 satisfied
☐ 60 continuous days, no config changes, no manual intervention
☐ Scale-out ladder derived from analog data, not hand-set
☐ Breakeven trigger derived from winner-retrace analysis, not folklore
☐ Reconciliation runs clean against the simulator for the full period
```

The hardest requirement here is behavioural rather than technical. Every config change restarts the 60 days. You will want to tweak something in week three. Do not.

---

## Phase 6 — Dashboard and alerts · ~2 weeks, parallel with 4–5

Next.js dashboard: market overview with regime, opportunity list, the opportunity detail view of `02` §9, portfolio heat and breaker status, the calibration reliability diagram, agent scorecards with MIC, and the replay browser. Telegram alerts. A prominent kill switch.

```
Exit criteria
☐ Every number on screen traceable to a documented computation
☐ Reliability diagram and sample counts visible on every probability
☐ Cold-start stage and calibration vintage displayed prominently
☐ No opaque composite score anywhere in the UI
☐ Kill switch reachable in one tap from every screen
```

The "no opaque score" rule is a design constraint, not a preference. The moment the UI shows a number the user cannot decompose, they start trusting it, and the whole epistemic structure of the system stops doing its job.

---

## Phase 7 — Learning loop · ~2 weeks

Monthly recalibration job. Agent scorecards with leave-one-out MIC. Archetype statistic refresh. Drift detection with PSI. Veto counterfactual tracking. Counterfactual replay harness. Trial registry with automated DSR and PBO.

```
Exit criteria
☐ Recalibration runs unattended and is itself walk-forward
☐ MIC computed for all four agents; at least one retirement decision reasoned
☐ Veto counterfactuals reported per gate
☐ Counterfactual replay can answer "what if the adversary agent were removed"
```

---

## Phase 8 — Expansion · open-ended

Only after Phase 5 succeeds, and strictly in priority order — each item justified by a measured deficiency rather than by interest.

Remaining four archetypes. HMM regime classifier with transition probabilities. Options data from Deribit: IV rank, skew, gamma positioning, max pain. The elastic-net meta-model in shadow mode. Paid on-chain data, prioritized by the accumulated `missingInformation` backlog. Additional venues. Additional assets, which finally helps the sample-size problem in `07` §1.

---

## Phase 9 — Live execution · gated, not scheduled

Not a phase with a date. A decision made from evidence, if the evidence appears.

```
Preconditions — all required
☐ Phase 5 passed on the first attempt or after documented, diagnosed fixes
☐ ≥ 100 closed paper positions total
☐ Calibration stable across two consecutive monthly refits
☐ DSR > 0.95 over the full paper period
☐ Realized costs within 20% of modelled
☐ Three months of operation with no unexplained incidents
☐ Kill switch drilled monthly, every drill passed

Then, and only then
1. Manual approval mode — engine stages, you approve every order. 4 weeks.
2. Quarter size, semi-automatic. 8 weeks.
3. Half size. 8 weeks.
4. Full size — where "full" means 0.5% risk per trade, not more.

Any circuit breaker trip, or any month of realized results falling outside
the predicted p5–p95 band, returns you one step.
```

Fully automated execution is deliberately absent from this plan. It is not a capability worth having until everything above has held for a long time, and by then you will be in a much better position to specify it than I am now.

---

## Week one, concretely

If you want to start tomorrow, in order:

Write the liquidation collector for Binance and Bybit and get it running on a VPS before you write anything else. Stand up Postgres with TimescaleDB. Write the orderbook snapshotter. Backfill candles, funding and open interest for BTC and ETH from 2021. Verify that `observed_at` on backfilled rows is set to plausible historical observation times rather than today.

That is Phase 0. Everything else in this plan depends on data you can only collect going forward, and the clock on that started before you finished reading this.
