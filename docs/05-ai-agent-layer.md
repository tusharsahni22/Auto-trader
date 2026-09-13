# 05 — AI Agent Layer

**Answers:** *what do the models contribute, and how is that kept honest?*
**Owns:** agent definitions, output contracts, citation verification, provider abstraction, cost control, agent scoring.

---

## 1. The role of the models

Agents are witnesses. They observe a structured snapshot of the market and testify about it. They do not set probabilities, do not size positions, do not touch limits, and do not produce trade decisions.

This is not caution for its own sake. It follows from what language models are good and bad at. They are good at reading a heterogeneous set of numbers and articulating a coherent interpretation — *"open interest rose while funding stayed flat, which is fresh positioning rather than a leverage chase"* — and that interpretation is genuinely hard to encode in rules. They are bad at arithmetic, bad at probability, prone to inventing specific figures that sound right, and completely unable to know how often their interpretations have been correct.

So the design gives them exactly the job they are suited for and takes away the rest. They contribute strength-weighted claims into an evidence graph; the deterministic layers do everything else.

A useful sanity check on this architecture: **if you deleted every agent, the system would still function.** Worse, but functional — the deterministic archetype scores, calibration, EV engine and risk gates all operate without them. The reverse is not remotely true.

---

## 2. The four agents

Four, not fifteen. Each extra agent adds correlated noise, burns budget, and — critically — you will never accumulate enough samples to prove that agent nine earns its place (`01` §8, `07` §5).

### 2.1 Structure Agent

Sees: multi-timeframe price structure (15m/1h/4h/1d), support and resistance levels with touch counts, EMA/VWAP relationships, volume profile nodes, ATR and Bollinger bandwidth, candle formations at key levels, and the detected archetype's specific trigger conditions.

Asked: does the price structure support, contradict, or say nothing about this archetype? Where is the nearest meaningful opposition? Is the structure clean or messy?

Clusters it may cite into: `PRICE_STRUCTURE`, `VOLATILITY`.

### 2.2 Positioning Agent

Sees: funding rate with 30d percentile and term structure across venues, open interest and its 24h/7d change, OI-versus-price divergence, long/short ratios, liquidation volumes by side with percentile ranks, basis and futures premium, spot versus perp volume split, and cumulative volume delta for both.

Asked: what does positioning say about who is in this move and how fragile they are? Is this fresh money or leverage chasing? Which side is exposed?

Clusters: `POSITIONING`, `LIQUIDATION`, `FLOW`.

This agent is doing the most valuable interpretive work in the system. The combinatorics of price × OI × funding × CVD are exactly where rules become brittle and a good reading adds real value.

### 2.3 Context Agent

Sees: deduplicated news items from the last 24h with source and pre-classified importance, exchange and regulatory announcements, the macro calendar for the next 72h with historical impact statistics, current macro regime indicators, and the upcoming catalyst list.

Asked: is there anything in the news or calendar that changes the picture? What is the single most likely external event to invalidate this thesis? Is the market already positioned for the upcoming catalyst?

Clusters: `NEWS`, `MACRO`, `EVENT`.

Deliberately weighted low (`01` §5.4). By the time an RSS feed delivers it, the move is usually done. This agent earns its keep as an invalidator, not an entry trigger.

### 2.4 Adversary Agent

Runs **last**, and sees everything: the full feature snapshot, the other three agents' verified claims, the current ensemble score, and the archetype's documented failure modes from `01` §3.1.

Asked, in one sentence: *assume this trade loses money — construct the most credible explanation of why, using only the data provided.*

Then required to answer four specific questions: which of the other agents' claims rest on the same underlying fact; what would have to be true for this setup to be a trap; which historical failure mode of this archetype most resembles the current configuration; and what single piece of missing information would most change the assessment.

Its output enters the ensemble as negative evidence and feeds the conflict metric in `01` §5.3.

The adversary is the highest-value agent in the set, because the other three are structurally biased toward finding something. They were invoked because a detector fired, they are looking at a candidate setup, and producing "nothing here" feels like failure. The adversary's incentives are inverted by construction.

---

## 3. Output contract

Strict JSON, schema-enforced, rejected outright if malformed. No prose outside the structure.

```jsonc
{
  "agent": "positioning",
  "promptVersion": "positioning@v3",
  "snapshotHash": "sha256:7d9e…",

  "stance": "BULLISH",          // BULLISH | BEARISH | NEUTRAL | ABSTAIN
  "strength": 0.55,             // −1..1, sign must agree with stance
  "selfConfidence": 0.7,        // how sure the agent is of its own read

  "claims": [
    {
      "text": "Open interest rose 8.2% over 24h while funding stayed at the 54th percentile — new positioning rather than a leverage chase",
      "stance": "BULLISH",
      "strength": 0.5,
      "featureIds": ["btc.oi_change_24h", "btc.funding_8h_pct_rank"],
      "observedValues": {
        "btc.oi_change_24h": 0.082,
        "btc.funding_8h_pct_rank": 0.54
      }
    }
  ],

  "abstainReason": null,        // required when stance = ABSTAIN
  "missingInformation": ["Options open interest by strike unavailable"],
  "wouldChangeMyView": "Funding moving above the 85th percentile without a corresponding price advance"
}
```

Three fields carry more weight than they appear to.

`featureIds` and `observedValues` are what make §4 possible. Without them a claim is unfalsifiable and the entire integrity model collapses.

`wouldChangeMyView` is stored and then *automatically monitored*. If the agent names a condition and that condition later occurs while the position is open, it fires as an invalidation check (`04` §3). The agent is, in effect, writing part of its own exit criteria — which is both useful and a good test of whether its reasoning was substantive.

`missingInformation` accumulates across hundreds of invocations into a prioritized data-acquisition backlog. When "options OI by strike" appears in 60% of snapshots, that is your answer about which paid feed to buy first.

---

## 4. Citation verification

The highest-value control in the system, and it is about thirty lines of code.

```
for each claim:
    for each (featureId, claimedValue) in claim.observedValues:

        if featureId not in snapshot:
            reject(claim, MISSING_FEATURE); continue

        actual = snapshot[featureId]
        relErr = |claimedValue − actual| / max(|actual|, 1e-9)

        if relErr > 0.05:
            reject(claim, CITATION_MISMATCH, {claimedValue, actual})

    if claim survives: admit to evidence graph
```

Rejected claims never reach the ensemble. They are written to `droppedClaims` on the opportunity, visible in the UI, and they debit the agent's integrity score.

```
rejectionRate = rejected / total, rolling 30-claim window

> 15%  →  agent SUSPENDED automatically, alert fires,
          ensemble continues with remaining agents
```

What this converts is important. Without verification, a fabricated "RSI at 71" silently inflates the score and there is no trace of it anywhere — you would discover the problem only as unexplained calibration drift months later. With verification it becomes a counted, alarmed, visible event. Hallucination stops being a lurking correctness risk and becomes an operational metric with a threshold.

Set the tolerance at 5% relative error deliberately. Tighter than that and legitimate rounding in the agent's prose triggers rejections; looser and material misstatements slip through.

---

## 5. Abstention is a first-class answer

Every agent may return `stance: "ABSTAIN"` with a reason. An abstaining agent contributes nothing to the ensemble — it does not push toward neutral, it is simply absent, and `N` in the shrinkage formula drops accordingly.

Prompts state this explicitly and repeatedly: *"If the data does not support a directional read, abstain. Abstaining is a correct answer and is scored as such. Do not manufacture a view."*

The scoring makes this real rather than decorative. Agents are graded on log loss (§7), and a confident wrong call is punished far more than an abstention. An agent that abstains on the 40% of snapshots where there is genuinely nothing to say will outscore one that always has an opinion — and it costs less to run.

Watch for the opposite failure too: an agent abstaining above 70% of the time is not being careful, it is being useless, and should be reviewed or retired.

---

## 6. Provider abstraction

Your instinct here was right. Formalizing it:

```typescript
interface AIProvider {
  readonly id: string;
  readonly model: string;

  analyze(req: {
    systemPrompt: string;
    userPayload: FeatureSnapshot;
    schema: JSONSchema;        // enforced server-side where supported
    temperature: number;       // 0 for analysis agents
    seed?: number;
    maxTokens: number;
    timeoutMs: number;
  }): Promise<{
    parsed: AgentOutput;
    raw: string;
    usage: { inputTokens: number; outputTokens: number; costUSD: number };
    latencyMs: number;
  }>;

  health(): Promise<{ ok: boolean; latencyP50: number }>;
}
```

Routing is configuration, not code:

```yaml
agents:
  structure:    { primary: provider_a, fallback: provider_b, temperature: 0 }
  positioning:  { primary: provider_a, fallback: provider_b, temperature: 0 }
  context:      { primary: provider_b, fallback: provider_c, temperature: 0 }
  adversary:    { primary: provider_c, fallback: provider_a, temperature: 0.3 }

triage:
  newsClassifier: { primary: cheap_model, temperature: 0 }
```

The adversary runs at a non-zero temperature on purpose — it is searching for alternative explanations, and a little diversity helps. Everything else runs at zero for reproducibility.

Deliberately route the adversary to a *different provider* from the primary analysts. Models from the same family share training data, share failure modes, and will agree with each other for reasons that have nothing to do with the market. Cross-provider adversarial review is a cheap source of genuine independence.

On fallback: chain through providers, then degrade to deterministic-only mode and raise `PROVIDER_OUTAGE` (`03` §5). Never block the pipeline on a model.

And on "free": assume every free tier will be rate-limited, deprecated, or priced at the worst possible moment. The abstraction exists so that swapping a provider is a config edit, and the trading engine never learns which model produced a claim.

---

## 7. Agent scoring

Four measurements, recomputed monthly from the outcome ledger.

**Brier score** on the agent's directional stance against realized outcome, compared against a base-rate predictor. Simple, interpretable, and the first thing to check.

**Log loss**, which is what actually drives decisions, because it punishes confident errors properly and rewards appropriate abstention.

**Reliability by regime**, as a Beta posterior. An agent may be excellent in trending regimes and worthless in ranges. This posterior mean is the `reliability[agent, regime]` term in the aggregation formula at `01` §5.1, so scoring feeds directly back into weighting with no manual intervention.

**Marginal information contribution** — the one that matters, and the one nobody builds:

```
MIC(agent) = LL_oos(ensemble without agent) − LL_oos(ensemble with agent)
```

Recompute the entire ensemble on historical opportunities with that agent's claims removed, and measure the change in out-of-sample log loss. Positive MIC means the agent adds information. Zero or negative means it is adding correlated noise — regardless of how accurate it looks in isolation.

This is the correct test precisely because an agent can be individually accurate and still contribute nothing, if everything it says is already implied by another agent's claims. Standalone accuracy cannot detect that. MIC can.

```
MIC ≤ 0 over 50+ opportunities  →  retire the agent
```

Retiring an agent should be a normal, unremarkable event. The published scorecard lives on the dashboard:

```
                Brier   LogLoss    MIC     Reject%   Abstain%   Regimes
structure       0.241    0.671   +0.018     2.1%      18%      strong: trending
positioning     0.228    0.648   +0.041     1.4%      22%      strong: all
context         0.249    0.688   +0.004     3.8%      41%      weak: ranging
adversary       0.236    0.659   +0.029     1.9%      12%      strong: high-vol
base rate       0.250    0.693      —         —         —
```

Read that table honestly and `context` is a candidate for retirement — a MIC of +0.004 is indistinguishable from noise, and it costs money on every invocation.

---

## 8. Cost control

Without discipline this system will make thousands of model calls a day and produce nothing extra for it.

**Event triggering.** Agents are invoked only when a detector fires or a re-evaluation trigger occurs. Never on a timer, never on a price tick. Expected volume at swing horizon: roughly 10–30 agent-invocation cycles per day across both assets, so 40–120 model calls daily.

**Triage tiering.** A cheap, fast model handles high-volume classification — news relevance, importance scoring, deduplication — where the task is simple and the volume is hundreds of items daily. Expensive models see only assembled, pre-filtered snapshots. This is typically a 10-to-1 cost reduction on the news path alone.

**Snapshot caching.** Hash the feature snapshot. Identical hash within 15 minutes reuses the prior response. Detectors firing repeatedly on the same bar is common and should cost nothing.

**Budgets.** A daily token budget with a hard cutoff, enforced in the orchestrator. On breach, the system degrades to deterministic-only and alerts — it does not queue, and it does not silently skip agents in a way that changes the ensemble composition without recording it.

**Payload discipline.** Send computed features, never raw candles. A snapshot should be on the order of 2–4 KB of structured numbers with clear names and units. Sending a thousand OHLCV rows and expecting the model to compute RSI is expensive, slow, and produces exactly the fabricated numbers that §4 exists to catch.

---

## 9. Reproducibility

Every invocation persists: prompt template id and version, the rendered prompt, provider and model id and version string, temperature and seed, the feature snapshot hash and the snapshot itself, the raw response, the parsed output, verification results, token usage and latency.

```
replayHash = sha256( promptVersion ‖ modelId ‖ temperature ‖ snapshotHash )
```

This makes three things possible. Exact replay of any historical decision for post-mortem. A/B testing of prompt versions on identical historical snapshots, scored by MIC. And detection of silent model updates — the same `replayHash` producing materially different output means the provider changed something underneath you, which happens more often than vendors admit and will quietly break your calibration.

---

## 10. Known failure modes

| Failure | Detection | Mitigation |
|---|---|---|
| Fabricated figures | Citation verification (§4) | Claim dropped, agent debited, auto-suspend above 15% |
| Narrative momentum — agreeing with the detector because it fired | Adversary MIC, conflict rate near zero | Cross-provider adversary, abstention rewarded |
| Correlated agents | `N_eff` tracking, MIC | Evidence graph collapse, retire low-MIC agents |
| Silent provider model change | `replayHash` output drift | Pin model versions, alert on drift, recalibrate |
| Schema drift / malformed output | Parse failure rate | Schema enforcement, one retry, then abstain |
| Prompt injection via news content | Delimiter and instruction scanning on ingest | News text is data, never instructions; strip and quarantine |
| Latency spike blocking the pipeline | Per-call timeout | Fail to fallback, then to deterministic-only |
| Cost runaway | Daily budget counter | Hard cutoff, degrade, alert |

Prompt injection deserves emphasis. News articles, exchange announcements and social posts are attacker-influenceable text that you are feeding into a model whose output shapes trading decisions. Treat all ingested text as hostile: strip instruction-like patterns, wrap it in explicit data delimiters, tell the model in the system prompt that content between those delimiters is quotable data and never instruction, and never let ingested text reach a prompt that has any tool access. The blast radius here is bounded by the fact that agents cannot execute anything — which is one more reason the architecture is shaped the way it is.
