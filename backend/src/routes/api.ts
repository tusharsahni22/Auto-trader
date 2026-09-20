import { Router } from "express";
import { getCandles, getFundingRate } from "../marketData.js";
import { closeTradeManually, forceOpenTrade, getAssets, getBalanceInfo, getEngineState, getEquityCurve, getInterval, getLastScans, getOpenPositions, getRecentOpportunities, getShadowSummary, getSharedEngineState, reconcileDeltaPositions, startEngine, stopEngine, syncEngineFromLedger, updateTradeStop } from "../engine/index.js";
import { getEngineRole, getTrades, refreshLedger } from "../db.js";
import { classifyRegime } from "../decision/regime.js";
import { getAllCellStats, getPlattParams } from "../learning/stats.js";
import { newsCalendarRouter } from "./newsCalendar.js";
import { agentsRouter } from "./agents.js";
import { manualTradeRouter } from "./manualTrade.js";
import { botRouter } from "./bot.js";
import { marketRouter } from "./market.js";
import type { Asset, Direction } from "../types.js";
import { acquireEngineLease } from "../db.js";
import { getActivity, getDayDetail } from "../stats/activity.js";
import { getDeltaConnectionInfo } from "../services/deltaExchange.js";

export const api = Router();

// Mount news calendar routes
api.use("/news-calendar", newsCalendarRouter);

// Mount agent management routes
api.use("/agents", agentsRouter);

// Mount manual trade entry routes
api.use("/manual-trade", manualTradeRouter);

// Mount signal-bot control routes
api.use("/bot", botRouter);

// Mount market data routes
api.use("/market", marketRouter);

api.get("/status", async (_req, res) => {
  res.json({ engine: await getSharedEngineState(), role: getEngineRole(), delta: getDeltaConnectionInfo(), assets: getAssets(), interval: getInterval(), scans: getLastScans() });
});

api.post("/engine/start", async (_req, res) => {
  const lease = await acquireEngineLease();
  if (!lease.ok) {
    res.status(409).json({ ok: false, error: `Engine is controlled by the leader instance (${lease.owner ?? "unknown"})` });
    return;
  }
  startEngine();
  res.json({ ok: true, engine: getEngineState() });
});

api.post("/engine/stop", (_req, res) => {
  if (!getEngineRole().isLeader) {
    res.status(409).json({ ok: false, error: `Engine is controlled by the leader instance (${getEngineRole().leaderId})` });
    return;
  }
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

api.get("/trades", async (req, res) => {
  await refreshLedger();
  let trades = getTrades();
  const { asset, status, direction, from, to } = req.query;
  if (asset) trades = trades.filter((t) => t.asset === asset);
  if (status) trades = trades.filter((t) => t.status === status);
  if (direction) trades = trades.filter((t) => t.direction === direction);
  if (from) trades = trades.filter((t) => t.entryTime >= Number(from));
  if (to) trades = trades.filter((t) => t.entryTime <= Number(to));
  res.json(trades);
});

api.get("/positions", async (_req, res) => {
  await syncEngineFromLedger();
  const positions = getOpenPositions();
  res.json({
    positions,
    totalUnrealized: positions.reduce((sum, p) => sum + p.unrealized, 0),
  });
});

api.post("/reconcile", async (_req, res) => {
  await reconcileDeltaPositions();
  res.json({ ok: true, positions: getOpenPositions() });
});

api.post("/positions/:id/close", (req, res) => {
  const result = closeTradeManually(req.params.id);
  if (!result.ok) {
    res.status(409).json(result);
    return;
  }
  res.json({ ok: true, trade: result.trade });
});

api.put("/positions/:id/stop", (req, res) => {
  const stopPrice = Number(req.body?.stopPrice);
  const result = updateTradeStop(req.params.id, stopPrice);
  if (!result.ok) {
    res.status(400).json(result);
    return;
  }
  res.json({ ok: true, trade: result.trade });
});

api.get("/trades/stats", async (_req, res) => {
  await refreshLedger();
  const trades = getTrades();
  const closed = trades.filter((t) => t.status === "CLOSED");
  const wins = closed.filter((t) => (t.pnlUsd ?? 0) > 0);
  const losses = closed.filter((t) => (t.pnlUsd ?? 0) < 0);
  const grossWin = wins.reduce((sum, t) => sum + (t.pnlUsd ?? 0), 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + (t.pnlUsd ?? 0), 0));

  res.json({
    total: trades.length,
    open: trades.filter((t) => t.status === "OPEN").length,
    closed: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length ? wins.length / closed.length : 0,
    netPnlUsd: closed.reduce((sum, t) => sum + (t.pnlUsd ?? 0), 0),
    avgRMultiple: closed.length
      ? closed.reduce((sum, t) => sum + (t.rMultiple ?? 0), 0) / closed.length
      : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
  });
});

api.get("/equity-curve", async (_req, res) => {
  await refreshLedger();
  res.json(getEquityCurve());
});

api.get("/balance", async (_req, res) => {
  res.json(await getBalanceInfo());
});

api.get("/activity", (req, res) => {
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 90));
  res.json(getActivity(days));
});

api.get("/activity/day", (req, res) => {
  const date = String(req.query.date ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: "date must be YYYY-MM-DD" });
    return;
  }
  res.json(getDayDetail(date));
});

api.get("/shadow", (_req, res) => {
  res.json(getShadowSummary());
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
