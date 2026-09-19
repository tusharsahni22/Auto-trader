import type { CostBreakdown } from "../decision/types.js";

/** docs/02 §5 — fees, slippage and funding, converted to fractions of R. */

const TAKER_FEE = 0.0005; // 0.05%
const MAKER_FEE = 0.0002; // 0.02%
// The execution engine currently uses 100% MARKET orders. EV math must reflect 100% taker fees.
const ENTRY_FEE = TAKER_FEE;
const EXIT_FEE_WIN = TAKER_FEE;
const EXIT_FEE_STOP = TAKER_FEE;

const BASE_SLIPPAGE_BPS = 2; // §5.2 fallback — normal-conditions retail size on BTC/ETH perps
const STOP_SLIPPAGE_MULTIPLIER = 2; // §5.2 — stops fill when the book is thinnest

export function estimateCosts(
  stopDistancePct: number,
  expectedHoldHours: number,
  fundingRatePer8h: number,
  direction: "LONG" | "SHORT"
): CostBreakdown {
  const feesPct = ENTRY_FEE + (EXIT_FEE_WIN + EXIT_FEE_STOP) / 2; // blend win/stop exit fee
  const slippagePct = (BASE_SLIPPAGE_BPS / 10000) * (1 + (STOP_SLIPPAGE_MULTIPLIER - 1) * 0.5);

  // docs/02 §5.3 — funding settles at fixed 8h marks; approximate the number of
  // settlements crossed by the expected hold rather than treating it as continuous.
  const settlementsCrossed = Math.max(1, Math.ceil(expectedHoldHours / 8));
  const directionSign = direction === "LONG" ? 1 : -1;
  const fundingPct = Math.abs(fundingRatePer8h * settlementsCrossed * directionSign);

  const feesR = feesPct / stopDistancePct;
  const slippageR = slippagePct / stopDistancePct;
  const fundingR = fundingPct / stopDistancePct;

  return { feesR, slippageR, fundingR, totalR: feesR + slippageR + fundingR };
}
