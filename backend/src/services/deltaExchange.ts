/**
 * Delta Exchange Paper Trading Integration
 * Provides interaction with Delta Exchange testnet for paper trading
 */

import crypto from 'crypto';

const API_KEY = process.env.DELTA_EXCHANGE_API_KEY || '';
const API_SECRET = process.env.DELTA_EXCHANGE_API_SECRET || '';
// Testnet by default for paper trading; override for india/global production.
const BASE_URL = process.env.DELTA_EXCHANGE_BASE_URL || 'https://testnet-api.delta.exchange';

interface DeltaExchangeConfig {
  enabled: boolean;
  apiKey: string;
  apiSecret: string;
}

/**
 * Generate signature for Delta Exchange API authentication
 */
function generateSignature(method: string, path: string, timestamp: number, body: string = ''): string {
  const message = method + timestamp + path + body;
  return crypto.createHmac('sha256', API_SECRET).update(message).digest('hex');
}

/**
 * Make authenticated request to Delta Exchange API
 */
async function deltaRequest(
  method: string,
  path: string,
  body?: any
): Promise<any> {
  if (!API_KEY || !API_SECRET) {
    throw new Error('Delta Exchange credentials not configured');
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const bodyString = body ? JSON.stringify(body) : '';
  const signature = generateSignature(method, path, timestamp, bodyString);

  const headers: Record<string, string> = {
    'api-key': API_KEY,
    'signature': signature,
    'timestamp': timestamp.toString(),
    'User-Agent': 'auto-trader', // Delta rejects requests without one
    'Content-Type': 'application/json',
  };

  const options: RequestInit = {
    method,
    headers,
  };

  if (body) {
    options.body = bodyString;
  }

  const response = await fetch(BASE_URL + path, options);

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: unknown; message?: unknown } | null;
    // Delta nests the reason as { error: { code: "invalid_api_key" } }.
    const reason =
      (payload?.error as any)?.code ??
      (typeof payload?.error === 'string' ? payload.error : null) ??
      (typeof payload?.message === 'string' ? payload.message : null) ??
      response.statusText;
    throw new Error(`Delta Exchange API error (${response.status}) ${method} ${path}: ${reason}`);
  }

  return response.json();
}

/**
 * Get account balance
 */
export async function getDeltaBalance(): Promise<any> {
  try {
    const result = await deltaRequest('GET', '/v2/wallet/balances');
    return result.result;
  } catch (error: any) {
    console.error('[deltaExchange] Failed to get balance:', error);
    throw error;
  }
}

/**
 * Get margined/open positions.
 *
 * Delta's current REST API exposes the collection at /v2/positions/margined;
 * /v2/positions is not a valid collection route and returns bad_schema.
 */
export async function getDeltaPositions(): Promise<any[]> {
  try {
    const result = await deltaRequest('GET', '/v2/positions/margined');
    const positions = result.result;
    return Array.isArray(positions) ? positions : positions ? [positions] : [];
  } catch (error: any) {
    console.error('[deltaExchange] Failed to get positions:', error);
    throw error;
  }
}

/**
 * Get available products/contracts
 */
export async function getDeltaProducts(): Promise<any[]> {
  try {
    const result = await deltaRequest('GET', '/v2/products');
    return result.result || [];
  } catch (error: any) {
    console.error('[deltaExchange] Failed to get products:', error);
    return [];
  }
}

/**
 * Place a new order
 */
export async function placeDeltaOrder(params: {
  productId: number;
  size: number;
  side: 'buy' | 'sell';
  orderType: 'market_order' | 'limit_order';
  limitPrice?: number;
  stopPrice?: number;
  timeInForce?: 'gtc' | 'ioc' | 'fok';
  /** Reduce-only orders can shrink a position but never open or flip one. */
  reduceOnly?: boolean;
  /** Turns the order into an exchange-side stop-loss / take-profit trigger. */
  stopOrderType?: 'stop_loss_order' | 'take_profit_order';
  stopTriggerMethod?: 'mark_price' | 'last_traded_price';
}): Promise<any> {
  try {
    const orderParams: any = {
      product_id: params.productId,
      size: params.size,
      side: params.side,
      order_type: params.orderType,
      time_in_force: params.timeInForce || 'gtc',
    };

    if (params.limitPrice) {
      orderParams.limit_price = params.limitPrice.toString();
    }

    if (params.stopPrice) {
      orderParams.stop_price = params.stopPrice.toString();
    }
    if (params.reduceOnly) orderParams.reduce_only = true;
    if (params.stopOrderType) {
      orderParams.stop_order_type = params.stopOrderType;
      orderParams.stop_trigger_method = params.stopTriggerMethod ?? 'mark_price';
      delete orderParams.time_in_force; // trigger orders do not take a time-in-force
    }

    const result = await deltaRequest('POST', '/v2/orders', orderParams);
    console.log('[deltaExchange] Order placed:', result.result);
    return result.result;
  } catch (error: any) {
    console.error('[deltaExchange] Failed to place order:', error);
    throw error;
  }
}

/**
 * Cancel an order
 */
export async function cancelDeltaOrder(orderId: string, productId?: number): Promise<any> {
  try {
    // Delta cancels via DELETE /v2/orders with the order id and product id in the body.
    const result = productId !== undefined
      ? await deltaRequest('DELETE', '/v2/orders', { id: Number(orderId), product_id: productId })
      : await deltaRequest('DELETE', `/v2/orders/${orderId}`);
    console.log('[deltaExchange] Order canceled:', orderId);
    return result.result;
  } catch (error: any) {
    console.error('[deltaExchange] Failed to cancel order:', error);
    throw error;
  }
}

/**
 * Open and pending orders for one product (used to verify stops/targets still exist).
 */
export async function getDeltaOpenOrders(productId: number): Promise<any[]> {
  const result = await deltaRequest('GET', `/v2/orders?product_ids=${productId}&states=open,pending`);
  return Array.isArray(result.result) ? result.result : [];
}

/**
 * Public L2 order book, used by the pre-trade liquidity gate.
 */
export async function getDeltaOrderBook(symbol: string, depth = 20): Promise<{ buy: { price: string; size: number }[]; sell: { price: string; size: number }[] }> {
  const response = await fetch(`${BASE_URL}/v2/l2orderbook/${symbol}?depth=${depth}`, { headers: { 'User-Agent': 'auto-trader' } });
  if (!response.ok) throw new Error(`Delta order book failed: ${response.status}`);
  const data = (await response.json()) as { result?: { buy?: any[]; sell?: any[] } };
  return { buy: data.result?.buy ?? [], sell: data.result?.sell ?? [] };
}

/**
 * Get order history
 */
export async function getDeltaOrderHistory(params?: {
  productId?: number;
  states?: string[];
  after?: number;
  before?: number;
  limit?: number;
}): Promise<any[]> {
  try {
    let path = '/v2/orders/history';
    const queryParams: string[] = [];

    if (params?.productId) queryParams.push(`product_id=${params.productId}`);
    if (params?.states) queryParams.push(`states=${params.states.join(',')}`);
    if (params?.after) queryParams.push(`after=${params.after}`);
    if (params?.before) queryParams.push(`before=${params.before}`);
    if (params?.limit) queryParams.push(`page_size=${params.limit}`);

    if (queryParams.length > 0) {
      path += '?' + queryParams.join('&');
    }

    const result = await deltaRequest('GET', path);
    return result.result || [];
  } catch (error: any) {
    console.error('[deltaExchange] Failed to get order history:', error);
    return [];
  }
}

/**
 * Get fills/trades
 */
export async function getDeltaFills(productId?: number): Promise<any[]> {
  try {
    let path = '/v2/fills';
    if (productId) {
      path += `?product_id=${productId}`;
    }

    const result = await deltaRequest('GET', path);
    return result.result || [];
  } catch (error: any) {
    console.error('[deltaExchange] Failed to get fills:', error);
    return [];
  }
}

/**
 * Get product ticker
 */
export async function getDeltaTicker(symbol: string): Promise<any> {
  try {
    const result = await deltaRequest('GET', `/v2/tickers/${symbol}`);
    return result.result;
  } catch (error: any) {
    console.error('[deltaExchange] Failed to get ticker:', error);
    throw error;
  }
}

/**
 * Internal symbols are Binance-style (BTCUSDT); Delta's perpetuals settle in USD
 * and are named BTCUSD.
 */
export function assetToDeltaSymbol(asset: string): string {
  return asset.replace(/USDT$/, 'USD');
}

interface DeltaProduct {
  id: number;
  symbol: string;
  contract_value: string;
  tick_size: string;
}

let productCache: Map<string, DeltaProduct> | null = null;

/**
 * Product IDs differ per Delta environment, so they are looked up rather than
 * hardcoded. Cached for the process lifetime — IDs are stable.
 */
export async function getDeltaProduct(asset: string): Promise<DeltaProduct> {
  const symbol = assetToDeltaSymbol(asset);

  if (!productCache) {
    const response = await fetch(
      `${BASE_URL}/v2/products?contract_types=perpetual_futures&page_size=200`,
      { headers: { 'User-Agent': 'auto-trader' } }
    );
    if (!response.ok) throw new Error(`Delta products lookup failed: ${response.status}`);
    const data = (await response.json()) as { result?: DeltaProduct[] };
    productCache = new Map((data.result ?? []).map((p) => [p.symbol, p]));
  }

  const product = productCache.get(symbol);
  if (!product) throw new Error(`No Delta perpetual product for ${symbol}`);
  return product;
}

export async function assetToProductId(asset: string): Promise<number> {
  return (await getDeltaProduct(asset)).id;
}

export interface DeltaCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * OHLCV history. This is a public endpoint — no signing required. Delta returns
 * newest-first, so the series is reversed to chronological order.
 */
export async function getDeltaCandles(
  asset: string,
  resolution = '15m',
  limit = 250
): Promise<DeltaCandle[]> {
  const symbol = assetToDeltaSymbol(asset);
  const secondsPerBar = resolutionToSeconds(resolution);
  const end = Math.floor(Date.now() / 1000);
  const start = end - limit * secondsPerBar;

  const url = `${BASE_URL}/v2/history/candles?resolution=${resolution}&symbol=${symbol}&start=${start}&end=${end}`;
  const response = await fetch(url, { headers: { 'User-Agent': 'auto-trader' } });
  if (!response.ok) throw new Error(`Delta candles failed for ${symbol}: ${response.status}`);

  const data = (await response.json()) as { success?: boolean; result?: DeltaCandle[] };
  if (!data.success || !Array.isArray(data.result)) {
    throw new Error(`Delta returned no candles for ${symbol}`);
  }

  return data.result
    .map((c) => ({
      time: c.time,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volume),
    }))
    .sort((a, b) => a.time - b.time);
}

function resolutionToSeconds(resolution: string): number {
  const match = resolution.match(/^(\d+)([mhdw])$/);
  if (!match) throw new Error(`Unsupported resolution: ${resolution}`);
  const value = Number(match[1]);
  const unit = { m: 60, h: 3600, d: 86400, w: 604800 }[match[2]]!;
  return value * unit;
}

/**
 * Check if Delta Exchange is configured and enabled
 */
export function isDeltaExchangeEnabled(): boolean {
  return Boolean(API_KEY && API_SECRET);
}

/**
 * Get Delta Exchange configuration
 */
export function getDeltaExchangeConfig(): DeltaExchangeConfig {
  return {
    enabled: isDeltaExchangeEnabled(),
    apiKey: API_KEY ? API_KEY.substring(0, 8) + '...' : '',
    apiSecret: API_SECRET ? '***' : '',
  };
}

/** Safe diagnostics for verifying both deployments use the same Delta account/venue. */
export function getDeltaConnectionInfo() {
  return {
    baseUrl: BASE_URL,
    apiKeyPrefix: API_KEY ? `${API_KEY.substring(0, 8)}...` : null,
    configured: isDeltaExchangeEnabled(),
  };
}

/**
 * Execute a trade on Delta Exchange (wrapper for internal use)
 */
export async function executeDeltaTrade(params: {
  asset: string;
  direction: 'LONG' | 'SHORT';
  size: number;
  orderType?: 'MARKET' | 'LIMIT';
  limitPrice?: number;
}): Promise<any> {
  const productId = await assetToProductId(params.asset);
  const side = params.direction === 'LONG' ? 'buy' : 'sell';
  const orderType = params.orderType === 'LIMIT' ? 'limit_order' : 'market_order';

  return placeDeltaOrder({
    productId,
    size: params.size,
    side,
    orderType,
    limitPrice: params.limitPrice,
  });
}

/**
 * Close a position on Delta Exchange
 */
export async function closeDeltaPosition(params: {
  asset: string;
  size: number;
  isLong: boolean;
}): Promise<any> {
  const productId = await assetToProductId(params.asset);
  const side = params.isLong ? 'sell' : 'buy'; // Opposite of position

  // Reduce-only: if the exchange already closed this position (for example a bracket stop
  // fired first), this is rejected instead of opening a reverse position.
  return placeDeltaOrder({
    productId,
    size: params.size,
    side,
    orderType: 'market_order',
    reduceOnly: true,
  });
}

/**
 * Exchange-side protective order: a reduce-only market order that triggers on the mark price.
 * A stop-loss survives a backend crash or restart; that is the point of using it.
 */
export async function placeDeltaStopOrder(params: {
  asset: string;
  isLong: boolean;
  size: number;
  triggerPrice: number;
  kind: 'stop_loss_order' | 'take_profit_order';
}): Promise<any> {
  const product = await getDeltaProduct(params.asset);
  const tick = Number(product.tick_size) || 0.5;
  const rounded = Math.round(params.triggerPrice / tick) * tick;
  const decimals = (String(tick).split('.')[1] ?? '').length;
  return placeDeltaOrder({
    productId: product.id,
    size: params.size,
    side: params.isLong ? 'sell' : 'buy', // opposite of the position
    orderType: 'market_order',
    stopPrice: Number(rounded.toFixed(decimals)),
    reduceOnly: true,
    stopOrderType: params.kind,
    stopTriggerMethod: 'mark_price',
  });
}
