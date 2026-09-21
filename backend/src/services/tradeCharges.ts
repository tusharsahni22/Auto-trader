/**
 * Attaches the Delta India charge/tax breakdown to a trade.
 *
 * Kept apart from the decision pipeline on purpose. `realizedPnlUsd` stays the
 * gross number the calibration and learning code has always consumed, so none of
 * its history shifts underneath it; the net-of-cost figures live in `charges` and
 * are what the dashboard and the tax screens show.
 */

import type { Trade } from "../types.js";
import { computeTradeCharges, type TradeCharges } from "./charges.js";

/**
 * Entries rest as limit orders at the mark, so they usually earn the maker rate.
 * Stops, targets and manual closes cross the book and pay taker. A close that the
 * exchange reported a commission for uses that number instead of either rate.
 */
function exitLiquidity(trade: Trade): "taker" | "maker" {
  return trade.exitReason === "TARGET_HIT" ? "taker" : "taker";
}

export function chargesFor(trade: Trade, markPrice?: number): TradeCharges {
  // An open trade is valued at the live mark so the estimate moves with the position.
  const exitPrice = trade.status === "CLOSED" ? trade.exitPrice : (markPrice ?? trade.entryPrice);
  const grossPnl =
    trade.status === "CLOSED"
      ? trade.realizedPnlUsd
      : trade.realizedPnlUsd +
        (markPrice === undefined
          ? 0
          : (markPrice - trade.entryPrice) * (trade.direction === "LONG" ? 1 : -1) * trade.remainingQuantity);

  return computeTradeCharges({
    entryPrice: trade.entryPrice,
    exitPrice,
    quantity: trade.initialQuantity,
    grossPnlUsd: grossPnl,
    entryLiquidity: "maker",
    exitLiquidity: exitLiquidity(trade),
    exchangeEntryFeeUsd: trade.execution?.entryFeeUsd,
    exchangeExitFeeUsd: trade.execution?.closeFeeUsd,
  });
}

/** Computes and stores the breakdown on the trade. Returns it for convenience. */
export function attachCharges(trade: Trade, markPrice?: number): TradeCharges {
  const charges = chargesFor(trade, markPrice);
  trade.charges = charges;
  return charges;
}

/**
 * A read-only copy carrying fresh charges, for API responses. Open trades get an
 * estimate against the current mark without that estimate being persisted, which
 * would otherwise rewrite the ledger on every poll.
 */
export function withCharges(trade: Trade, markPrice?: number): Trade {
  return { ...trade, charges: chargesFor(trade, markPrice) };
}
