import { Router } from "express";
import { getCandles, getFundingRate } from "../marketData.js";
import { forceOpenTrade, getAssets, getEngineState, getEquityCurve, getInterval, getLastScans, getRecentOpportunities, startEngine, stopEngine } from "../engine/index.js";
import { getTrades } from "../db.js";
import { classifyRegime } from "../decision/regime.js";
import { getAllCellStats, getPlattParams } from "../learning/stats.js";
import type { Asset, Direction } from "../types.js";

export const api = Router();

api.get("/status", (_req, res) => {
  res.json({ engine: getEngineState(), assets: getAssets(), interval: getInterval(), scans: getLastScans() });
});

api.post("/engine/start", (_req, res) => {
  startEngine();
  res.json({ ok: true, engine: getEngineState() });
});

api.post("/engine/stop", (_req, res) => {
  stopEngine();
  res.json({ ok: true, engine: getEngineState() });
});

api.post("/engine/force-trade", (req, res) => {
  const asset = (req.body?.asset as Asset) ?? "BTCUSDT";
  const direction = (req.body?.direction as Direction) ?? "LONG";
  if (!["BTCUSDT", "ETHUSDT"].includes(asset) || !["LONG", "SHORT"].includes(direction)) {
    res.status(400).json({ ok: false, error: "Invalid asset or direction" });
    return;
  }
  const result = forceOpenTrade(asset, direction);
  if (!result.ok) {
    res.status(409).json(result);
    return;
  }
  res.json(result);
});

api.get("/candles/:asset", (req, res) => {
  const asset = req.params.asset as Asset;
  res.json(getCandles(asset, getInterval()));
});

api.get("/trades", (req, res) => {
  let trades = getTrades();
  const { asset, status, direction, from, to } = req.query;
  if (asset) trades = trades.filter((t) => t.asset === asset);
  if (status) trades = trades.filter((t) => t.status === status);
  if (direction) trades = trades.filter((t) => t.direction === direction);
  if (from) trades = trades.filter((t) => t.entryTime >= Number(from));
  if (to) trades = trades.filter((t) => t.entryTime <= Number(to));
  res.json(trades);
});

api.get("/equity-curve", (_req, res) => {
  res.json(getEquityCurve());
});

api.get("/opportunities", (_req, res) => {
  res.json(getRecentOpportunities());
});

api.get("/regime/:asset", (req, res) => {
  const asset = req.params.asset as Asset;
  const candles = getCandles(asset, getInterval());
  res.json({ asset, regime: classifyRegime(asset, candles, Date.now()), fundingRate: getFundingRate(asset) });
});

api.get("/learning", (_req, res) => {
  res.json({ cells: getAllCellStats(), platt: getPlattParams() });
});
