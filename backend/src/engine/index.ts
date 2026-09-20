import { randomUUID } from "node:crypto";
import type { Asset, Direction, EngineState, Trade, VetoedOpportunity } from "../types.js";
import { getCandles, getLastPrice, onPrice, startMarketData } from "../marketData.js";
import { acquireEngineLease, addEquityPoint, getEquityCurve, getKv, getTrades, refreshLedger, releaseEngineLease, setKv, upsertTrade } from "../db.js";
import { runPipeline, scoreCandidate, type PipelineOutput } from "../decision/pipeline.js";
import { classifyRegime } from "../decision/regime.js";
import { detectArchetypes } from "../decision/archetypes.js";
import { atr as _computeAtr } from "../lib/indicators.js";
import type { ArchetypeCandidate } from "../decision/types.js";
import { applyExchangeClose, finalizeClose, manageTrade } from "../lifecycle/manager.js";
import { onTradeClosed } from "../learning/recalibrate.js";
import { openShadow, updateShadows, getShadowSummary } from "../learning/shadow.js";
import { checkEntryLiquidity, liquidityGateMode } from "../services/liquidity.js";
import { recentLoggedOpportunities, recordOpportunity, recordScan, reloadActivity } from "../stats/activity.js";
import { syncBrackets, verifyBrackets, findExchangeExit } from "../services/brackets.js";
import { evaluateCircuitBreakers, openRiskFromTrade, type OpenRisk } from "../risk/portfolio.js";

const ASSETS: Asset[] = ["BTCUSDT", "ETHUSDT"];
const INTERVAL = "15m";
const MAX_CONCURRENT_POSITIONS = 3; // docs/03 §2.2
const MAX_POSITIONS_PER_ASSET = 1;

const STARTING_EQUITY = Number(process.env.STARTING_EQUITY ?? 10000);

/**
 * Live balance from Delta Exchange. Throws rather than falling back to a local
 * number — a silent fallback would present the simulated starting equity as a
 * real exchange balance, which is exactly the thing we must never do.
 */
interface DeltaBalanceSnapshot {
  equity: number;
  walletBalance: number;
  availableBalance: number;
  unrealizedPnl: number;
  positionMargin: number;
  assetSymbol: string;
  fetchedAt: number;
}

let cachedDeltaBalance: DeltaBalanceSnapshot | null = null;
let lastBalanceFetch = 0;
const BALANCE_CACHE_MS = 30000;
const SETTLEMENT_SYMBOLS = ["USDT", "USD", "USDC"];

function deltaConfigured(): boolean {
  return Boolean(process.env.DELTA_EXCHANGE_API_KEY && process.env.DELTA_EXCHANGE_API_SECRET);
}

async function fetchDeltaBalance(): Promise<DeltaBalanceSnapshot> {
  if (!deltaConfigured()) {
    throw new Error("Delta Exchange credentials not configured");
  }

  const now = Date.now();
  if (cachedDeltaBalance !== null && now - lastBalanceFetch < BALANCE_CACHE_MS) {
    return cachedDeltaBalance;
  }

  const { getDeltaBalance } = await import("../services/deltaExchange.js");
  const balances = await getDeltaBalance();

  if (!Array.isArray(balances)) {
    throw new Error("Unexpected balance payload from Delta Exchange");
  }

  // Settlement currency varies by Delta region: USDT on the global exchange,
  // USD on the India books. Take the first funded one in preference order.
  const symbolOf = (b: any) => b.asset_symbol ?? b.asset?.symbol;
  const wallets = SETTLEMENT_SYMBOLS.map((symbol) =>
    balances.find((b: any) => symbolOf(b) === symbol)
  ).filter(Boolean);

  if (wallets.length === 0) {
    const found = balances.map(symbolOf).filter(Boolean).join(", ") || "none";
    throw new Error(
      `No settlement wallet (${SETTLEMENT_SYMBOLS.join("/")}) on the Delta account — found: ${found}`
    );
  }

  const funded = wallets.find((w: any) => Number(w.available_balance ?? w.balance) > 0) ?? wallets[0];
  const numberField = (...names: string[]) => {
    for (const name of names) {
      const value = Number(funded[name]);
      if (Number.isFinite(value)) return value;
    }
    return 0;
  };
  const walletBalance = numberField("balance", "wallet_balance");
  const availableBalance = numberField("available_balance", "available");
  const unrealizedPnl = numberField("unrealized_pnl", "unrealizedPnl");
  const positionMargin = numberField("position_margin", "blocked_margin", "margin");
  const reportedEquity = numberField("equity", "account_equity");
  const equity = reportedEquity !== 0 ? reportedEquity : walletBalance + unrealizedPnl;
  if (!Number.isFinite(equity)) {
    throw new Error(`Delta Exchange returned non-numeric balance fields for ${symbolOf(funded)}`);
  }

  cachedDeltaBalance = {
    equity,
    walletBalance,
    availableBalance,
    unrealizedPnl,
    positionMargin,
    assetSymbol: String(symbolOf(funded)),
    fetchedAt: now,
  };
  lastBalanceFetch = now;
  return cachedDeltaBalance;
}

let state: EngineState = {
  running: false,
  startedAt: null,
  equity: Number(getKv("equity") ?? STARTING_EQUITY),
  startingEquity: STARTING_EQUITY,
  openPositions: 0,
};

let reconciliationRunning = false;

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

/** Called after MongoDB ledger hydration, because this module is imported before startup connects. */
export function reloadPersistedState() {
  reloadActivity();
  if (recentOpportunities.length === 0) {
    for (const o of recentLoggedOpportunities(MAX_OPPORTUNITY_LOG)) {
      recentOpportunities.push({
        id: o.id,
        time: o.time,
        asset: o.asset as Asset,
        direction: o.direction as Direction,
        archetype: o.archetype as any,
        regime: o.regime as any,
        vetoReasons: o.vetoReasons,
        vetoDetails: o.vetoDetails,
        setupReason: o.setupReason,
        calibratedWinProb: o.calibratedWinProb,
        evNetR: o.evNetR,
        decision: o.decision,
      });
    }
  }
  state.equity = Number(getKv("equity") ?? STARTING_EQUITY);
  equityPeak = Number(getKv("equityPeak") ?? state.equity);
  dayStartEquity = Number(getKv("dayStartEquity") ?? state.equity);
  dayStartDate = getKv("dayStartDate") ?? new Date().toISOString().slice(0, 10);
  openTrades.clear();
  loadOpenTradesFromDb();
}

export async function syncEngineFromLedger() {
  await refreshLedger();
  reloadPersistedState();
}

/** Shared status for read-only instances; engine execution remains leader-only. */
export async function getSharedEngineState(): Promise<EngineState> {
  await refreshLedger();
  const sharedRunning = getKv("engineRunning");
  const sharedStartedAt = getKv("engineStartedAt");
  if (sharedRunning !== null) {
    return {
      ...state,
      running: sharedRunning === "true",
      startedAt: sharedStartedAt ? Number(sharedStartedAt) : null,
      equity: Number(getKv("equity") ?? state.equity),
    };
  }
  return state;
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
    .map((t) => openRiskFromTrade(t, getLastPrice(t.asset) ?? t.entryPrice, state.equity));
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
    vetoDetails: out.vetoDetails,
    setupReason: out.candidate?.structuralReason,
    entryPrice: out.candidate?.entryPrice,
    stopPrice: out.candidate?.stopPrice,
    calibratedWinProb: out.calibratedWinProb ?? 0,
    evNetR: out.evNetR ?? 0,
    costR: out.costBreakdown?.totalR,
    decision,
  };
  recentOpportunities.unshift(entry);
  if (recentOpportunities.length > MAX_OPPORTUNITY_LOG) recentOpportunities.length = MAX_OPPORTUNITY_LOG;
  recordOpportunity({
    id: entry.id,
    time: entry.time,
    asset: entry.asset,
    direction: entry.direction,
    archetype: entry.archetype,
    regime: entry.regime,
    decision,
    vetoReasons: entry.vetoReasons,
    vetoDetails: entry.vetoDetails,
    setupReason: entry.setupReason,
    calibratedWinProb: entry.calibratedWinProb,
    evNetR: entry.evNetR,
  });
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

  // Placing the exchange order is async, but every caller of openTrade is
  // synchronous, so the local trade is recorded first and the fill is attached
  // when it lands. The trade's execution field says which state it is in.
  void (async () => {
    const { mirrorOpenToDelta } = await import("../services/execution.js");
    await mirrorOpenToDelta(trade, (updatedTrade) => {
      upsertTrade(updatedTrade);
      broadcast("trade_updated", updatedTrade);
    });
    upsertTrade(trade);
    broadcast("trade_updated", trade);
    if (trade.execution?.status === "FILLED") {
      console.log(`[engine] Delta order ${trade.execution.orderId} filled — ${trade.execution.contracts} contracts ${trade.direction} ${trade.asset}`);
    } else if (trade.execution?.error) {
      console.warn(`[engine] Delta order for ${trade.asset} ${trade.execution.status}: ${trade.execution.error}`);
    }
  })();
}

const SETUP_COOLDOWN_MS = Number(process.env.SETUP_COOLDOWN_MIN ?? 60) * 60_000;
const lastSetupAt = new Map<string, number>();

const evaluating = new Set<Asset>();

function tryOpenPosition(asset: Asset) {
  // The liquidity check awaits the network, so guard against overlapping evaluations of one asset.
  if (evaluating.has(asset)) return;
  evaluating.add(asset);
  void evaluateAndMaybeOpen(asset)
    .catch((error) => console.error(`[engine] evaluation failed for ${asset}:`, error))
    .finally(() => evaluating.delete(asset));
}

async function evaluateAndMaybeOpen(asset: Asset) {
  if (!state.running) return;
  const perAssetOpen = [...openTrades.values()].filter((t) => t.asset === asset).length;
  if (perAssetOpen >= MAX_POSITIONS_PER_ASSET) return;
  if (openTrades.size >= MAX_CONCURRENT_POSITIONS) return;

  const candles = getCandles(asset, INTERVAL);

  // Cache ATR for the mid-candle momentum spike detector
  if (candles.length >= 15) {
    lastKnownAtr.set(asset, _computeAtr(candles, 14));
  }

  const existingOpenRisk = getOpenRiskExcept(asset);
  const tripped = circuitBreakerTripped();
  let out = runPipeline(asset, candles, state.equity, existingOpenRisk, tripped, Date.now());
  recordScan(out.decision !== "NONE");

  // Liquidity gate: never enter a market whose spread or depth makes the trade a loss on arrival.
  if (out.decision === "OPEN" && out.candidate && out.sizing) {
    const liquidity = await checkEntryLiquidity(asset, out.candidate.direction, out.sizing.quantity);
    if (!liquidity.ok) {
      if (liquidityGateMode() === "enforce") {
        out = { ...out, decision: "VETO", vetoReasons: ["LIQUIDITY_GATE"], vetoDetails: [liquidity.detail] };
      } else {
        console.warn(`[liquidity] ${asset} would be blocked (shadow mode): ${liquidity.detail}`);
      }
    }
    if (!state.running) return;
  }

  // Cooldown: a setup usually persists across several consecutive candles. Log/shadow/open it once
  // per cooldown window instead of on every bar (which spams the feed and double-counts outcomes).
  if (out.candidate) {
    const setupKey = `${asset}|${out.candidate.archetype}|${out.candidate.direction}`;
    const key = out.decision === "OPEN" ? setupKey : `${setupKey}|${out.decision}`;
    const now = Date.now();
    if (now - (lastSetupAt.get(key) ?? 0) < SETUP_COOLDOWN_MS) return;
    lastSetupAt.set(key, now);
  }

  logOpportunity(asset, out.decision, out);

  if (out.decision !== "OPEN") {
    if (out.candidate) openShadow(asset, out, candles);
    return;
  }
  if (!out.candidate || !out.sizing) return;
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

  const a = _computeAtr(candles, 14) || price * 0.005;
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

/**
 * Opens a trade from user-supplied levels. Unlike forceOpenTrade this takes the
 * entry, stop and targets from the trader rather than synthesising them, and it
 * skips scoring entirely — there is no model opinion to record for a discretionary
 * trade, so the probability fields stay at their uninformative defaults.
 */
export function openManualTrade(params: {
  asset: Asset;
  direction: Direction;
  entryPrice: number;
  stopPrice: number;
  targets?: number[];
  quantity: number;
  setupType?: string;
  notes?: string;
}): { ok: true; trade: Trade } | { ok: false; error: string } {
  const { asset, direction, entryPrice, stopPrice, quantity } = params;

  const perAssetOpen = [...openTrades.values()].filter((t) => t.asset === asset).length;
  if (perAssetOpen >= MAX_POSITIONS_PER_ASSET) {
    return { ok: false, error: `An open position already exists for ${asset}` };
  }
  if (openTrades.size >= MAX_CONCURRENT_POSITIONS) {
    return { ok: false, error: `Max concurrent positions (${MAX_CONCURRENT_POSITIONS}) reached` };
  }

  const dirSign = direction === "LONG" ? 1 : -1;
  const stopDist = (entryPrice - stopPrice) * dirSign;
  if (stopDist <= 0) {
    return {
      ok: false,
      error: direction === "LONG"
        ? "Stop loss must be below entry price for a LONG"
        : "Stop loss must be above entry price for a SHORT",
    };
  }

  const targetPrices = params.targets?.length ? params.targets : [entryPrice + dirSign * stopDist * 2];
  const fraction = 1 / targetPrices.length;

  const trade: Trade = {
    id: randomUUID(),
    asset,
    direction,
    archetype: "MANUAL" as any,
    regime: classifyRegime(asset, getCandles(asset, INTERVAL), Date.now()).label,
    entryPrice,
    entryTime: Date.now(),
    exitPrice: null,
    exitTime: null,
    initialQuantity: quantity,
    remainingQuantity: quantity,
    initialStopPrice: stopPrice,
    stopPrice,
    targets: targetPrices.map((price) => ({
      price,
      fraction,
      r: Math.abs(price - entryPrice) / stopDist,
      hit: false,
      hitTime: null,
    })),
    fills: [],
    status: "OPEN",
    realizedPnlUsd: 0,
    pnlUsd: null,
    pnlPct: null,
    rMultiple: null,
    reason: `Manual entry (${params.setupType ?? "MANUAL"})${params.notes ? ` — ${params.notes}` : ""}`,
    exitReason: null,
    rawScore: 0.5,
    calibratedWinProb: 0.5,
    calibratedWinProbCI90: [0.3, 0.7],
    calibrationStage: "A_UNCALIBRATED",
    evNetR: 0,
    evNetUsd: 0,
    costBreakdown: { feesR: 0, slippageR: 0, fundingR: 0, totalR: 0 },
    evidenceClusters: [],
    nEffectiveSignals: 0,
    conflict: 0,
    kellyFraction: 0,
    appliedFraction: 0,
    bindingConstraint: "MANUAL",
    haircuts: [],
    entryClusterStrengths: {},
    thesisDecay: 1,
    breakevenMoved: false,
    maxFavorableExcursionR: 0,
    maxAdverseExcursionR: 0,
    maxHoldHours: 48,
  };

  openTrade(asset, trade);
  return { ok: true, trade };
}

/** Open positions enriched with mark price and unrealised P&L. */
export function getOpenPositions() {
  return [...openTrades.values()].map((t) => {
    const mark = getLastPrice(t.asset) ?? t.entryPrice;
    const dirSign = t.direction === "LONG" ? 1 : -1;
    const unrealized = (mark - t.entryPrice) * dirSign * t.remainingQuantity;
    const notional = t.entryPrice * t.remainingQuantity;

    return {
      id: t.id,
      symbol: t.asset,
      side: t.direction,
      size: t.remainingQuantity,
      entry: t.entryPrice,
      mark,
      unrealized,
      pnlPct: notional > 0 ? (unrealized / notional) * 100 : 0,
      sl: t.stopPrice,
      tps: t.targets.filter((x) => !x.hit).map((x) => x.price),
      entryTime: t.entryTime,
      reason: t.reason,
      execution: t.execution ?? { venue: "SIMULATED", status: "SIMULATED" },
      rMultiple:
        Math.abs(t.entryPrice - t.initialStopPrice) > 0
          ? ((mark - t.entryPrice) * dirSign) / Math.abs(t.entryPrice - t.initialStopPrice)
          : 0,
    };
  });
}

/** Closes an open position at the current mark price. */
export function closeTradeManually(tradeId: string, reason = "MANUAL_CLOSE"): { ok: true; trade: Trade } | { ok: false; error: string } {
  const trade = openTrades.get(tradeId);
  if (!trade) return { ok: false, error: "No open trade with that id" };

  const price = getLastPrice(trade.asset);
  if (price === null) return { ok: false, error: "No live price available to close against" };

  finalizeClose(trade, price, reason, Date.now());
  openTrades.delete(trade.id);
  state.openPositions = openTrades.size;
  upsertTrade(trade);
  persistTradeClose(trade);
  return { ok: true, trade };
}

/**
 * Moves the stop on an open position. Rejects a stop on the wrong side of the
 * current price, which would otherwise close the trade the moment it is checked.
 */
export function updateTradeStop(
  tradeId: string,
  stopPrice: number
): { ok: true; trade: Trade } | { ok: false; error: string } {
  const trade = openTrades.get(tradeId);
  if (!trade) return { ok: false, error: "No open trade with that id" };
  if (!Number.isFinite(stopPrice) || stopPrice <= 0) {
    return { ok: false, error: "Stop price must be a positive number" };
  }

  const price = getLastPrice(trade.asset) ?? trade.entryPrice;
  if (trade.direction === "LONG" && stopPrice >= price) {
    return { ok: false, error: `Stop must be below the current price (${price})` };
  }
  if (trade.direction === "SHORT" && stopPrice <= price) {
    return { ok: false, error: `Stop must be above the current price (${price})` };
  }

  trade.stopPrice = stopPrice;
  upsertTrade(trade);
  broadcast("trade_updated", trade);
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

    // Mirror target fills to the exchange, one at a time and BEFORE any full close. Only real
    // target fills are partials: a stop/thesis/time exit is handled once, by the full close below.
    const targetFills = result.newFills.filter((f) => f.reason === "TARGET_HIT");
    const partials =
      targetFills.length > 0
        ? (async () => {
            const { mirrorPartialCloseToDelta } = await import("../services/execution.js");
            for (const fill of targetFills) {
              await mirrorPartialCloseToDelta(result.trade, fill.fraction, fill.price);
              upsertTrade(result.trade);
            }
          })().catch((error) => console.error("[engine] partial close mirror failed:", error))
        : undefined;

    if (result.closed) {
      openTrades.delete(trade.id);
      state.openPositions = openTrades.size;
      persistTradeClose(trade, partials);
    } else {
      // Keep the exchange stop in step with the engine's stop (breakeven / trailing).
      if (trade.execution?.bracket) void syncBrackets(result.trade);
    }
  }
}

function persistTradeClose(trade: Trade, after?: Promise<void>) {
  void (async () => {
    await after; // finish mirroring target fills before flattening what is left
    const { mirrorCloseToDelta } = await import("../services/execution.js");
    await mirrorCloseToDelta(trade, (updatedTrade) => {
      if (updatedTrade.execution?.closeFillPrice) {
        applyExchangeClose(updatedTrade, updatedTrade.execution.closeFillPrice, updatedTrade.execution.exchangeRealizedPnlUsd, updatedTrade.execution.closeFeeUsd ?? 0);
      }
      upsertTrade(updatedTrade);
      broadcast("trade_updated", updatedTrade);
    });
    upsertTrade(trade);
    broadcast("trade_updated", trade);
  })();

  state.equity += trade.realizedPnlUsd;
  persistEquity(trade.realizedPnlUsd);
  onTradeClosed(trade);
  broadcast("trade_closed", trade);
  broadcast("equity", { time: Date.now(), equity: state.equity });
}

/**
 * Reconcile positions that were closed directly on Delta or by another client.
 * The exchange is authoritative for live DELTA positions; MongoDB then becomes
 * the shared read model for both dashboards.
 */
export async function reconcileDeltaPositions() {
  if (reconciliationRunning || !deltaConfigured()) return;
  if (process.env.ENGINE_INSTANCE_ID !== (process.env.ENGINE_LEADER_ID ?? "domain")) return;
  reconciliationRunning = true;
  try {
    const { getDeltaPositions } = await import("../services/deltaExchange.js");
    const positions = await getDeltaPositions();
    const live = new Map<string, number>();
    for (const position of positions) {
      const symbol = String(position.product_symbol ?? position.symbol ?? "");
      const size = Math.abs(Number(position.size ?? position.position_size ?? 0));
      if (symbol && Number.isFinite(size) && size > 0) live.set(symbol, size);
    }

    for (const trade of [...openTrades.values()]) {
      if (trade.execution?.venue !== "DELTA" || trade.execution.status !== "FILLED") continue;
      const symbol = trade.asset.replace(/USDT$/, "USD");
      const exchangeSize = live.get(symbol) ?? 0;
      if (exchangeSize > 0) {
        // Still open on the exchange: make sure its stop is resting, and flatten it if it cannot be protected.
        await verifyBrackets(trade, exchangeSize);
        const bracket = trade.execution.bracket;
        const failsafeMs = Number(process.env.BRACKET_FAILSAFE_SEC ?? 60) * 1000;
        if (bracket?.status === "UNPROTECTED" && bracket.unprotectedSince && Date.now() - bracket.unprotectedSince > failsafeMs) {
          console.error(`[reconcile] ${trade.asset} has been without an exchange stop for over ${failsafeMs / 1000}s — closing it (fail-safe)`);
          closeTradeManually(trade.id, "PROTECTION_FAILSAFE");
        }
        continue;
      }

      // Gone from the exchange: a bracket stop or target closed it. Recover the real exit from the order fills.
      const exchangeExit = await findExchangeExit(trade);
      const mark = getLastPrice(trade.asset) ?? trade.entryPrice;
      finalizeClose(trade, exchangeExit?.price ?? mark, exchangeExit?.reason ?? "EXCHANGE_EXTERNAL_CLOSE", Date.now());
      trade.execution = { ...trade.execution, status: "CLOSED", closedAt: Date.now() };
      openTrades.delete(trade.id);
      state.openPositions = openTrades.size;
      upsertTrade(trade);
      onTradeClosed(trade);
      broadcast("trade_closed", trade);
      
      console.log(`[reconcile] marked ${trade.id} closed because Delta has no ${symbol} position`);
      try {
        const balance = await fetchDeltaBalance();
        state.equity = balance.equity;
        persistEquity(0);
        console.log(`[reconcile] synced true equity from Delta: $${balance.equity}`);
      } catch (e: any) {
        console.error("[reconcile] failed to sync equity after external close", e?.message ?? e);
      }
      broadcast("equity", { time: Date.now(), equity: state.equity });
    }
  } catch (error: any) {
    console.warn(`[reconcile] Delta position sync failed: ${error?.message ?? error}`);
  } finally {
    reconciliationRunning = false;
  }
}

let initialized = false;
const lastEvaluatedCandle = new Map<string, number>();
const lastMidCandleEval = new Map<string, number>();
const lastKnownAtr = new Map<string, number>();

export async function initEngine() {
  if (initialized) return;
  initialized = true;
  loadOpenTradesFromDb();

  if (deltaConfigured()) {
    try {
      const deltaBalance = await fetchDeltaBalance();
      console.log(`[engine] Delta equity: ${deltaBalance.equity}, available: ${deltaBalance.availableBalance}`);
      state.equity = deltaBalance.equity;
      state.startingEquity = deltaBalance.equity;
      // Rebase the drawdown references too. Carrying over a peak from the
      // simulated equity would read as a near-total drawdown against a smaller
      // real balance and trip the circuit breakers on startup.
      equityPeak = deltaBalance.equity;
      dayStartEquity = deltaBalance.equity;
      setKv("equityPeak", String(equityPeak));
      setKv("dayStartEquity", String(dayStartEquity));
      persistEquity(0);
    } catch (error: any) {
      console.warn(
        `[engine] Delta Exchange balance unavailable (${error?.message ?? error}) — using simulated equity $${state.equity}`
      );
    }
  } else {
    console.log(`[engine] Delta Exchange not configured — using simulated equity $${state.equity}`);
  }

  await startMarketData(ASSETS, [INTERVAL]);
  void reconcileDeltaPositions();
  setInterval(() => void reconcileDeltaPositions(), 10_000);
  onPrice((asset) => {
    const currentPrice = getLastPrice(asset);
    if (currentPrice === null || currentPrice <= 0) return;

    const candles = getCandles(asset, INTERVAL);
    if (candles.length > 0) {
      const lastClose = candles[candles.length - 1].close;
      // Outlier filter: ignore absurd 5% single-tick moves (API glitches)
      if (Math.abs(currentPrice - lastClose) / lastClose > 0.05) {
        console.warn(`[engine] Ignored absurd price tick for ${asset}: ${currentPrice}`);
        return;
      }
    }

    manageOpenTrades(asset);

    if (state.running) {
      maybeBroadcastHeartbeat(asset);
    }

    // Throttle CPU-heavy pipeline evaluation to candle close. Skipped while the
    // engine is stopped so a candle is never marked "evaluated" without a scan.
    if (candles.length > 1 && state.running) {
      const currentCandleTime = candles[candles.length - 1].time;
      if (lastEvaluatedCandle.get(asset) !== currentCandleTime) {
        lastEvaluatedCandle.set(asset, currentCandleTime);
        updateShadows(asset, candles);
        tryOpenPosition(asset);
      } else {
        // Mid-candle re-evaluation: if price moves > 1.5 ATR from the
        // current candle's open, a breakout or flush is happening NOW.
        // Re-run the pipeline to catch it instead of waiting 15 minutes.
        const currentCandle = candles[candles.length - 1];
        const candleAtr = lastKnownAtr.get(asset) ?? 0;
        if (candleAtr > 0) {
          const moveFromOpen = Math.abs(currentPrice - currentCandle.open);
          const lastMidEval = lastMidCandleEval.get(asset) ?? 0;
          const now = Date.now();
          // At most once per 60 seconds to avoid CPU thrashing
          if (moveFromOpen > candleAtr * 1.5 && now - lastMidEval > 60_000) {
            lastMidCandleEval.set(asset, now);
            tryOpenPosition(asset);
          }
        }
      }
    }

    broadcast("price", { asset, price: currentPrice, time: Date.now() });
  });
}

/**
 * The dev server restarts on every code change and used to boot with the engine stopped, so it
 * never scanned until Start was pressed again. Start on every boot unless AUTO_START_ENGINE=false.
 * (With LIVE_TRADING=true this also means orders go to Delta automatically after a restart.)
 */
export async function resumeEngineIfWasRunning(): Promise<boolean> {
  if (process.env.AUTO_START_ENGINE === "false") return false;
  const lease = await acquireEngineLease();
  if (!lease.ok) return false;
  startEngine();
  return true;
}

export function startEngine() {
  state.running = true;
  state.startedAt = Date.now();
  setKv("engineRunning", "true");
  setKv("engineStartedAt", String(state.startedAt));
  broadcast("engine_state", state);
}

/** Stops scanning for a process shutdown/restart but keeps the persisted "running" flag so the next boot resumes. */
export function pauseEngineForShutdown() {
  state.running = false;
  void releaseEngineLease().catch((error) => console.error("[engine] lease release failed:", error));
}

export function stopEngine() {
  state.running = false;
  state.startedAt = null;
  setKv("engineRunning", "false");
  setKv("engineStartedAt", "");
  void releaseEngineLease().catch((error) => console.error("[engine] lease release failed:", error));
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

export { getShadowSummary };

export function getRecentOpportunities() {
  return recentOpportunities;
}

/**
 * Current account balance and where it came from, so the UI can distinguish a
 * live Delta Exchange balance from the local simulated one.
 */
export async function getBalanceInfo(): Promise<{
  equity: number;
  walletBalance?: number;
  availableBalance?: number;
  unrealizedPnl?: number;
  positionMargin?: number;
  assetSymbol?: string;
  fetchedAt?: number;
  source: "delta_exchange" | "simulated";
  deltaConfigured: boolean;
  error?: string;
}> {
  if (!deltaConfigured()) {
    return { equity: state.equity, source: "simulated", deltaConfigured: false };
  }

  try {
    const balance = await fetchDeltaBalance();
    state.equity = balance.equity;
    return { ...balance, source: "delta_exchange", deltaConfigured: true };
  } catch (error: any) {
    return {
      equity: state.equity,
      source: "simulated",
      deltaConfigured: true,
      error: error?.message ?? String(error),
    };
  }
}

export { getEquityCurve };

// trigger reload
