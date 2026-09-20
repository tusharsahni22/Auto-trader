export type Asset = "BTCUSDT" | "ETHUSDT";
export type Direction = "LONG" | "SHORT";
export type TradeStatus = "OPEN" | "CLOSED";
export type Archetype = "COMPRESSION_BREAKOUT" | "LIQUIDATION_REVERSAL" | "TREND_CONTINUATION";
export type Regime =
  | "TRENDING_UP"
  | "TRENDING_DOWN"
  | "RANGE_BOUND"
  | "LOW_VOL_COMPRESSION"
  | "HIGH_VOL_EXPANSION"
  | "POST_CAPITULATION";

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TargetLevel {
  price: number;
  fraction: number;
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

export interface CostBreakdown {
  feesR: number;
  slippageR: number;
  fundingR: number;
  totalR: number;
}

export interface Trade {
  id: string;
  asset: Asset;
  direction: Direction;
  archetype: Archetype;
  regime: Regime;

  entryPrice: number;
  entryTime: number;
  exitPrice: number | null;
  exitTime: number | null;

  initialQuantity: number;
  remainingQuantity: number;
  initialStopPrice: number;
  stopPrice: number;
  targets: TargetLevel[];
  fills: TradeFill[];

  status: TradeStatus;
  realizedPnlUsd: number;
  pnlUsd: number | null;
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

  thesisDecay: number;
  breakevenMoved: boolean;
  maxFavorableExcursionR: number;
  maxAdverseExcursionR: number;
  maxHoldHours: number;
}

export interface Opportunity {
  id: string;
  time: number;
  asset: Asset;
  direction: Direction;
  archetype: Archetype;
  regime: Regime;
  vetoReasons: string[];
  vetoDetails?: string[];
  setupReason?: string;
  entryPrice?: number;
  stopPrice?: number;
  costR?: number;
  calibratedWinProb: number;
  evNetR: number;
  decision: "OPEN" | "WATCH" | "VETO" | "NONE";
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

export interface RegimeSnapshot {
  label: Regime;
  posterior: Record<Regime, number>;
  confidence: number;
  hoursInRegime: number;
}

export interface ScanInfo {
  asset: Asset;
  time: number;
  regime: Regime;
  regimeConfidence: number;
  hasCandidate: boolean;
}
