import type { Asset, Candle, Direction, EngineState, Opportunity, PnlPoint, RegimeSnapshot, ScanInfo, Trade } from "./types";

export type BotSignal = "BUY" | "SELL" | "HOLD";

export interface IndicatorSnapshot {
  price: number;
  emaFast: number | null;
  emaSlow: number | null;
  rsi: number | null;
  breakoutHigh: number | null;
  breakoutLow: number | null;
  trend: "UP" | "DOWN" | "FLAT";
}

export interface BotDecision {
  id: string;
  asset: Asset;
  time: number;
  signal: BotSignal;
  confidence: number;
  reasons: string[];
  indicators: IndicatorSnapshot;
  executed: boolean;
  executionError?: string;
  tradeId?: string;
}

export interface BotStrategyConfig {
  emaFastPeriod: number;
  emaSlowPeriod: number;
  rsiPeriod: number;
  rsiOverbought: number;
  rsiOversold: number;
  breakoutLookback: number;
}

export interface BotConfig {
  intervalMs: number;
  autoExecute: boolean;
  riskPerTrade: number;
  stopLossPct: number;
  takeProfitPct: number;
  strategy: BotStrategyConfig;
}

export interface BotState {
  running: boolean;
  startedAt: number | null;
  lastRunAt: number | null;
  nextRunAt: number | null;
  runCount: number;
  config: BotConfig;
}

export interface BotStats {
  totalDecisions: number;
  counts: Record<BotSignal, number>;
  executed: number;
  avgConfidence: number;
  lastRunAt: number | null;
  running: boolean;
}

export interface AssetIndicators {
  asset: Asset;
  signal: BotSignal;
  indicators: IndicatorSnapshot | null;
}

export interface Position {
  id: string;
  symbol: Asset;
  side: "LONG" | "SHORT";
  size: number;
  entry: number;
  mark: number;
  unrealized: number;
  pnlPct: number;
  sl: number;
  tps: number[];
  entryTime: number;
  reason: string;
  rMultiple: number;
  execution?: {
    venue: "SIMULATED" | "DELTA";
    status: string;
    orderId?: string;
    contracts?: number;
    avgFillPrice?: number;
    requestedPrice?: number;
    priceShift?: number;
    error?: string;
  };
}

export interface NewsBlackout {
  active: boolean;
  minutes: number;
  event?: { title: string; eventTime: string; minutesAway: number };
}

export interface TradeStats {
  total: number;
  open: number;
  closed: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnlUsd: number;
  avgRMultiple: number;
  profitFactor: number | null;
}

export interface BalanceInfo {
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
}

export interface EngineRole {
  instanceId: string;
  leaderId: string;
  isLeader: boolean;
  mongoConnected: boolean;
}

async function mutate<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok || (body as any).ok === false) {
    throw new Error((body as any).error ?? `${res.status} ${res.statusText}`);
  }
  return body as T;
}

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => null) as { error?: string } | null;
  if (!res.ok) throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  return body as T;
}

export const api = {
  status: () =>
    fetch("/api/status").then((r) => json<{ engine: EngineState; role?: EngineRole; assets: Asset[]; interval: string; scans: ScanInfo[] }>(r)),
  startEngine: () => fetch("/api/engine/start", { method: "POST" }).then((r) => json<{ ok: boolean }>(r)),
  stopEngine: () => fetch("/api/engine/stop", { method: "POST" }).then((r) => json<{ ok: boolean }>(r)),
  candles: (asset: Asset) => fetch(`/api/candles/${asset}`).then((r) => json<Candle[]>(r)),
  trades: (params: Record<string, string> = {}) => {
    const qs = new URLSearchParams(params).toString();
    return fetch(`/api/trades${qs ? `?${qs}` : ""}`).then((r) => json<Trade[]>(r));
  },
  equityCurve: () => fetch("/api/equity-curve").then((r) => json<PnlPoint[]>(r)),
  balance: () => fetch("/api/balance").then((r) => json<BalanceInfo>(r)),
  positions: () =>
    fetch("/api/positions").then((r) => json<{ positions: Position[]; totalUnrealized: number }>(r)),
  closePosition: (id: string) =>
    fetch("/api/positions/" + id + "/close", { method: "POST" }).then((r) => mutate<{ ok: boolean }>(r)),
  updateStop: (id: string, stopPrice: number) =>
    fetch("/api/positions/" + id + "/stop", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stopPrice }),
    }).then((r) => mutate<{ ok: boolean }>(r)),
  newsBlackout: () => fetch("/api/news-calendar/blackout").then((r) => json<NewsBlackout>(r)),
  marketCandles: (asset: Asset, resolution: string, limit = 500) =>
    fetch("/api/market/candles/" + asset + "?resolution=" + resolution + "&limit=" + limit).then((r) =>
      json<{ asset: Asset; resolution: string; source: string; warning?: string; candles: Candle[] }>(r)
    ),
  marketTicker: () => fetch("/api/market/ticker").then((r) => json<{ tickers: any[] }>(r)),
  tradeStats: () => fetch("/api/trades/stats").then((r) => json<TradeStats>(r)),
  botStatus: () => fetch("/api/bot/status").then((r) => json<{ bot: BotState; stats: BotStats }>(r)),
  botStart: () => fetch("/api/bot/start", { method: "POST" }).then((r) => json<{ bot: BotState }>(r)),
  botStop: () => fetch("/api/bot/stop", { method: "POST" }).then((r) => json<{ bot: BotState }>(r)),
  botRunNow: () => fetch("/api/bot/run-now", { method: "POST" }).then((r) => json<{ decisions: BotDecision[] }>(r)),
  botDecisions: (limit = 50) =>
    fetch("/api/bot/decisions?limit=" + limit).then((r) => json<{ decisions: BotDecision[] }>(r)),
  botIndicators: () => fetch("/api/bot/indicators").then((r) => json<{ indicators: AssetIndicators[] }>(r)),
  botConfig: (patch: Partial<BotConfig>) =>
    fetch("/api/bot/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => json<{ config: BotConfig }>(r)),
  opportunities: () => fetch("/api/opportunities").then((r) => json<Opportunity[]>(r)),
  regime: (asset: Asset) =>
    fetch(`/api/regime/${asset}`).then((r) => json<{ asset: Asset; regime: RegimeSnapshot; fundingRate: number }>(r)),
  forceTrade: (asset: Asset, direction: Direction) =>
    fetch("/api/engine/force-trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ asset, direction }),
    }).then(async (r) => {
      const body = (await r.json()) as { ok: boolean; trade?: Trade; error?: string };
      if (!r.ok || !body.ok) throw new Error(body.error ?? `${r.status} ${r.statusText}`);
      return body.trade!;
    }),
};
