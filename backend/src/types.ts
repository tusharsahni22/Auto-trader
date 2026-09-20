import type { Archetype, Cluster, CostBreakdown, Regime } from "./decision/types.js";

export type Asset = "BTCUSDT" | "ETHUSDT";
export type Direction = "LONG" | "SHORT";
export type TradeStatus = "OPEN" | "CLOSED";

export interface Candle {
  time: number; // seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TargetLevel {
  price: number;
  fraction: number; // of the initial quantity
  r: number;
  hit: boolean;
  hitTime: number | null;
}

export interface TradeFill {
  time: number;
  price: number;
  fraction: number;
  reason: string;
  pnlUsd: number;
}

export interface Trade {
  id: string;
  asset: Asset;
  direction: Direction;
  archetype: Archetype;
  regime: Regime;

  entryPrice: number;
  entryTime: number;
  exitPrice: number | null; // quantity-weighted average of all fills once fully closed
  exitTime: number | null;

  initialQuantity: number;
  remainingQuantity: number;
  initialStopPrice: number;
  stopPrice: number; // moves forward only (breakeven, then trailing)
  targets: TargetLevel[];
  fills: TradeFill[];

  status: TradeStatus;
  realizedPnlUsd: number; // cumulative across partial + final fills
  pnlUsd: number | null; // == realizedPnlUsd once CLOSED, else null
  pnlPct: number | null;
  rMultiple: number | null;
  reason: string;
  exitReason: string | null;

  rawScore: number;
  calibratedWinProb: number;
  calibratedWinProbCI90: [number, number];
  calibrationStage: string;
  evNetR: number;
  evNetUsd: number;
  costBreakdown: CostBreakdown;
  evidenceClusters: string[];
  nEffectiveSignals: number;
  conflict: number;
  kellyFraction: number;
  appliedFraction: number;
  bindingConstraint: string;
  haircuts: string[];

  entryClusterStrengths: Record<string, number>;
  thesisDecay: number;
  breakevenMoved: boolean;
  maxFavorableExcursionR: number;
  maxAdverseExcursionR: number;
  maxHoldHours: number;

  /** How and whether this trade reached a real exchange. */
  execution?: TradeExecution;
}

export type ExecutionStatus =
  | "SIMULATED"
  | "PENDING"
  | "FILLED"
  | "REJECTED"
  | "FAILED"
  | "CLOSED"
  | "CLOSE_FAILED";

export interface TradeExecution {
  venue: "SIMULATED" | "DELTA";
  status: ExecutionStatus;
  orderId?: string;
  closeOrderId?: string;
  closeFillPrice?: number;
  entryFeeUsd?: number;
  closeFeeUsd?: number;
  exchangeRealizedPnlUsd?: number;
  contracts?: number;
  avgFillPrice?: number;
  /** Price the local feed expected, before reconciling to the exchange fill. */
  requestedPrice?: number;
  /** avgFillPrice - requestedPrice; the whole setup was shifted by this. */
  priceShift?: number;
  placedAt?: number;
  closedAt?: number;
  error?: string;
  /** Number of automatic exchange retry attempts already made. */
  retryCount?: number;
  retryAt?: number;
  /** Current mark-to-stop exposure in USD, calculated before a retry. */
  currentRiskUsd?: number;
}

export interface VetoedOpportunity {
  id: string;
  time: number;
  asset: Asset;
  direction: Direction;
  archetype: Archetype;
  regime: Regime;
  vetoReasons: string[];
  /** Plain-language explanation per veto reason (same order as vetoReasons). */
  vetoDetails?: string[];
  /** Why the setup was detected/tracked (the detector's structural rationale). */
  setupReason?: string;
  entryPrice?: number;
  stopPrice?: number;
  calibratedWinProb: number;
  evNetR: number;
  costR?: number;
}

export interface EngineState {
  running: boolean;
  startedAt: number | null;
  equity: number;
  startingEquity: number;
  openPositions: number;
}

export interface PnlPoint {
  time: number;
  equity: number;
  realizedPnl: number;
}

export type { Archetype, Cluster, Regime };
