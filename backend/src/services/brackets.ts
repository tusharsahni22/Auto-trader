/**
 * Exchange-side protection for live Delta positions.
 *
 * The lifecycle manager decides stops and targets locally, which means a crashed or
 * restarting backend leaves a real position with no stop. This module mirrors the
 * stop-loss and take-profit ladder onto Delta as reduce-only orders that trigger on the
 * mark price, and keeps them in step as the engine moves the stop (breakeven / trail)
 * or scales out. The engine remains the decision-maker; the exchange orders are the
 * safety net that keeps working when it is not.
 *
 * Disable with EXCHANGE_BRACKETS=false.
 */

import type { BracketState, Trade } from "../types.js";
import {
  assetToProductId,
  cancelDeltaOrder,
  getDeltaOpenOrders,
  getDeltaOrderHistory,
  placeDeltaStopOrder,
} from "./deltaExchange.js";

export function bracketsEnabled(): boolean {
  return process.env.EXCHANGE_BRACKETS !== "false";
}

const STOP_MOVE_MIN_FRACTION = 0.0005; // only re-send the stop when it moved by >= 0.05% of price
const STOP_SYNC_MIN_INTERVAL_MS = 15_000; // throttle trailing-stop updates
const TP_WAIT_POLLS = 5;
const TP_WAIT_INTERVAL_MS = 2_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const syncing = new Set<string>();

async function withRetry<T>(fn: () => Promise<T>, attempts = 3, delayMs = 500): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i < attempts - 1) await sleep(delayMs);
    }
  }
  throw lastError;
}

/**
 * Splits `total` contracts across targets by fraction using the largest-remainder method,
 * so the sizes always add up exactly (e.g. 10 contracts at 40/35/25% -> 4/4/2).
 * Targets that round to zero contracts get no order.
 */
export function allocateContracts(total: number, fractions: number[]): number[] {
  const raw = fractions.map((f) => total * f);
  const sizes = raw.map((r) => Math.floor(r));
  let leftover = total - sizes.reduce((a, b) => a + b, 0);
  const byRemainder = raw
    .map((r, i) => ({ i, rem: r - Math.floor(r) }))
    .sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (const { i } of byRemainder) {
    if (leftover <= 0) break;
    sizes[i] += 1;
    leftover -= 1;
  }
  return sizes;
}

function isLong(trade: Trade) {
  return trade.direction === "LONG";
}

/** Places the stop-loss and every take-profit for a freshly filled position. Never throws. */
export async function placeBrackets(trade: Trade): Promise<void> {
  const ex = trade.execution;
  if (!bracketsEnabled() || !ex || ex.venue !== "DELTA" || ex.status !== "FILLED") return;
  const contracts = ex.contracts ?? 0;
  if (contracts < 1) return;

  if (syncing.has(trade.id)) return;
  syncing.add(trade.id);
  try {
    await placeBracketsLocked(trade, contracts);
  } finally {
    syncing.delete(trade.id);
  }
}

async function placeBracketsLocked(trade: Trade, contracts: number): Promise<void> {
  const ex = trade.execution!;
  const sizes = allocateContracts(contracts, trade.targets.map((t) => t.fraction));
  ex.tpSizes = sizes;
  const bracket: BracketState = { status: "UNPROTECTED", tps: [], unprotectedSince: Date.now() };
  ex.bracket = bracket;

  // Stop-loss first: it is the one that matters.
  try {
    const order = await withRetry(() =>
      placeDeltaStopOrder({ asset: trade.asset, isLong: isLong(trade), size: contracts, triggerPrice: trade.stopPrice, kind: "stop_loss_order" })
    );
    bracket.slOrderId = order?.id != null ? String(order.id) : undefined;
    bracket.slPrice = trade.stopPrice;
    bracket.slSize = contracts;
    bracket.status = "PROTECTED";
    bracket.unprotectedSince = undefined;
  } catch (error: any) {
    bracket.error = `stop-loss order failed: ${error?.message ?? error}`;
    console.error(`[brackets] ${trade.asset} STOP-LOSS NOT PLACED — position unprotected: ${bracket.error}`);
  }

  for (let i = 0; i < trade.targets.length; i++) {
    const size = sizes[i];
    if (size < 1) continue;
    const target = trade.targets[i];
    const entry: BracketState["tps"][number] = { index: i, price: target.price, size };
    try {
      const order = await withRetry(() =>
        placeDeltaStopOrder({ asset: trade.asset, isLong: isLong(trade), size, triggerPrice: target.price, kind: "take_profit_order" })
      );
      entry.orderId = order?.id != null ? String(order.id) : undefined;
    } catch (error: any) {
      // A missing take-profit is not dangerous: the engine still closes at the target itself.
      console.warn(`[brackets] ${trade.asset} TP${i + 1} order not placed: ${error?.message ?? error}`);
    }
    bracket.tps.push(entry);
  }

  bracket.syncedAt = Date.now();
  if (bracket.status === "PROTECTED") {
    console.log(`[brackets] ${trade.asset} protected: SL ${trade.stopPrice} x${contracts}, TPs ${sizes.join("/")}`);
  }
}

/** Cancels any resting protective orders (call before the engine closes the position itself). */
export async function cancelBrackets(trade: Trade): Promise<void> {
  const ex = trade.execution;
  const b = ex?.bracket;
  if (!ex || !b || b.status === "OFF") return;
  try {
    const productId = await assetToProductId(trade.asset);
    const ids = [b.slOrderId, ...b.tps.filter((t) => !t.done).map((t) => t.orderId)].filter((id): id is string => !!id);
    for (const id of ids) {
      try {
        await cancelDeltaOrder(id, productId);
      } catch {
        /* already filled or cancelled */
      }
    }
  } finally {
    b.status = "OFF";
  }
}

/**
 * Keeps the exchange stop in step with the engine's stop: moves it when the stop tightens
 * (breakeven, trail) and resizes it after a partial close. Throttled and single-flight.
 */
export async function syncBrackets(trade: Trade, force = false): Promise<void> {
  const ex = trade.execution;
  const b = ex?.bracket;
  if (!bracketsEnabled() || !ex || !b || b.status === "OFF") return;
  const contracts = ex.contracts ?? 0;
  if (contracts < 1 || syncing.has(trade.id)) return;

  const moved = b.slPrice === undefined || Math.abs(trade.stopPrice - b.slPrice) >= trade.entryPrice * STOP_MOVE_MIN_FRACTION;
  const resized = b.slSize !== contracts;
  const needsPlacing = b.status === "UNPROTECTED" || !b.slOrderId;
  if (!moved && !resized && !needsPlacing) return;
  if (!force && !resized && !needsPlacing && Date.now() - (b.syncedAt ?? 0) < STOP_SYNC_MIN_INTERVAL_MS) return;

  syncing.add(trade.id);
  try {
    const productId = await assetToProductId(trade.asset);
    if (b.slOrderId) {
      try {
        await cancelDeltaOrder(b.slOrderId, productId);
      } catch {
        /* already gone */
      }
      b.slOrderId = undefined;
    }
    const order = await withRetry(() =>
      placeDeltaStopOrder({ asset: trade.asset, isLong: isLong(trade), size: contracts, triggerPrice: trade.stopPrice, kind: "stop_loss_order" })
    );
    b.slOrderId = order?.id != null ? String(order.id) : undefined;
    b.slPrice = trade.stopPrice;
    b.slSize = contracts;
    b.status = "PROTECTED";
    b.unprotectedSince = undefined;
    b.error = undefined;
    b.syncedAt = Date.now();
  } catch (error: any) {
    b.status = "UNPROTECTED";
    b.unprotectedSince ??= Date.now();
    b.error = `stop-loss update failed: ${error?.message ?? error}`;
    console.error(`[brackets] ${trade.asset} stop update failed — ${b.error}`);
  } finally {
    syncing.delete(trade.id);
  }
}

export interface TargetFillResult {
  /** EXCHANGE: the resting take-profit already filled. MANUAL: the caller must close `size` contracts itself. */
  mode: "EXCHANGE" | "MANUAL";
  size: number;
}

/**
 * The engine saw a target reached. If a take-profit order is resting on Delta it should be
 * filling itself right now, so wait for it rather than sending a second close.
 */
export async function handleTargetReached(trade: Trade, targetPrice: number): Promise<TargetFillResult> {
  const ex = trade.execution;
  const b = ex?.bracket;
  const contracts = ex?.contracts ?? 0;
  const tp = b?.tps.find((t) => !t.done && t.price === targetPrice);

  if (!ex || !tp) {
    // No exchange order for this target: close by the same fixed plan, not a fraction of what is left.
    const index = trade.targets.findIndex((t) => t.price === targetPrice);
    const planned = index >= 0 ? ex?.tpSizes?.[index] : undefined;
    const fallback = Math.max(1, Math.floor(contracts * (trade.targets[index]?.fraction ?? 0)));
    return { mode: "MANUAL", size: Math.min(contracts, planned ?? fallback) };
  }

  if (!tp.orderId) return { mode: "MANUAL", size: Math.min(contracts, tp.size) };

  try {
    const productId = await assetToProductId(trade.asset);
    for (let poll = 0; poll < TP_WAIT_POLLS; poll++) {
      const open = await getDeltaOpenOrders(productId);
      if (!open.some((o: any) => String(o.id) === tp.orderId)) {
        const history = await getDeltaOrderHistory({ productId, limit: 50 });
        const found = history.find((o: any) => String(o.id) === tp.orderId);
        if (found && (found.state === "filled" || found.status === "filled")) {
          tp.done = true;
          ex.contracts = Math.max(0, contracts - tp.size);
          return { mode: "EXCHANGE", size: tp.size };
        }
        break; // cancelled or unknown: fall through to a manual close
      }
      await sleep(TP_WAIT_INTERVAL_MS);
    }
    // Still resting after the wait (or gone without filling): cancel it and close by hand.
    try {
      await cancelDeltaOrder(tp.orderId, productId);
    } catch {
      /* already gone */
    }
  } catch (error: any) {
    console.warn(`[brackets] ${trade.asset} could not confirm TP fill: ${error?.message ?? error}`);
  }
  tp.done = true;
  return { mode: "MANUAL", size: Math.min(contracts, tp.size) };
}

/**
 * Reconciliation pass: makes sure a live position still has its stop resting on the exchange.
 * `exchangeSize` is the position size Delta reports right now.
 */
export async function verifyBrackets(trade: Trade, exchangeSize: number): Promise<void> {
  const ex = trade.execution;
  if (!bracketsEnabled() || !ex || ex.venue !== "DELTA" || ex.status !== "FILLED" || exchangeSize <= 0) return;

  if (!ex.bracket) {
    await placeBrackets(trade); // trades opened before this feature existed, or a failed first attempt
    return;
  }
  const b = ex.bracket;
  if (b.status === "OFF") return;
  if (b.status === "UNPROTECTED" || !b.slOrderId) {
    await syncBrackets(trade, true);
    return;
  }
  try {
    const productId = await assetToProductId(trade.asset);
    const open = await getDeltaOpenOrders(productId);
    if (!open.some((o: any) => String(o.id) === b.slOrderId)) {
      console.warn(`[brackets] ${trade.asset} stop order ${b.slOrderId} is no longer resting but the position is open — re-placing`);
      b.slOrderId = undefined;
      await syncBrackets(trade, true);
    }
  } catch (error: any) {
    console.warn(`[brackets] ${trade.asset} verify failed: ${error?.message ?? error}`);
  }
}

/**
 * When Delta reports the position gone, work out how it closed from the protective orders
 * so the local record gets the real exit price and reason instead of a guess.
 */
export async function findExchangeExit(trade: Trade): Promise<{ price: number; reason: "STOP_HIT" | "TARGET_HIT" } | null> {
  const b = trade.execution?.bracket;
  if (!b) return null;
  try {
    const productId = await assetToProductId(trade.asset);
    const history = await getDeltaOrderHistory({ productId, limit: 50 });
    const filled = (id?: string) => history.find((o: any) => id && String(o.id) === id && (o.state === "filled" || o.status === "filled"));
    const sl = filled(b.slOrderId);
    if (sl?.average_fill_price) return { price: Number(sl.average_fill_price), reason: "STOP_HIT" };
    const withOrders = b.tps.filter((t) => t.orderId);
    const lastTp = withOrders[withOrders.length - 1];
    const tp = filled(lastTp?.orderId);
    if (tp?.average_fill_price) return { price: Number(tp.average_fill_price), reason: "TARGET_HIT" };
  } catch {
    /* fall back to the mark price */
  }
  return null;
}
