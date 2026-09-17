/**
 * Signal-bot control API.
 */

import { Router } from "express";
import {
  getBotConfig,
  getBotDecisions,
  getBotState,
  getBotStats,
  getLiveIndicators,
  runBotNow,
  startBot,
  stopBot,
  updateBotConfig,
} from "../bot/scheduler.js";
import type { Asset } from "../types.js";

export const botRouter = Router();

const VALID_ASSETS: Asset[] = ["BTCUSDT", "ETHUSDT"];

botRouter.post("/start", (_req, res) => {
  res.json({ ok: true, bot: startBot() });
});

botRouter.post("/stop", (_req, res) => {
  res.json({ ok: true, bot: stopBot() });
});

botRouter.get("/status", (_req, res) => {
  res.json({ bot: getBotState(), stats: getBotStats() });
});

/** Runs the strategy once on demand, independent of the schedule. */
botRouter.post("/run-now", async (_req, res) => {
  try {
    res.json({ ok: true, decisions: await runBotNow() });
  } catch (error: any) {
    res.status(500).json({ ok: false, error: error?.message ?? String(error) });
  }
});

botRouter.get("/config", (_req, res) => {
  res.json({ config: getBotConfig() });
});

botRouter.put("/config", (req, res) => {
  const { intervalMs, autoExecute, riskPerTrade, stopLossPct, takeProfitPct, strategy } = req.body ?? {};

  if (intervalMs !== undefined && (!Number.isFinite(intervalMs) || intervalMs < 10000)) {
    res.status(400).json({ error: "intervalMs must be at least 10000" });
    return;
  }
  if (riskPerTrade !== undefined && (!(riskPerTrade > 0) || riskPerTrade > 0.5)) {
    res.status(400).json({ error: "riskPerTrade must be between 0 and 0.5" });
    return;
  }

  res.json({
    ok: true,
    config: updateBotConfig({ intervalMs, autoExecute, riskPerTrade, stopLossPct, takeProfitPct, strategy }),
  });
});

/** Decision history — the bot's own log, separate from executed trades. */
botRouter.get("/decisions", (req, res) => {
  const asset = VALID_ASSETS.includes(req.query.asset as Asset) ? (req.query.asset as Asset) : undefined;
  const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 200);
  res.json({ decisions: getBotDecisions(limit, asset) });
});

botRouter.get("/indicators", async (_req, res) => {
  try {
    res.json({ indicators: await getLiveIndicators() });
  } catch (error: any) {
    res.status(500).json({ error: error?.message ?? String(error) });
  }
});
