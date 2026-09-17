/**
 * Signal-bot loop.
 *
 * Runs on its own timer, entirely separate from the archetype engine in
 * `engine/index.ts`. By default it only records BUY/SELL/HOLD decisions;
 * execution is opt-in via `autoExecute` and, when enabled, goes through the
 * engine's normal position-limit checks rather than around them.
 */

import { getCandles } from "../marketData.js";
import type { Candle } from "../types.js";
import { DEFAULT_STRATEGY_CONFIG, decideSignal, type StrategyConfig, type StrategyDecision } from "./strategy.js";
import type { Asset } from "../types.js";

const ASSETS: Asset[] = ["BTCUSDT", "ETHUSDT"];
const INTERVAL = "15m";
const MAX_LOG = 200;
const CANDLE_LIMIT = 250;

/**
 * Candles come from Delta so the strategy reads the same book it trades on.
 * The internal Binance feed is the fallback when Delta is unreachable — the
 * bot degrades to a slightly different price source rather than going blind.
 */
async function loadCandles(asset: Asset): Promise<{ candles: Candle[]; source: "delta" | "internal" }> {
  try {
    const { getDeltaCandles } = await import("../services/deltaExchange.js");
    const deltaCandles = await getDeltaCandles(asset, INTERVAL, CANDLE_LIMIT);
    if (deltaCandles.length > 0) return { candles: deltaCandles, source: "delta" };
  } catch (error: any) {
    console.warn(`[bot] Delta candles unavailable for ${asset} (${error?.message ?? error}) — using internal feed`);
  }
  return { candles: getCandles(asset, INTERVAL), source: "internal" };
}

export interface BotConfig {
  intervalMs: number;
  autoExecute: boolean;
  /** Fraction of equity risked per auto-executed trade. */
  riskPerTrade: number;
  stopLossPct: number;
  takeProfitPct: number;
  strategy: StrategyConfig;
}

export interface BotDecision extends StrategyDecision {
  id: string;
  executed: boolean;
  candleSource: "delta" | "internal";
  executionError?: string;
  tradeId?: string;
  deltaOrderId?: string;
}

interface BotState {
  running: boolean;
  startedAt: number | null;
  lastRunAt: number | null;
  nextRunAt: number | null;
  runCount: number;
}

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_RISK_PER_TRADE = 0.01;

let config: BotConfig = {
  intervalMs: DEFAULT_INTERVAL_MS,
  autoExecute: false,
  riskPerTrade: DEFAULT_RISK_PER_TRADE,
  stopLossPct: 0.02,
  takeProfitPct: 0.04,
  strategy: { ...DEFAULT_STRATEGY_CONFIG },
};

let state: BotState = {
  running: false,
  startedAt: null,
  lastRunAt: null,
  nextRunAt: null,
  runCount: 0,
};

const decisions: BotDecision[] = [];
let timer: ReturnType<typeof setInterval> | null = null;

type Broadcaster = (event: string, payload: unknown) => void;
let broadcast: Broadcaster = () => {};
export function setBotBroadcaster(fn: Broadcaster) {
  broadcast = fn;
}

export function getBotConfig(): BotConfig {
  return config;
}

export function updateBotConfig(patch: Partial<BotConfig>): BotConfig {
  // Spreading the patch directly would let an absent field (arriving as
  // `undefined` from the route's destructuring) erase a real value. Toggling
  // auto-execute alone used to wipe intervalMs, which made setInterval fire on
  // a 0ms delay and starve the event loop — the price feed and engine scans
  // stopped updating as a result.
  const defined = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined)
  ) as Partial<BotConfig>;

  config = {
    ...config,
    ...defined,
    strategy: { ...config.strategy, ...(defined.strategy ?? {}) },
  };

  // Defence in depth: even a bad direct call can't produce a runaway timer.
  if (!Number.isFinite(config.intervalMs) || config.intervalMs < 10_000) {
    config.intervalMs = DEFAULT_INTERVAL_MS;
  }
  if (!Number.isFinite(config.riskPerTrade) || config.riskPerTrade <= 0) {
    config.riskPerTrade = DEFAULT_RISK_PER_TRADE;
  }
  if (state.running) {
    // Restart the timer so an interval change takes effect immediately.
    stopBot();
    startBot();
  }
  return config;
}

export function getBotState(): BotState & { config: BotConfig } {
  return { ...state, config };
}

export function getBotDecisions(limit = 50, asset?: Asset): BotDecision[] {
  const filtered = asset ? decisions.filter((d) => d.asset === asset) : decisions;
  return filtered.slice(0, limit);
}

export function getBotStats() {
  const counts = { BUY: 0, SELL: 0, HOLD: 0 };
  for (const d of decisions) counts[d.signal]++;

  const executed = decisions.filter((d) => d.executed).length;
  const actionable = decisions.filter((d) => d.signal !== "HOLD");
  const avgConfidence = actionable.length
    ? actionable.reduce((sum, d) => sum + d.confidence, 0) / actionable.length
    : 0;

  return {
    totalDecisions: decisions.length,
    counts,
    executed,
    avgConfidence,
    lastRunAt: state.lastRunAt,
    running: state.running,
  };
}

async function executeDecision(decision: BotDecision): Promise<void> {
  const { openManualTrade, getEngineState } = await import("../engine/index.js");
  const delta = await import("../services/deltaExchange.js");

  const price = decision.indicators.price;
  const direction = decision.signal === "BUY" ? "LONG" : "SHORT";
  const dirSign = direction === "LONG" ? 1 : -1;

  const stopPrice = price - dirSign * price * config.stopLossPct;
  const takeProfit = price + dirSign * price * config.takeProfitPct;

  // Delta perpetuals trade in whole contracts, each worth contract_value of the
  // base asset — so risk-based sizing has to be floored to an integer lot.
  const equity = getEngineState().equity;
  const riskUsd = equity * config.riskPerTrade;
  const product = await delta.getDeltaProduct(decision.asset);
  const contractValue = Number(product.contract_value);
  const riskPerContract = Math.abs(price - stopPrice) * contractValue;
  const contracts = Math.floor(riskUsd / riskPerContract);

  if (!Number.isFinite(contracts) || contracts < 1) {
    decision.executionError = `Risk budget ${riskUsd.toFixed(2)} is below one contract (needs ${riskPerContract.toFixed(2)})`;
    return;
  }

  // The order itself is placed by the engine's openTrade choke point, so the
  // bot must not send one too — doing both would double the position.
  const result = openManualTrade({
    asset: decision.asset,
    direction,
    entryPrice: price,
    stopPrice,
    targets: [takeProfit],
    quantity: contracts * contractValue,
    setupType: "BOT_SIGNAL",
    notes: decision.reasons.join("; "),
  });
  if (result.ok) {
    decision.executed = true;
    decision.tradeId = result.trade.id;
    decision.deltaOrderId = result.trade.execution?.orderId;
  } else {
    decision.executionError = result.error;
  }
}

/** Best-effort audit trail; the bot must keep running if Mongo is down. */
async function persistDecision(decision: BotDecision): Promise<void> {
  try {
    const { isMongoConnected } = await import("../db/mongodb.js");
    if (!isMongoConnected()) return;
    const { BotDecision: BotDecisionModel } = await import("../db/models/index.js");
    await BotDecisionModel.findOneAndUpdate(
      { decisionId: decision.id },
      {
        decisionId: decision.id,
        asset: decision.asset,
        time: new Date(decision.time),
        signal: decision.signal,
        confidence: decision.confidence,
        reasons: decision.reasons,
        indicators: decision.indicators,
        executed: decision.executed,
        executionError: decision.executionError,
        tradeId: decision.tradeId,
        deltaOrderId: decision.deltaOrderId,
      },
      { upsert: true }
    );
  } catch (error) {
    console.warn("[bot] failed to persist decision:", error);
  }
}

async function runOnce(): Promise<BotDecision[]> {
  const produced: BotDecision[] = [];
  state.lastRunAt = Date.now();
  state.nextRunAt = state.running ? state.lastRunAt + config.intervalMs : null;
  state.runCount++;

  for (const asset of ASSETS) {
    const { candles, source } = await loadCandles(asset);
    const decision = decideSignal(asset, candles, config.strategy);
    if (!decision) continue;

    const entry: BotDecision = {
      ...decision,
      id: `bot_${decision.time}_${asset}`,
      executed: false,
      candleSource: source,
    };

    if (config.autoExecute && entry.signal !== "HOLD") {
      // High-impact macro releases gate NEW entries only; positions already open
      // keep being managed by their stops and targets.
      const { getNewsBlackout } = await import("../services/newsCalendar.js");
      const blackout = getNewsBlackout();
      if (blackout.active) {
        entry.executionError = `News blackout: ${blackout.event?.title} in ${blackout.event?.minutesAway}m`;
      } else {
        try {
          await executeDecision(entry);
        } catch (error: any) {
          entry.executionError = error?.message ?? String(error);
        }
      }
    }

    decisions.unshift(entry);
    produced.push(entry);
    void persistDecision(entry);
    broadcast("bot_decision", entry);
  }

  if (decisions.length > MAX_LOG) decisions.length = MAX_LOG;
  broadcast("bot_state", getBotState());
  return produced;
}

/** Runs the strategy immediately without touching the schedule. */
export function runBotNow(): Promise<BotDecision[]> {
  return runOnce();
}

export function startBot(): BotState & { config: BotConfig } {
  if (timer) return getBotState();

  state.running = true;
  state.startedAt = Date.now();
  timer = setInterval(() => {
    void runOnce().catch((e) => console.error("[bot] run failed:", e));
  }, config.intervalMs);

  // Produce a first decision immediately so the UI isn't blank until the
  // first interval elapses.
  void runOnce().catch((e) => console.error("[bot] initial run failed:", e));

  console.log(`[bot] started — every ${config.intervalMs / 1000}s, autoExecute=${config.autoExecute}`);
  broadcast("bot_state", getBotState());
  return getBotState();
}

export function stopBot(): BotState & { config: BotConfig } {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  state.running = false;
  state.startedAt = null;
  state.nextRunAt = null;
  console.log("[bot] stopped");
  broadcast("bot_state", getBotState());
  return getBotState();
}

/** Latest indicator readings per asset, for the live indicator badges. */
export async function getLiveIndicators() {
  return Promise.all(
    ASSETS.map(async (asset) => {
      const { candles, source } = await loadCandles(asset);
      const decision = decideSignal(asset, candles, config.strategy);
      return {
        asset,
        signal: decision?.signal ?? "HOLD",
        indicators: decision?.indicators ?? null,
        candleSource: source,
      };
    })
  );
}
