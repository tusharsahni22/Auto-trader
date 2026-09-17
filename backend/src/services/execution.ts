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
  return { contracts: Math.round(quantity / contractValue), contractValue };
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
    if (stopCrossed) {
      trade.execution = {
        ...trade.execution,
        status: "REJECTED",
        error: `Retry cancelled: current price ${mark} has crossed the stop ${trade.stopPrice}`,
        currentRiskUsd: currentRiskUsd(trade, mark),
      };
      onUpdate(trade);
      return;
    }

    // The market order has no limit price. This records the latest price used
    // for risk reporting; entry/targets are shifted only after a real fill.
    trade.execution = {
      ...trade.execution,
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
      orderType: "MARKET",
    });

    const avgFillPrice = order?.average_fill_price ? Number(order.average_fill_price) : undefined;

    trade.execution = {
      venue: "DELTA",
      status: "FILLED",
      orderId: order?.id != null ? String(order.id) : undefined,
      contracts,
      avgFillPrice,
      requestedPrice: trade.entryPrice,
      placedAt: Date.now(),
    };

    // The engine prices off Binance BTCUSDT while Delta settles against its own
    // BTCUSD index; the two can differ by over 1%. Left alone the local record
    // would compute P&L from a price we never actually traded at, so the whole
    // setup is shifted onto the real fill. Shifting (rather than only moving the
    // entry) keeps the stop distance and therefore every R-multiple intact.
    if (avgFillPrice && Number.isFinite(avgFillPrice)) {
      const shift = avgFillPrice - trade.entryPrice;
      if (Math.abs(shift) > 1e-9) {
        trade.execution.priceShift = shift;
        trade.entryPrice = avgFillPrice;
        trade.stopPrice += shift;
        trade.initialStopPrice += shift;
        for (const target of trade.targets) target.price += shift;
        console.log(
          `[execution] ${trade.asset} filled at ${avgFillPrice} vs ${trade.execution.requestedPrice} on the local feed — setup shifted by ${shift.toFixed(2)}`
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
      ...trade.execution,
      status: "CLOSED",
      closeOrderId: order?.id != null ? String(order.id) : undefined,
      closedAt: Date.now(),
    };
    onUpdate(trade);
  } catch (error: any) {
    trade.execution = {
      ...trade.execution,
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
