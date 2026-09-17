/**
 * Market data API — ticker and candles.
 */

import { Router } from "express";
import { getCandles, getFundingRate, getLastPrice } from "../marketData.js";
import { getInterval } from "../engine/index.js";
import type { Asset } from "../types.js";

export const marketRouter = Router();

const VALID_ASSETS: Asset[] = ["BTCUSDT", "ETHUSDT"];

/** Resolutions Delta's candle history accepts. */
export const SUPPORTED_RESOLUTIONS = ["1m", "5m", "15m", "1h", "4h", "1d", "1w"] as const;
export type Resolution = (typeof SUPPORTED_RESOLUTIONS)[number];

function parseAsset(raw: unknown): Asset | null {
  return VALID_ASSETS.includes(raw as Asset) ? (raw as Asset) : null;
}

marketRouter.get("/resolutions", (_req, res) => {
  res.json({ resolutions: SUPPORTED_RESOLUTIONS, default: "15m" });
});

marketRouter.get("/ticker", (req, res) => {
  const requested = req.query.asset;
  const assets = requested ? ([parseAsset(requested)].filter(Boolean) as Asset[]) : VALID_ASSETS;

  if (requested && assets.length === 0) {
    res.status(400).json({ error: `asset must be one of ${VALID_ASSETS.join(", ")}` });
    return;
  }

  res.json({
    tickers: assets.map((asset) => {
      const candles = getCandles(asset, getInterval());
      const previous = candles.length >= 2 ? candles[candles.length - 2].close : null;
      const price = getLastPrice(asset);
      return {
        asset,
        price,
        fundingRate: getFundingRate(asset),
        changePct: price !== null && previous ? ((price - previous) / previous) * 100 : null,
        time: Date.now(),
      };
    }),
  });
});

/**
 * Candles at an arbitrary resolution. Delta is the source since it serves any
 * supported timeframe on demand; the internal feed only maintains the engine's
 * own interval, so it is the fallback rather than the default.
 */
marketRouter.get("/candles/:asset", async (req, res) => {
  const asset = parseAsset(req.params.asset);
  if (!asset) {
    res.status(400).json({ error: `asset must be one of ${VALID_ASSETS.join(", ")}` });
    return;
  }

  const requested = String(req.query.resolution ?? getInterval());
  if (!SUPPORTED_RESOLUTIONS.includes(requested as Resolution)) {
    res.status(400).json({ error: `resolution must be one of ${SUPPORTED_RESOLUTIONS.join(", ")}` });
    return;
  }

  const parsedLimit = parseInt(String(req.query.limit ?? ""), 10);
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 1000) : 500;

  try {
    const { getDeltaCandles } = await import("../services/deltaExchange.js");
    const candles = await getDeltaCandles(asset, requested, limit);
    if (candles.length > 0) {
      res.json({ asset, resolution: requested, source: "delta", candles });
      return;
    }
    throw new Error("Delta returned an empty series");
  } catch (error: any) {
    const fallback = getCandles(asset, getInterval());
    if (fallback.length === 0) {
      res.status(502).json({ error: `No candle data available: ${error?.message ?? error}` });
      return;
    }
    res.json({
      asset,
      resolution: getInterval(),
      source: "internal",
      warning: `Delta candles unavailable (${error?.message ?? error}); serving the engine's ${getInterval()} feed instead.`,
      candles: fallback.slice(-limit),
    });
  }
});
