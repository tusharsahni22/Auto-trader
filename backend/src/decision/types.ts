/**
 * Type names follow docs/09-contracts.md §2 so the code and the spec stay
 * readable side by side. Where this MVP simplifies the spec, the comment
 * says so — see the module doing the simplifying for detail.
 */

export type Regime =
  | "TRENDING_UP"
  | "TRENDING_DOWN"
  | "RANGE_BOUND"
  | "LOW_VOL_COMPRESSION"
  | "HIGH_VOL_EXPANSION"
  | "POST_CAPITULATION";

export type Archetype = "COMPRESSION_BREAKOUT" | "LIQUIDATION_REVERSAL" | "TREND_CONTINUATION";

export type Cluster =
  | "PRICE_STRUCTURE"
  | "VOLATILITY"
  | "FLOW"
  | "POSITIONING"
  | "LIQUIDATION"
  | "ORDERBOOK"
  | "ONCHAIN"
  | "NEWS"
  | "MACRO"
  | "EVENT";

export type Stance = "BULLISH" | "BEARISH" | "NEUTRAL";

export interface RegimeSnapshot {
  label: Regime;
  posterior: Record<Regime, number>;
  confidence: number;
  hoursInRegime: number;
}

export interface FeatureSnapshot {
  asset: string;
  time: number;
  values: Record<string, number>;
  dataConfidence: number;
  regime: RegimeSnapshot;
}

export interface Claim {
  text: string;
  stance: Stance;
  strength: number; // -1..1
  featureIds: string[];
  observedValues: Record<string, number>;
  agent: string;
  cluster: Cluster;
  verified: boolean;
}

export interface DroppedClaim {
  claim: Claim;
  reason: "CITATION_MISMATCH" | "MISSING_FEATURE";
  claimedValue?: number;
  actualValue?: number;
}

export interface ClusterContribution {
  cluster: Cluster;
  effectiveStrength: number; // signed
  claimCount: number;
  weight: number;
  logOddsContribution: number;
}

export interface EvidenceGraph {
  admitted: Claim[];
  dropped: DroppedClaim[];
  clusters: ClusterContribution[];
  nEffectiveSignals: number;
  conflict: number;
}

export interface ArchetypeCandidate {
  archetype: Archetype;
  direction: "LONG" | "SHORT";
  asset: string;
  entryPrice: number;
  stopPrice: number;
  targets: { price: number; fraction: number; r: number }[];
  maxHoldHours: number;
  structuralReason: string;
  atr: number;
}

export interface CalibrationResult {
  stage: "A_UNCALIBRATED" | "B_COLD_START" | "C_PLATT";
  rawScore: number;
  calibratedWinProb: number;
  calibratedWinProbCI90: [number, number];
  n: number;
  wins: number;
}

export interface CostBreakdown {
  feesR: number;
  slippageR: number;
  fundingR: number;
  totalR: number;
}

export interface ExpectedValue {
  grossR: number;
  costR: number;
  netR: number;
  netUSD: number;
  pProfit: number;
  breakevenP: number;
  distributionR: { p5: number; p25: number; p50: number; p75: number; p95: number };
  cvar5R: number;
  expectedHoldHours: number;
  costBreakdown: CostBreakdown;
}

export interface Sizing {
  kellyFraction: number;
  appliedFraction: number;
  riskPctOfEquity: number;
  notionalUSD: number;
  quantity: number;
  bindingConstraint: string;
  haircuts: string[];
}

export type OpportunityState = "VETOED" | "WATCH" | "ARMED" | "OPEN";

export interface Opportunity {
  id: string;
  asset: string;
  direction: "LONG" | "SHORT";
  archetype: Archetype;
  regime: RegimeSnapshot;
  candidate: ArchetypeCandidate;
  evidence: EvidenceGraph;
  calibration: CalibrationResult;
  ev: ExpectedValue;
  sizing: Sizing;
  vetoReasons: string[];
  state: OpportunityState;
  createdAt: number;
}

export const CLUSTER_WEIGHTS: Record<Cluster, number> = {
  POSITIONING: 0.18,
  PRICE_STRUCTURE: 0.16,
  FLOW: 0.15,
  LIQUIDATION: 0.12,
  VOLATILITY: 0.1,
  ORDERBOOK: 0.09,
  ONCHAIN: 0.08,
  NEWS: 0.06,
  MACRO: 0.04,
  EVENT: 0.02,
};

/** docs/01 §3.2 — the archetype x regime expectancy matrix. Priors only until the ledger overrides them. */
export const ARCHETYPE_REGIME_MATRIX: Record<Archetype, Partial<Record<Regime, "PRIMARY" | "OK" | "VETO">>> = {
  COMPRESSION_BREAKOUT: {
    TRENDING_UP: "OK",
    TRENDING_DOWN: "OK",
    RANGE_BOUND: "OK",
    LOW_VOL_COMPRESSION: "PRIMARY",
    HIGH_VOL_EXPANSION: "VETO",
    POST_CAPITULATION: "VETO",
  },
  LIQUIDATION_REVERSAL: {
    TRENDING_UP: "VETO",
    TRENDING_DOWN: "VETO",
    RANGE_BOUND: "OK",
    LOW_VOL_COMPRESSION: "VETO",
    HIGH_VOL_EXPANSION: "PRIMARY",
    POST_CAPITULATION: "PRIMARY",
  },
  TREND_CONTINUATION: {
    TRENDING_UP: "PRIMARY",
    TRENDING_DOWN: "PRIMARY",
    RANGE_BOUND: "VETO",
    LOW_VOL_COMPRESSION: "VETO",
    HIGH_VOL_EXPANSION: "OK",
    POST_CAPITULATION: "VETO",
  },
};

export const ALL_REGIMES: Regime[] = [
  "TRENDING_UP",
  "TRENDING_DOWN",
  "RANGE_BOUND",
  "LOW_VOL_COMPRESSION",
  "HIGH_VOL_EXPANSION",
  "POST_CAPITULATION",
];
