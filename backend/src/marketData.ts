import fetch from "node-fetch";
import WebSocket from "ws";
import type { Asset, Candle } from "./types.js";

const BINANCE_REST = "https://api.binance.com";
const BINANCE_FAPI = "https://fapi.binance.com"; // USDS-M futures — free, no key required
const BINANCE_WS = "wss://stream.binance.com:9443/stream";

// In-memory rolling candle store per asset/interval, fed by REST bootstrap + live WS klines.
const store = new Map<string, Candle[]>();
const lastPrice = new Map<Asset, number>();
const fundingRate = new Map<Asset, number>(); // most recent 8h funding rate, fraction (e.g. 0.0001 = 0.01%)
const feedSource = new Map<Asset, "delta" | "binance">();
const feedUpdatedAt = new Map<Asset, number>();

function key(asset: Asset, interval: string) {
  return `${asset}:${interval}`;
}

export function getCandles(asset: Asset, interval: string): Candle[] {
  return store.get(key(asset, interval)) ?? [];
}

export function getLastPrice(asset: Asset): number | null {
  return lastPrice.get(asset) ?? null;
}

export function getFundingRate(asset: Asset): number {
  return fundingRate.get(asset) ?? 0;
}

export function getMarketFeedHealth(asset: Asset) {
  const updatedAt = feedUpdatedAt.get(asset) ?? 0;
  const source = feedSource.get(asset) ?? "binance";
  const ageMs = updatedAt ? Date.now() - updatedAt : Number.POSITIVE_INFINITY;
  return { source, ageMs, fresh: ageMs <= 90_000 };
}

async function bootstrap(asset: Asset, interval: string, limit = 500) {
  try {
    const { getDeltaCandles } = await import("./services/deltaExchange.js");
    const deltaCandles = await getDeltaCandles(asset, interval, limit);
    if (deltaCandles.length > 0) {
      store.set(key(asset, interval), deltaCandles);
      lastPrice.set(asset, deltaCandles[deltaCandles.length - 1].close);
      feedSource.set(asset, "delta");
      feedUpdatedAt.set(asset, Date.now());
      const latest = deltaCandles[deltaCandles.length - 1];
      for (const listener of listeners) listener(asset, latest.close, latest);
      return;
    }
  } catch (error) {
    console.warn(`[marketData] Delta feed unavailable for ${asset}; using Binance fallback`, (error as Error).message);
  }
  const url = `${BINANCE_REST}/api/v3/klines?symbol=${asset}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance klines failed: ${res.status}`);
  const raw = (await res.json()) as unknown[][];
  const candles: Candle[] = raw.map((k) => ({
    time: Math.floor((k[0] as number) / 1000),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
  }));
  store.set(key(asset, interval), candles);
  if (candles.length) {
    lastPrice.set(asset, candles[candles.length - 1].close);
    feedSource.set(asset, "binance");
    feedUpdatedAt.set(asset, Date.now());
  }
}

async function refreshFundingRate(asset: Asset) {
  try {
    const { getDeltaTicker, assetToDeltaSymbol } = await import("./services/deltaExchange.js");
    const deltaTicker = await getDeltaTicker(assetToDeltaSymbol(asset));
    // Delta reports funding_rate in percent (0.01 = 0.01% per 8h); the rest of the
    // system (and Binance's field) uses fractions, so convert here.
    const deltaFundingPct = Number(deltaTicker?.funding_rate ?? deltaTicker?.funding_rate_8h);
    if (Number.isFinite(deltaFundingPct)) {
      fundingRate.set(asset, deltaFundingPct / 100);
      return;
    }
  } catch {
    // Public Binance funding is the explicitly marked fallback below.
  }
  try {
    const res = await fetch(`${BINANCE_FAPI}/fapi/v1/premiumIndex?symbol=${asset}`);
    if (!res.ok) return;
    const data = (await res.json()) as { lastFundingRate: string };
    fundingRate.set(asset, Number(data.lastFundingRate));
  } catch (e) {
    console.warn(`[marketData] funding rate fetch failed for ${asset}`, (e as Error).message);
  }
}

function upsertLiveCandle(asset: Asset, interval: string, candle: Candle) {
  if (feedSource.get(asset) === "delta") return;
  const arr = store.get(key(asset, interval)) ?? [];
  const idx = arr.findIndex((c) => c.time === candle.time);
  if (idx >= 0) arr[idx] = candle;
  else arr.push(candle);
  if (arr.length > 1000) arr.shift();
  store.set(key(asset, interval), arr);
  if (feedSource.get(asset) !== "delta") {
    lastPrice.set(asset, candle.close);
    feedSource.set(asset, "binance");
    feedUpdatedAt.set(asset, Date.now());
  }
}

function intervalToSeconds(interval: string): number {
  const n = Number(interval.slice(0, -1));
  const unit = interval.slice(-1);
  const mult = unit === "m" ? 60 : unit === "h" ? 3600 : unit === "d" ? 86400 : 60;
  return Number.isFinite(n) && n > 0 ? n * mult : 900;
}

async function pollDeltaTicker(asset: Asset, interval: string, intervalSec: number) {
  const { getDeltaTicker, assetToDeltaSymbol } = await import("./services/deltaExchange.js");
  const ticker = await getDeltaTicker(assetToDeltaSymbol(asset));
  // mark_price moves continuously; the last-trade "close" only changes when a trade prints (rare on testnet).
  const price = Number(ticker?.mark_price ?? ticker?.close);
  if (!Number.isFinite(price) || price <= 0) return;

  const arr = store.get(key(asset, interval));
  const last = arr?.[arr.length - 1];
  lastPrice.set(asset, price);
  feedUpdatedAt.set(asset, Date.now());
  if (!last) return;

  // Only extend the candle that is actually forming; a new period's candle arrives with the 60s refresh.
  if (Date.now() / 1000 < last.time + intervalSec) {
    last.close = price;
    last.high = Math.max(last.high, price);
    last.low = Math.min(last.low, price);
  }
  for (const listener of listeners) listener(asset, price, last);
}

export type PriceListener = (asset: Asset, price: number, candle: Candle) => void;
const listeners: PriceListener[] = [];
export function onPrice(fn: PriceListener) {
  listeners.push(fn);
}

let ws: WebSocket | null = null;
let lastMessageAt = 0;

/**
 * A dropped network path often leaves the socket half-open: no data arrives but
 * no 'close' ever fires, so the reconnect handler never runs and the feed dies
 * silently. Watch the message clock instead and force a reconnect when it goes
 * quiet.
 */
const STALL_TIMEOUT_MS = 90_000;
const STALL_CHECK_MS = 30_000;

export async function startMarketData(assets: Asset[], intervals: string[]) {
  for (const asset of assets) {
    for (const interval of intervals) {
      await bootstrap(asset, interval);
    }
    await refreshFundingRate(asset);
  }

  setInterval(() => {
    for (const asset of assets) refreshFundingRate(asset);
  }, 5 * 60 * 1000);

  // Delta is authoritative for the strategy. Refresh its candles frequently
  // enough to replace the Binance fallback and restore source freshness.
  setInterval(() => {
    for (const asset of assets) {
      for (const interval of intervals) {
        bootstrap(asset, interval).catch((e) => console.warn(`[marketData] Delta refresh failed for ${asset}`, (e as Error).message));
      }
    }
  }, 60_000);

  // Once Delta is the candle source, Binance ticks are ignored and Delta candles only refresh every
  // 60s, which froze the live price between refreshes. Poll Delta's ticker for a fresh last price and
  // fold it into the forming candle so the price (and chart) move every couple of seconds.
  const primary = intervals[0];
  const intervalSec = intervalToSeconds(primary);
  const tickerPollMs = Number(process.env.DELTA_TICKER_POLL_MS ?? 2000);
  const tickerBusy = new Set<Asset>();
  const tickerBackoffUntil = new Map<Asset, number>();
  setInterval(() => {
    for (const asset of assets) {
      if (feedSource.get(asset) !== "delta" || tickerBusy.has(asset)) continue;
      if (Date.now() < (tickerBackoffUntil.get(asset) ?? 0)) continue;
      tickerBusy.add(asset);
      void pollDeltaTicker(asset, primary, intervalSec)
        .catch(() => tickerBackoffUntil.set(asset, Date.now() + 10_000))
        .finally(() => tickerBusy.delete(asset));
    }
  }, tickerPollMs);

  const streams = assets.flatMap((a) =>
    intervals.map((i) => `${a.toLowerCase()}@kline_${i}`)
  ).join("/");

  const connect = () => {
    ws = new WebSocket(`${BINANCE_WS}?streams=${streams}`);
    ws.on("open", () => {
      lastMessageAt = Date.now();
      console.log("[marketData] connected to Binance WS");
    });
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        const k = msg?.data?.k;
        if (!k) return;
        const asset = (k.s as string) as Asset;
        const interval = k.i as string;
        const candle: Candle = {
          time: Math.floor(k.t / 1000),
          open: Number(k.o),
          high: Number(k.h),
          low: Number(k.l),
          close: Number(k.c),
          volume: Number(k.v),
        };
        lastMessageAt = Date.now();
        upsertLiveCandle(asset, interval, candle);
        if (feedSource.get(asset) === "delta") return;
        if (interval === intervals[0]) {
          for (const l of listeners) l(asset, candle.close, candle);
        }
      } catch (e) {
        console.error("[marketData] parse error", e);
      }
    });
    ws.on("close", () => {
      console.warn("[marketData] WS closed, reconnecting in 3s");
      setTimeout(connect, 3000);
    });
    ws.on("error", (err) => console.error("[marketData] WS error", err.message));
  };

  connect();

  setInterval(() => {
    if (lastMessageAt === 0) return;
    const silentFor = Date.now() - lastMessageAt;
    if (silentFor < STALL_TIMEOUT_MS) return;

    console.warn(
      `[marketData] no WS data for ${Math.round(silentFor / 1000)}s — forcing reconnect`
    );
    lastMessageAt = Date.now(); // avoid a terminate storm while it reconnects
    try {
      ws?.terminate();
    } catch {
      /* the close handler schedules the reconnect */
    }

    // Refill whatever the outage skipped so the chart has no hole.
    for (const asset of assets) {
      for (const interval of intervals) {
        bootstrap(asset, interval).catch((e) =>
          console.warn(`[marketData] re-bootstrap failed for ${asset}`, (e as Error).message)
        );
      }
    }
  }, STALL_CHECK_MS);
}
