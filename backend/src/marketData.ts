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

async function bootstrap(asset: Asset, interval: string, limit = 500) {
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
  if (candles.length) lastPrice.set(asset, candles[candles.length - 1].close);
}

async function refreshFundingRate(asset: Asset) {
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
  const arr = store.get(key(asset, interval)) ?? [];
  const idx = arr.findIndex((c) => c.time === candle.time);
  if (idx >= 0) arr[idx] = candle;
  else arr.push(candle);
  if (arr.length > 1000) arr.shift();
  store.set(key(asset, interval), arr);
  lastPrice.set(asset, candle.close);
}

export type PriceListener = (asset: Asset, price: number, candle: Candle) => void;
const listeners: PriceListener[] = [];
export function onPrice(fn: PriceListener) {
  listeners.push(fn);
}

let ws: WebSocket | null = null;

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

  const streams = assets.flatMap((a) =>
    intervals.map((i) => `${a.toLowerCase()}@kline_${i}`)
  ).join("/");

  const connect = () => {
    ws = new WebSocket(`${BINANCE_WS}?streams=${streams}`);
    ws.on("open", () => console.log("[marketData] connected to Binance WS"));
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
        upsertLiveCandle(asset, interval, candle);
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
}
