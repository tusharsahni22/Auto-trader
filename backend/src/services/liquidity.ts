import { assetToDeltaSymbol, getDeltaOrderBook, getDeltaProduct } from "./deltaExchange.js";

/**
 * Pre-trade liquidity gate. A wide spread means the entry itself is a loss, and a thin book
 * means the position cannot be closed near the mark. Both are checked against Delta's live
 * order book before any capital is committed.
 *
 * LIQUIDITY_GATE = enforce (default) | shadow (log only) | off
 * MAX_ENTRY_SPREAD_PCT (default 0.15)   MAX_EXIT_SLIPPAGE_PCT (default 0.4)
 */

export interface LiquidityCheck {
  ok: boolean;
  /** Human-readable result, shown in the opportunity feed. */
  detail: string;
}

type Level = { price: string; size: number };

/** Volume-weighted fill price for `contracts` walked through the book, and how many could be filled. */
function walkBook(levels: Level[], contracts: number): { price: number; filled: number } {
  let remaining = contracts;
  let cost = 0;
  let filled = 0;
  for (const level of levels) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, Number(level.size));
    cost += take * Number(level.price);
    filled += take;
    remaining -= take;
  }
  return { price: filled > 0 ? cost / filled : 0, filled };
}

export function liquidityGateMode(): "enforce" | "shadow" | "off" {
  const mode = (process.env.LIQUIDITY_GATE ?? "enforce").toLowerCase();
  return mode === "shadow" || mode === "off" ? mode : "enforce";
}

export async function checkEntryLiquidity(asset: string, direction: "LONG" | "SHORT", quantityCoin: number): Promise<LiquidityCheck> {
  if (liquidityGateMode() === "off") return { ok: true, detail: "liquidity gate off" };

  const maxSpreadPct = Number(process.env.MAX_ENTRY_SPREAD_PCT ?? 0.15);
  const maxExitSlipPct = Number(process.env.MAX_EXIT_SLIPPAGE_PCT ?? 0.4);

  let book;
  let contractValue: number;
  try {
    book = await getDeltaOrderBook(assetToDeltaSymbol(asset));
    contractValue = Number((await getDeltaProduct(asset)).contract_value);
  } catch (error: any) {
    // Never block trading just because the book could not be read.
    return { ok: true, detail: `order book unavailable (${error?.message ?? error}) — gate skipped` };
  }

  if (!book.buy.length || !book.sell.length) return { ok: false, detail: "order book is empty" };

  const bid = Number(book.buy[0].price);
  const ask = Number(book.sell[0].price);
  const mid = (bid + ask) / 2;
  const spreadPct = ((ask - bid) / mid) * 100;
  if (spreadPct > maxSpreadPct) {
    return { ok: false, detail: `spread ${spreadPct.toFixed(3)}% is wider than the ${maxSpreadPct}% limit — the entry alone would cost too much` };
  }

  const contracts = Math.max(1, Math.floor(quantityCoin / contractValue));
  // Exiting a long sells into the bids; exiting a short buys from the asks.
  const exitSide = direction === "LONG" ? book.buy : book.sell;
  const walk = walkBook(exitSide, contracts);
  if (walk.filled < contracts) {
    return { ok: false, detail: `book too thin to exit ${contracts} contracts (only ${walk.filled} available in the top levels)` };
  }
  const exitSlipPct = (Math.abs(walk.price - mid) / mid) * 100;
  if (exitSlipPct > maxExitSlipPct) {
    return { ok: false, detail: `closing ${contracts} contracts would cost ${exitSlipPct.toFixed(3)}% (limit ${maxExitSlipPct}%)` };
  }

  return { ok: true, detail: `spread ${spreadPct.toFixed(3)}%, exit slippage ${exitSlipPct.toFixed(3)}% for ${contracts} contracts` };
}
