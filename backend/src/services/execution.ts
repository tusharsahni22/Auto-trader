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
import { exchangeHealth } from "./exchangeHealth.js";
import { cancelBrackets, handleTargetReached, placeBrackets, syncBrackets } from "./brackets.js";
import {
  closeDeltaPosition,
  executeDeltaTrade,
  getDeltaPositions,
  assetToProductId,
  getDeltaProduct,
  isDeltaExchangeEnabled,
} from "./deltaExchange.js";

export function isLiveTradingEnabled(): boolean {
  return process.env.LIVE_TRADING === "true" && isDeltaExchangeEnabled();
}

/**
 * Strict mode: never hold a position locally that the exchange does not have.
 *
 * Defaults ON whenever LIVE_TRADING is true, because a half-simulated book is
 * worse than no trade at all — it reports P&L, risk and equity for a position
 * that does not exist. Set REQUIRE_EXCHANGE_FILL=false for the old
 * degrade-to-simulation behaviour.
 */
export function isStrictLiveOnly(): boolean {
  const flag = process.env.REQUIRE_EXCHANGE_FILL;
  if (flag !== undefined) return flag === "true";
  return process.env.LIVE_TRADING === "true";
}

/**
 * Asked BEFORE a local trade is created, so a trade that cannot reach the
 * exchange is never opened rather than opened and then unwound.
 */
export function preTradeExchangeCheck(): { ok: boolean; reason?: string } {
  if (!isStrictLiveOnly()) return { ok: true };
  if (!isLiveTradingEnabled()) {
    return { ok: false, reason: "LIVE_TRADING is off but REQUIRE_EXCHANGE_FILL demands a real exchange fill" };
  }
  const health = exchangeHealth();
  if (!health.healthy) {
    return { ok: false, reason: health.advice ?? health.message ?? "Delta connection is not healthy" };
  }
  return { ok: true };
}

/**
 * Why orders are or are not reaching Delta.
 *
 * Two independent switches have to be on, and when either is off the engine keeps
 * trading happily in simulation — which looks identical on the dashboard. This
 * names the specific switch that is off so the answer is not a log-dive.
 */
export function getLiveTradingStatus() {
  const flag = process.env.LIVE_TRADING === "true";
  const credentials = isDeltaExchangeEnabled();
  const enabled = flag && credentials;

  const blockers: string[] = [];
  if (!flag) {
    blockers.push(
      `LIVE_TRADING is "${process.env.LIVE_TRADING ?? "unset"}", not "true" — every trade is recorded locally and nothing is sent to Delta.`
    );
  }
  if (!credentials) {
    blockers.push("DELTA_EXCHANGE_API_KEY / DELTA_EXCHANGE_API_SECRET are not both set, so no request can be signed.");
  }

  return {
    enabled,
    liveTradingFlag: flag,
    credentialsConfigured: credentials,
    mode: enabled ? "LIVE" : "SIMULATED",
    entryOrderType: ENTRY_ORDER_TYPE,
    /** Only meaningful for LIMIT entries; a market order fills immediately. */
    limitOrderTimeoutMs: ENTRY_ORDER_TYPE === "LIMIT" ? Number(process.env.LIMIT_ORDER_TIMEOUT_MS ?? 120_000) : null,
    blockers,
    /** Env changes are read at boot, so flipping the flag needs a backend restart. */
    note: enabled
      ? "Orders are mirrored to Delta as real orders."
      : "Trades are simulated. Set the values below in .env and restart the backend to go live.",
  };
}

/**
 * How the opening order reaches Delta.
 *
 * LIMIT (default) rests at the mark and earns the cheaper maker fee, but a market
 * that walks away never fills it: after LIMIT_ORDER_TIMEOUT_MS the order is
 * cancelled and the trade is marked REJECTED, so the engine shows a position the
 * exchange never had. That is the second most common reason for "live trading is
 * on but nothing is on the exchange", after LIVE_TRADING simply being false.
 *
 * MARKET crosses the spread, so it effectively always fills, at the cost of the
 * taker fee and some slippage. Set DELTA_ENTRY_ORDER_TYPE=market to choose it.
 */
const ENTRY_ORDER_TYPE: "LIMIT" | "MARKET" =
  String(process.env.DELTA_ENTRY_ORDER_TYPE ?? "limit").toLowerCase() === "market" ? "MARKET" : "LIMIT";

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
    if (isStrictLiveOnly()) {
      // Fail closed: REJECTED makes the engine unwind the local trade rather than
      // quietly running a simulated position alongside real ones.
      trade.execution = {
        venue: "DELTA",
        status: "REJECTED",
        error: "Strict live-only mode: refusing to open a simulated position while LIVE_TRADING is off",
      };
      onUpdate(trade);
      return;
    }
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
      orderType: ENTRY_ORDER_TYPE,
      limitPrice: ENTRY_ORDER_TYPE === "LIMIT" ? mark : undefined,
    });

    const orderId: string | undefined = order?.id != null ? String(order.id) : undefined;

    // FIX: Limit order fill confirmation with timeout + auto-cancel.
    // Without this, an unfilled limit order causes the engine to attempt to
    // "close" a position that was never opened, which creates a reverse position.
    const FILL_POLL_INTERVAL_MS = 10_000;  // check every 10s
    const FILL_TIMEOUT_MS = Number(process.env.LIMIT_ORDER_TIMEOUT_MS ?? 120_000); // default 2 min
    const pollStart = Date.now();
    let avgFillPrice: number | undefined;

    // A market order is already done by the time the response comes back, so the
    // poll-and-cancel loop below applies only to a resting limit order.
    if (ENTRY_ORDER_TYPE === "MARKET") {
      const reported = Number(order?.average_fill_price);
      if (Number.isFinite(reported) && reported > 0) avgFillPrice = reported;
    } else if (orderId) {
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
          await cancelDeltaOrder(orderId, await assetToProductId(trade.asset));
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

    // Put the stop-loss and take-profits on the exchange so the position stays protected
    // even if this backend goes down. Never throws; failures are recorded on the trade.
    await placeBrackets(trade);
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
  // Deliberately NOT gated on status === "FILLED". A trade whose close already
  // failed sits in CLOSE_FAILED, and that is exactly the position still open on
  // Delta that most needs closing — the old guard turned the reconciler's orphan
  // recovery into a silent no-op, so a position could stay open on the exchange
  // indefinitely while the dashboard showed it closed. tryMirrorClose reads the
  // real position size before sending anything, so acting here is safe.
  if (trade.execution?.venue !== "DELTA") return;

  const contracts = trade.execution.contracts;
  if (!contracts || contracts < 1) return;

  await tryMirrorClose(trade, onUpdate);
}

async function tryMirrorClose(trade: Trade, onUpdate: ExecutionUpdate): Promise<void> {
  try {
    const contracts = trade.execution?.contracts;
    if (!contracts || contracts < 1) return;

    // Cancel resting protective orders first so a stop cannot fire in the middle of this close.
    await cancelBrackets(trade);

    // A bracket stop or target may already have flattened the position on the exchange.
    // Close only what is really there: a plain close must never open a reverse position.
    let exchangeSize: number | null = null;
    try {
      const { assetToProductId } = await import("./deltaExchange.js");
      const productId = await assetToProductId(trade.asset);
      const symbol = trade.asset.replace(/USDT$/, "USD");
      const positions = await getDeltaPositions();
      const match = positions.find((p: any) => p.product_id === productId || String(p.product_symbol ?? p.symbol ?? "") === symbol);
      exchangeSize = match ? Math.abs(Number(match.size ?? match.position_size ?? 0)) : 0;
    } catch {
      /* cannot read positions: fall through and attempt the close */
    }
    if (exchangeSize === 0) {
      const { findExchangeExit } = await import("./brackets.js");
      const exit = await findExchangeExit(trade);
      trade.execution = {
        ...trade.execution, venue: trade.execution?.venue ?? "SIMULATED",
        status: "CLOSED",
        closeFillPrice: exit?.price,
        closedAt: Date.now(),
      };
      onUpdate(trade);
      return;
    }
    const closeSize = exchangeSize !== null ? Math.min(contracts, exchangeSize) : contracts;
    const order = await closeDeltaPosition({
      asset: trade.asset,
      size: closeSize,
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
    // The close failed after the protective orders were cancelled: put the stop back so the
    // still-open position is not naked while the retries run.
    if (trade.execution?.bracket) {
      trade.execution.bracket.status = "UNPROTECTED";
      void syncBrackets(trade, true);
    }
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
 * A target was reached locally. If Delta already has a take-profit order resting for it, that
 * order fills itself and this only confirms it; otherwise the planned number of contracts is
 * closed here with a reduce-only order. Afterwards the exchange stop is resized and moved
 * (breakeven / trail) to match the smaller position.
 */
export async function mirrorPartialCloseToDelta(trade: Trade, closeFraction: number, targetPrice?: number): Promise<void> {
  if (trade.execution?.venue !== "DELTA" || trade.execution.status !== "FILLED") return;
  const totalContracts = trade.execution.contracts;
  if (!totalContracts || totalContracts < 1) return;

  try {
    let size: number;
    if (targetPrice !== undefined) {
      const result = await handleTargetReached(trade, targetPrice);
      if (result.mode === "EXCHANGE") {
        console.log(`[execution] ${trade.asset} take-profit filled on Delta (${result.size} contracts)`);
        await syncBrackets(trade, true);
        return;
      }
      size = result.size;
    } else {
      size = Math.max(1, Math.floor(totalContracts * closeFraction));
    }

    size = Math.min(size, totalContracts);
    if (size < 1) return;
    await closeDeltaPosition({
      asset: trade.asset,
      size,
      isLong: trade.direction === "LONG",
    });
    // Reduced the position on the exchange: keep the local contract count in step.
    trade.execution.contracts = (trade.execution.contracts ?? 0) - size;
    console.log(`[execution] Partially closed ${size} contracts for ${trade.asset}`);
    await syncBrackets(trade, true);
  } catch (error: any) {
    console.error(`[execution] Partial close failed for ${trade.asset}:`, error?.message ?? error);
  }
}
