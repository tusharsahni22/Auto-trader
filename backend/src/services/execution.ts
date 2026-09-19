/**
 * Exchange execution layer.
 *
 * Mirrors locally-opened trades onto Delta Exchange as real orders. Every trade
 * still exists locally first — the local record is what the lifecycle manager,
 * stops and targets act on — and the exchange order is placed alongside it so
 * the book matches what the dashboard shows.
 *
 * Gated by LIVE_TRADING. When it is off nothing is sent and trades are marked
 * SIMULATED, so the UI can always say which of the two a position really is.
 */

import type { Trade } from "../types.js";
import { getLastPrice } from "../marketData.js";
import {
  closeDeltaPosition,
  executeDeltaTrade,
  getDeltaProduct,
  isDeltaExchangeEnabled,
} from "./deltaExchange.js";

export function isLiveTradingEnabled(): boolean {
  return process.env.LIVE_TRADING === "true" && isDeltaExchangeEnabled();
}

const RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000];
const configuredRetries = Number(process.env.DELTA_EXECUTION_MAX_RETRIES ?? RETRY_DELAYS_MS.length);
const MAX_RETRIES = Number.isFinite(configuredRetries)
  ? Math.max(0, Math.min(Math.floor(configuredRetries), RETRY_DELAYS_MS.length))
  : RETRY_DELAYS_MS.length;

type ExecutionUpdate = (trade: Trade) => void;

function currentRiskUsd(trade: Trade, mark: number): number {
  return Math.abs(mark - trade.stopPrice) * trade.remainingQuantity;
}

function retryDelay(retryCount: number): number | null {
  if (retryCount >= Math.min(MAX_RETRIES, RETRY_DELAYS_MS.length)) return null;
  return RETRY_DELAYS_MS[retryCount];
}

/**
 * Delta perpetuals trade in whole contracts, each worth `contract_value` of the
 * base asset. A local quantity expressed in coin has to be converted and
 * rounded — and a position under one contract simply cannot be represented.
 */
export async function toContracts(
  asset: string,
  quantity: number
): Promise<{ contracts: number; contractValue: number }> {
  const product = await getDeltaProduct(asset);
  const contractValue = Number(product.contract_value);
  // Always round down (floor) to avoid taking larger positions than Kelly sizing dictates
  return { contracts: Math.floor(quantity / contractValue), contractValue };
}

/**
 * Places the opening order. Mutates the trade with the outcome so the record
 * carries its own execution status rather than it living in a side channel.
 */
export async function mirrorOpenToDelta(trade: Trade, onUpdate: ExecutionUpdate = () => {}): Promise<void> {
  if (!isLiveTradingEnabled()) {
    trade.execution = { venue: "SIMULATED", status: "SIMULATED" };
    return;
  }

  trade.execution = { venue: "DELTA", status: "PENDING", retryCount: 0 };
  onUpdate(trade);

  await tryMirrorOpen(trade, onUpdate);
}

async function tryMirrorOpen(trade: Trade, onUpdate: ExecutionUpdate): Promise<void> {
  if (trade.status !== "OPEN") return;

  try {
    const mark = getLastPrice(trade.asset) ?? trade.entryPrice;
    const stopCrossed = trade.direction === "LONG" ? mark <= trade.stopPrice : mark >= trade.stopPrice;
    
    const stopDist = Math.abs(trade.entryPrice - trade.stopPrice);
    const slippage = trade.direction === "LONG" ? mark - trade.entryPrice : trade.entryPrice - mark;
    const slippedTooFar = slippage > (stopDist * 0.25);
    
    if (stopCrossed || slippedTooFar) {
      const reason = stopCrossed ? `crossed the stop ${trade.stopPrice}` : "slipped too far from entry";
      trade.execution = {
        ...trade.execution, venue: trade.execution?.venue ?? "SIMULATED",
        status: "REJECTED",
        error: `Retry cancelled: current price ${mark} has ${reason}`,
        currentRiskUsd: currentRiskUsd(trade, mark),
      };
      onUpdate(trade);
      return;
    }

    // The market order has no limit price. This records the latest price used
    // for risk reporting; entry/targets are shifted only after a real fill.
    trade.execution = {
      ...trade.execution, venue: trade.execution?.venue ?? "SIMULATED",
      status: "PENDING",
      requestedPrice: mark,
      retryAt: undefined,
      currentRiskUsd: currentRiskUsd(trade, mark),
    };
    onUpdate(trade);
    const { contracts, contractValue } = await toContracts(trade.asset, trade.initialQuantity);

    if (contracts < 1) {
      trade.execution = {
        venue: "DELTA",
        status: "REJECTED",
        error: `Size ${trade.initialQuantity} ${trade.asset} is under one contract (${contractValue})`,
      };
      onUpdate(trade);
      return;
    }

    const order = await executeDeltaTrade({
      asset: trade.asset,
      direction: trade.direction,
      size: contracts,
      orderType: "LIMIT",
      limitPrice: mark,
    });

    const orderId: string | undefined = order?.id != null ? String(order.id) : undefined;

    // FIX: Limit order fill confirmation with timeout + auto-cancel.
    // Without this, an unfilled limit order causes the engine to attempt to
    // "close" a position that was never opened, which creates a reverse position.
    const FILL_POLL_INTERVAL_MS = 10_000;  // check every 10s
    const FILL_TIMEOUT_MS = Number(process.env.LIMIT_ORDER_TIMEOUT_MS ?? 120_000); // default 2 min
    const pollStart = Date.now();
    let avgFillPrice: number | undefined;

    if (orderId) {
      const { getDeltaOrderHistory, cancelDeltaOrder } = await import("./deltaExchange.js");
      let filled = false;

      while (Date.now() - pollStart < FILL_TIMEOUT_MS) {
        await new Promise((r) => setTimeout(r, FILL_POLL_INTERVAL_MS));
        try {
          const history = await getDeltaOrderHistory({ limit: 20 });
          const found = history.find((o: any) => String(o.id) === orderId);
          if (found?.state === "filled" || found?.status === "filled") {
            avgFillPrice = found?.average_fill_price ? Number(found.average_fill_price) : undefined;
            filled = true;
            break;
          }
          if (found?.state === "cancelled" || found?.state === "rejected") {
            trade.execution = { venue: "DELTA", status: "REJECTED", error: `Order ${orderId} was ${found.state} on exchange`, orderId };
            onUpdate(trade);
            return;
          }
        } catch (pollErr: any) {
          console.warn(`[execution] fill poll failed for ${trade.asset}: ${pollErr?.message ?? pollErr}`);
        }
      }

      if (!filled) {
        // Timeout: cancel the stale order to prevent it from being filled later
        try {
          await cancelDeltaOrder(orderId);
          console.warn(`[execution] ${trade.asset} limit order ${orderId} not filled within ${FILL_TIMEOUT_MS / 1000}s — cancelled`);
        } catch (cancelErr: any) {
          console.error(`[execution] failed to cancel stale order ${orderId}:`, cancelErr?.message ?? cancelErr);
        }
        trade.execution = { venue: "DELTA", status: "REJECTED", error: `Limit order not filled within timeout (${FILL_TIMEOUT_MS / 1000}s)`, orderId };
        onUpdate(trade);
        return;
      }
    }

    // The exchange position is the authoritative quantity. Replace the
    // fractional risk-model quantity with the exact integer-contract quantity
    // before lifecycle P&L and exits are calculated.
    trade.initialQuantity = contracts * contractValue;
    trade.remainingQuantity = trade.initialQuantity;

    trade.execution = {
      venue: "DELTA",
      status: "FILLED",
      orderId: order?.id != null ? String(order.id) : undefined,
      contracts,
      avgFillPrice,
      entryFeeUsd: Number(order?.paid_commission ?? order?.commission ?? 0) || undefined,
      requestedPrice: trade.entryPrice,
      placedAt: Date.now(),
    };

    // The engine prices off Binance BTCUSDT while Delta settles against its own
    // BTCUSD index; the two can differ by over 1%. Left alone the local record
    // would compute P&L from a price we never actually traded at, so we update
    // the entry price. We intentionally DO NOT shift the stop price or targets,
    // because doing so would move them away from the technical invalidation levels.
    if (avgFillPrice && Number.isFinite(avgFillPrice)) {
      const shift = avgFillPrice - trade.entryPrice;
      if (Math.abs(shift) > 1e-9) {
        trade.execution.priceShift = shift;
        trade.entryPrice = avgFillPrice;
        console.log(
          `[execution] ${trade.asset} filled at ${avgFillPrice} vs ${trade.execution.requestedPrice} on the local feed (slippage: ${shift.toFixed(2)})`
        );
      }
    }
    onUpdate(trade);
  } catch (error: any) {
    trade.execution = {
      venue: "DELTA",
      status: "FAILED",
      error: error?.message ?? String(error),
      retryCount: (trade.execution?.retryCount ?? 0),
    };
    const count = trade.execution.retryCount ?? 0;
    const delay = retryDelay(count);
    if (delay !== null) {
      trade.execution.retryCount = count + 1;
      trade.execution.retryAt = Date.now() + delay;
      const mark = getLastPrice(trade.asset) ?? trade.entryPrice;
      trade.execution.currentRiskUsd = currentRiskUsd(trade, mark);
      console.warn(
        `[execution] ${trade.asset} open failed; retry ${count + 1}/${MAX_RETRIES} in ${delay / 1000}s; current risk $${trade.execution.currentRiskUsd.toFixed(2)}`
      );
      onUpdate(trade);
      setTimeout(() => {
        void tryMirrorOpen(trade, onUpdate).catch((retryError) =>
          console.error(`[execution] retry crashed for ${trade.asset}:`, retryError)
        );
      }, delay);
    } else {
      onUpdate(trade);
      console.error(`[execution] ${trade.asset} open failed permanently after ${count} retries`);
    }
  }
}

/**
 * Flattens the exchange side when a trade closes locally. Only fires for trades
 * that actually reached the exchange — a simulated or rejected open has nothing
 * to close, and sending a blind reduce order would open a position backwards.
 */
export async function mirrorCloseToDelta(trade: Trade, onUpdate: ExecutionUpdate = () => {}): Promise<void> {
  if (trade.execution?.venue !== "DELTA" || trade.execution.status !== "FILLED") return;

  const contracts = trade.execution.contracts;
  if (!contracts || contracts < 1) return;

  await tryMirrorClose(trade, onUpdate);
}

async function tryMirrorClose(trade: Trade, onUpdate: ExecutionUpdate): Promise<void> {
  try {
    const contracts = trade.execution?.contracts;
    if (!contracts || contracts < 1) return;
    const order = await closeDeltaPosition({
      asset: trade.asset,
      size: contracts,
      isLong: trade.direction === "LONG",
    });

    trade.execution = {
      ...trade.execution, venue: trade.execution?.venue ?? "SIMULATED",
      status: "CLOSED",
      closeOrderId: order?.id != null ? String(order.id) : undefined,
      closeFillPrice: order?.average_fill_price != null ? Number(order.average_fill_price) : undefined,
      closeFeeUsd: Number(order?.paid_commission ?? order?.commission ?? 0) || undefined,
      exchangeRealizedPnlUsd: order?.meta_data?.pnl != null ? Number(order.meta_data.pnl) : undefined,
      closedAt: Date.now(),
    };
    onUpdate(trade);
  } catch (error: any) {
    trade.execution = {
      ...trade.execution, venue: trade.execution?.venue ?? "SIMULATED",
      status: "CLOSE_FAILED",
      error: error?.message ?? String(error),
    };
    const count = trade.execution.retryCount ?? 0;
    const delay = retryDelay(count);
    if (delay !== null) {
      trade.execution.retryCount = count + 1;
      trade.execution.retryAt = Date.now() + delay;
      const mark = getLastPrice(trade.asset) ?? trade.entryPrice;
      trade.execution.currentRiskUsd = currentRiskUsd(trade, mark);
      onUpdate(trade);
      console.warn(`[execution] ${trade.asset} close failed; retry ${count + 1}/${MAX_RETRIES} in ${delay / 1000}s`);
      setTimeout(() => {
        void tryMirrorClose(trade, onUpdate).catch((retryError) =>
          console.error(`[execution] close retry crashed for ${trade.asset}:`, retryError)
        );
      }, delay);
    } else {
      onUpdate(trade);
      console.error(`[execution] ${trade.asset} close failed permanently after ${count} retries`);
    }
  }
}

/**
 * Executes a partial close on Delta Exchange when a target is hit locally.
 */
export async function mirrorPartialCloseToDelta(trade: Trade, closeFraction: number): Promise<void> {
  if (trade.execution?.venue !== 'DELTA' || trade.execution.status !== 'FILLED') return;
  const totalContracts = trade.execution.contracts;
  if (!totalContracts || totalContracts < 1) return;

  const contractsToClose = Math.max(1, Math.floor(totalContracts * closeFraction));
  if (contractsToClose < 1) return;

  try {
    await closeDeltaPosition({
      asset: trade.asset,
      size: contractsToClose,
      isLong: trade.direction === 'LONG',
    });
    // Successfully reduced position on exchange.
    // Update local record so the final close uses the remaining amount.
    trade.execution.contracts = (trade.execution.contracts ?? 0) - contractsToClose;
    console.log(`[execution] Partially closed ${contractsToClose} contracts for ${trade.asset}`);
  } catch (error: any) {
    console.error(`[execution] Partial close failed for ${trade.asset}:`, error?.message ?? error);
  }
}


