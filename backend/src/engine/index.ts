import { randomUUID } from "node:crypto";
import type { Asset, Direction, EngineState, Trade, VetoedOpportunity } from "../types.js";
import { getCandles, getLastPrice, onPrice, startMarketData } from "../marketData.js";
import { addEquityPoint, getEquityCurve, getKv, getTrades, setKv, upsertTrade } from "../db.js";
import { runPipeline, scoreCandidate, type PipelineOutput } from "../decision/pipeline.js";
import { classifyRegime } from "../decision/regime.js";
import { detectArchetypes } from "../decision/archetypes.js";
import { atr } from "../lib/indicators.js";
import type { ArchetypeCandidate } from "../decision/types.js";
import { manageTrade } from "../lifecycle/manager.js";
import { onTradeClosed } from "../learning/recalibrate.js";
import { evaluateCircuitBreakers, openRiskFromTrade, type OpenRisk } from "../risk/portfolio.js";

const ASSETS: Asset[] = ["BTCUSDT", "ETHUSDT"];
const INTERVAL = "15m";
const MAX_CONCURRENT_POSITIONS = 3; // docs/03 §2.2
const MAX_POSITIONS_PER_ASSET = 1;

const STARTING_EQUITY = Number(process.env.STARTING_EQUITY ?? 10000);

let state: EngineState = {
  running: false,
  startedAt: null,
  equity: Number(getKv("equity") ?? STARTING_EQUITY),
  startingEquity: STARTING_EQUITY,
  openPositions: 0,
};

let equityPeak = Number(getKv("equityPeak") ?? state.equity);
let dayStartEquity = Number(getKv("dayStartEquity") ?? state.equity);
let dayStartDate = getKv("dayStartDate") ?? new Date().toISOString().slice(0, 10);

const openTrades = new Map<string, Trade>();
const recentOpportunities: (VetoedOpportunity & { decision: string })[] = [];
const MAX_OPPORTUNITY_LOG = 100;

type Broadcaster = (event: string, payload: unknown) => void;
let broadcast: Broadcaster = () => {};
export function setBroadcaster(fn: Broadcaster) {
  broadcast = fn;
}

function loadOpenTradesFromDb() {
  for (const t of getTrades()) {
    if (t.status === "OPEN") openTrades.set(t.id, t);
  }
  state.openPositions = openTrades.size;
}

function persistEquity(realizedPnl: number) {
  setKv("equity", String(state.equity));
  if (state.equity > equityPeak) {
    equityPeak = state.equity;
    setKv("equityPeak", String(equityPeak));
  }
  addEquityPoint({ time: Math.floor(Date.now() / 1000), equity: state.equity, realizedPnl });
}

function rolloverDayIfNeeded() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dayStartDate) {
    dayStartDate = today;
    dayStartEquity = state.equity;
    setKv("dayStartDate", dayStartDate);
    setKv("dayStartEquity", String(dayStartEquity));
  }
}

function getOpenRiskExcept(asset: Asset | null): OpenRisk[] {
  return [...openTrades.values()]
    .filter((t) => t.asset !== asset)
    .map((t) => openRiskFromTrade(t, getLastPrice(t.asset) ?? t.entryPrice));
}

function circuitBreakerTripped(): boolean {
  rolloverDayIfNeeded();
  const recentClosed = getTrades().filter((t) => t.status === "CLOSED");
  const cb = evaluateCircuitBreakers(state.equity, dayStartEquity, equityPeak, recentClosed);
  return cb.dailyLossTripped || cb.drawdownTripped || cb.consecutiveLosses >= 4;
}

function logOpportunity(asset: Asset, decision: string, out: ReturnType<typeof runPipeline>) {
  if (out.decision === "NONE") return;
  const entry: VetoedOpportunity & { decision: string } = {
    id: randomUUID(),
    time: Date.now(),
    asset,
    direction: out.candidate?.direction ?? "LONG",
    archetype: out.candidate?.archetype ?? "COMPRESSION_BREAKOUT",
    regime: out.regime.label,
    vetoReasons: out.vetoReasons,
    calibratedWinProb: out.calibratedWinProb ?? 0,
    evNetR: out.evNetR ?? 0,
    decision,
  };
  recentOpportunities.unshift(entry);
  if (recentOpportunities.length > MAX_OPPORTUNITY_LOG) recentOpportunities.length = MAX_OPPORTUNITY_LOG;
  broadcast("opportunity", entry);
}

interface ScanInfo {
  asset: Asset;
  time: number;
  regime: string;
  regimeConfidence: number;
  hasCandidate: boolean;
}

const lastHeartbeat = new Map<Asset, number>();
const lastScanInfo = new Map<Asset, ScanInfo>();
const HEARTBEAT_INTERVAL_MS = 8000;

export function getLastScans(): ScanInfo[] {
  return [...lastScanInfo.values()];
}

/**
 * Emits a lightweight "we scanned this asset and here's why nothing happened"
 * signal, throttled per asset. Distinct from the opportunity feed, which only
 * logs when an archetype detector actually fires (by design — NO_SETUP is
 * meant to dominate). Without this, an engine that is running correctly but
 * simply hasn't seen a qualifying setup yet is indistinguishable in the UI
 * from one that has silently stalled.
 */
function maybeBroadcastHeartbeat(asset: Asset) {
  const now = Date.now();
  const last = lastHeartbeat.get(asset) ?? 0;
  if (now - last < HEARTBEAT_INTERVAL_MS) return;
  lastHeartbeat.set(asset, now);

  const candles = getCandles(asset, INTERVAL);
  if (candles.length === 0) return;
  const regime = classifyRegime(asset, candles, now);
  const candidates = detectArchetypes(asset, candles, regime.label);
  const info: ScanInfo = {
    asset,
    time: now,
    regime: regime.label,
    regimeConfidence: regime.confidence,
    hasCandidate: candidates.length > 0,
  };
  lastScanInfo.set(asset, info);
  broadcast("scan", info);
}

function buildTradeFromOpportunity(asset: Asset, out: PipelineOutput, reasonOverride?: string): Trade {
  const c = out.candidate!;
  const sizing = out.sizing!;
  return {
    id: randomUUID(),
    asset,
    direction: c.direction,
    archetype: c.archetype,
    regime: out.regime.label,
    entryPrice: c.entryPrice,
    entryTime: Date.now(),
    exitPrice: null,
    exitTime: null,
    initialQuantity: sizing.quantity,
    remainingQuantity: sizing.quantity,
    initialStopPrice: c.stopPrice,
    stopPrice: c.stopPrice,
    targets: c.targets.map((t) => ({ ...t, hit: false, hitTime: null })),
    fills: [],
    status: "OPEN",
    realizedPnlUsd: 0,
    pnlUsd: null,
    pnlPct: null,
    rMultiple: null,
    reason: reasonOverride ?? c.structuralReason,
    exitReason: null,
    rawScore: out.rawScore ?? 0.5,
    calibratedWinProb: out.calibratedWinProb ?? 0.5,
    calibratedWinProbCI90: out.calibratedWinProbCI90 ?? [0.3, 0.7],
    calibrationStage: out.calibrationStage ?? "A_UNCALIBRATED",
    evNetR: out.evNetR ?? 0,
    evNetUsd: out.evNetUsd ?? 0,
    costBreakdown: out.costBreakdown ?? { feesR: 0, slippageR: 0, fundingR: 0, totalR: 0 },
    evidenceClusters: (out.evidence?.clusters ?? []).map((cl) => cl.cluster),
    nEffectiveSignals: out.evidence?.nEffectiveSignals ?? 0,
    conflict: out.evidence?.conflict ?? 0,
    kellyFraction: sizing.kellyFraction,
    appliedFraction: sizing.appliedFraction,
    bindingConstraint: sizing.bindingConstraint,
    haircuts: sizing.haircuts,
    entryClusterStrengths: out.entryClusterStrengths ?? {},
    thesisDecay: 1,
    breakevenMoved: false,
    maxFavorableExcursionR: 0,
    maxAdverseExcursionR: 0,
    maxHoldHours: c.maxHoldHours,
  };
}

function openTrade(asset: Asset, trade: Trade) {
  openTrades.set(trade.id, trade);
  upsertTrade(trade);
  state.openPositions = openTrades.size;
  broadcast("trade_opened", trade);
}

function tryOpenPosition(asset: Asset) {
  if (!state.running) return;
  maybeBroadcastHeartbeat(asset);
  const perAssetOpen = [...openTrades.values()].filter((t) => t.asset === asset).length;
  if (perAssetOpen >= MAX_POSITIONS_PER_ASSET) return;
  if (openTrades.size >= MAX_CONCURRENT_POSITIONS) return;

  const candles = getCandles(asset, INTERVAL);
  const existingOpenRisk = getOpenRiskExcept(asset);
  const tripped = circuitBreakerTripped();
  const out = runPipeline(asset, candles, state.equity, existingOpenRisk, tripped, Date.now());

  logOpportunity(asset, out.decision, out);

  if (out.decision !== "OPEN" || !out.candidate || !out.sizing) return;
  openTrade(asset, buildTradeFromOpportunity(asset, out));
}

/**
 * Manual demo/debug path: bypasses archetype detection (builds a synthetic
 * compression-breakout-shaped candidate at the current price) AND the risk
 * gates, so a trade opens immediately regardless of whether the engine's
 * own honest scoring would take it. Every trade opened this way is labelled
 * as such in its `reason` and carries a `MANUAL_FORCE_OPEN_BYPASSED_GATES`
 * marker — it exists to let you see the full lifecycle/UI flow without
 * waiting for a real archetype to fire, not to represent a real signal.
 */
export function forceOpenTrade(asset: Asset, direction: Direction = "LONG"): { ok: true; trade: Trade } | { ok: false; error: string } {
  const perAssetOpen = [...openTrades.values()].filter((t) => t.asset === asset).length;
  if (perAssetOpen >= MAX_POSITIONS_PER_ASSET) {
    return { ok: false, error: `An open position already exists for ${asset}` };
  }

  const candles = getCandles(asset, INTERVAL);
  const price = getLastPrice(asset);
  if (candles.length < 60 || price === null) {
    return { ok: false, error: "Not enough market data yet" };
  }

  const a = atr(candles, 14) || price * 0.005;
  const stopDist = 1.5 * a;
  const dirSign = direction === "LONG" ? 1 : -1;
  const candidate: ArchetypeCandidate = {
    archetype: "COMPRESSION_BREAKOUT",
    direction,
    asset,
    entryPrice: price,
    stopPrice: price - dirSign * stopDist,
    targets: [1.16, 2.47, 3.79].map((r, i) => ({
      price: price + dirSign * stopDist * r,
      fraction: [0.4, 0.35, 0.25][i],
      r,
    })),
    maxHoldHours: 48,
    structuralReason: "Manually forced open — bypassed archetype detection and risk gates for demonstration purposes",
    atr: a,
  };

  const regime = classifyRegime(asset, candles, Date.now());
  const existingOpenRisk = getOpenRiskExcept(asset);
  const out = scoreCandidate(asset, candles, candidate, regime, state.equity, existingOpenRisk, false, Date.now(), {
    bypassGatesAndForceSize: true,
  });

  if (!out.candidate || !out.sizing) {
    return { ok: false, error: "Scoring failed unexpectedly" };
  }

  const trade = buildTradeFromOpportunity(asset, out, candidate.structuralReason);
  openTrade(asset, trade);
  logOpportunity(asset, "OPEN", out);
  return { ok: true, trade };
}

function manageOpenTrades(asset: Asset) {
  const candles = getCandles(asset, INTERVAL);
  if (candles.length === 0) return;
  for (const trade of [...openTrades.values()]) {
    if (trade.asset !== asset) continue;
    const result = manageTrade(trade, candles, Date.now());
    upsertTrade(result.trade);
    if (result.newFills.length > 0) broadcast("trade_updated", result.trade);
    if (result.closed) {
      openTrades.delete(trade.id);
      state.openPositions = openTrades.size;
      persistTradeClose(trade);
    }
  }
}

function persistTradeClose(trade: Trade) {
  state.equity += trade.realizedPnlUsd;
  persistEquity(trade.realizedPnlUsd);
  onTradeClosed(trade);
  broadcast("trade_closed", trade);
  broadcast("equity", { time: Date.now(), equity: state.equity });
}

let initialized = false;

export async function initEngine() {
  if (initialized) return;
  initialized = true;
  loadOpenTradesFromDb();
  await startMarketData(ASSETS, [INTERVAL]);
  onPrice((asset) => {
    manageOpenTrades(asset);
    tryOpenPosition(asset);
    broadcast("price", { asset, price: getLastPrice(asset), time: Date.now() });
  });
}

export function startEngine() {
  state.running = true;
  state.startedAt = Date.now();
  broadcast("engine_state", state);
}

export function stopEngine() {
  state.running = false;
  state.startedAt = null;
  broadcast("engine_state", state);
}

export function getEngineState(): EngineState {
  return state;
}

export function getAssets(): Asset[] {
  return ASSETS;
}

export function getInterval(): string {
  return INTERVAL;
}

export function getRecentOpportunities() {
  return recentOpportunities;
}

export { getEquityCurve };
