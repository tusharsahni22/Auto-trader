import { Router } from "express";
import { getTrades, refreshLedger, getLedgerHealth } from "../db.js";
import { getLastPrice } from "../marketData.js";
import { getActivity, dateKey } from "../stats/activity.js";
import { chargesFor } from "../services/tradeCharges.js";
import { chargeConfig, effectiveIncomeTaxRate, financialYear, taxSummary } from "../services/charges.js";
import { getFeeRates, rateProvenance } from "../services/rates.js";
import type { Trade } from "../types.js";

/**
 * Read-only analytics for the dashboard: daily P&L, decision mix, win/loss,
 * performance, order history, the training monitor and the India tax position.
 *
 * Everything is derived from the ledger and the activity counters at request
 * time. Nothing is cached and nothing here can place, change or cancel an order.
 */
export const analyticsRouter = Router();

const closedOf = (trades: Trade[]) => trades.filter((t) => t.status === "CLOSED");

/** Net P&L after exchange fees, GST and TDS — the number that actually hit the wallet. */
function netPnl(trade: Trade): number {
  const charges = trade.charges ?? chargesFor(trade);
  return charges.netPnlUsd;
}

function grossPnl(trade: Trade): number {
  return trade.status === "CLOSED" ? trade.pnlUsd ?? trade.realizedPnlUsd : trade.realizedPnlUsd;
}

/** Contracts if the trade reached Delta, else the coin quantity it was sized for. */
function lots(trade: Trade): number | null {
  return trade.execution?.contracts ?? null;
}

analyticsRouter.get("/summary", async (_req, res) => {
  await refreshLedger();
  const trades = getTrades();
  const closed = closedOf(trades);
  const open = trades.filter((t) => t.status === "OPEN");

  const nets = closed.map(netPnl);
  const wins = nets.filter((p) => p > 0);
  const losses = nets.filter((p) => p <= 0);
  const grossWin = wins.reduce((s, p) => s + p, 0);
  const grossLoss = Math.abs(losses.reduce((s, p) => s + p, 0));

  const totalCharges = closed.reduce((s, t) => s + (t.charges ?? chargesFor(t)).totalUsd, 0);

  // Unrealised P&L on what is still open, marked against the live price.
  const openMarks = open.map((t) => {
    const mark = getLastPrice(t.asset);
    const c = chargesFor(t, mark ?? undefined);
    return { id: t.id, asset: t.asset, unrealizedNetUsd: mark === null ? 0 : c.netPnlUsd, mark };
  });

  const today = dateKey(Date.now());
  const todayNet = closed
    .filter((t) => t.exitTime && dateKey(t.exitTime) === today)
    .reduce((s, t) => s + netPnl(t), 0);

  const monthPrefix = today.slice(0, 7);
  const monthNet = closed
    .filter((t) => t.exitTime && dateKey(t.exitTime).startsWith(monthPrefix))
    .reduce((s, t) => s + netPnl(t), 0);

  res.json({
    performance: {
      totalTrades: trades.length,
      openTrades: open.length,
      closedTrades: closed.length,
      wins: wins.length,
      losses: losses.length,
      winRate: closed.length ? wins.length / closed.length : 0,
      netPnlUsd: nets.reduce((s, p) => s + p, 0),
      grossPnlUsd: closed.reduce((s, t) => s + grossPnl(t), 0),
      totalChargesUsd: totalCharges,
      avgWinUsd: wins.length ? grossWin / wins.length : 0,
      avgLossUsd: losses.length ? -grossLoss / losses.length : 0,
      bestTradeUsd: nets.length ? Math.max(...nets) : 0,
      worstTradeUsd: nets.length ? Math.min(...nets) : 0,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
      avgRMultiple: closed.length ? closed.reduce((s, t) => s + (t.rMultiple ?? 0), 0) / closed.length : 0,
      expectancyUsd: closed.length ? nets.reduce((s, p) => s + p, 0) / closed.length : 0,
      todayNetUsd: todayNet,
      monthNetUsd: monthNet,
      unrealizedNetUsd: openMarks.reduce((s, o) => s + o.unrealizedNetUsd, 0),
    },
    openPositions: openMarks,
    ledger: await getLedgerHealth(),
  });
});

/**
 * Per-day realised P&L, for the Analytics & Progress bars. Days are keyed by the
 * EXIT date because that is when the money moved.
 */
analyticsRouter.get("/daily", async (req, res) => {
  await refreshLedger();
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 60));
  const cutoff = Date.now() - days * 86_400_000;

  const byDay = new Map<string, { date: string; netUsd: number; grossUsd: number; chargesUsd: number; trades: number; wins: number; losses: number }>();
  for (const t of closedOf(getTrades())) {
    if (!t.exitTime || t.exitTime < cutoff) continue;
    const key = dateKey(t.exitTime);
    const row = byDay.get(key) ?? { date: key, netUsd: 0, grossUsd: 0, chargesUsd: 0, trades: 0, wins: 0, losses: 0 };
    const charges = t.charges ?? chargesFor(t);
    row.netUsd += charges.netPnlUsd;
    row.grossUsd += grossPnl(t);
    row.chargesUsd += charges.totalUsd;
    row.trades++;
    if (charges.netPnlUsd > 0) row.wins++;
    else row.losses++;
    byDay.set(key, row);
  }

  const rows = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
  let cumulative = 0;
  res.json({
    days: rows.map((r) => ({ ...r, cumulativeUsd: (cumulative += r.netUsd) })),
    bestDayUsd: rows.length ? Math.max(...rows.map((r) => r.netUsd)) : 0,
    worstDayUsd: rows.length ? Math.min(...rows.map((r) => r.netUsd)) : 0,
    profitableDays: rows.filter((r) => r.netUsd > 0).length,
    losingDays: rows.filter((r) => r.netUsd < 0).length,
  });
});

/**
 * Decision mix: what the engine did with everything it looked at.
 * "Hold" here means a scan that produced no setup at all, which is most of them —
 * without it the mix would imply the engine rejects far more than it really sees.
 */
analyticsRouter.get("/decision-mix", (req, res) => {
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  const activity = getActivity(days);
  const t = activity.total;

  res.json({
    windowDays: days,
    mix: [
      { label: "Opened", value: t.open, tone: "bull" },
      { label: "Watching", value: t.watch, tone: "warn" },
      { label: "Vetoed", value: t.veto, tone: "bear" },
      { label: "No setup", value: t.noSetup, tone: "muted" },
    ],
    totals: {
      scans: t.scans,
      opportunities: t.opportunities,
      open: t.open,
      watch: t.watch,
      veto: t.veto,
      noSetup: t.noSetup,
      long: t.byDirection.LONG,
      short: t.byDirection.SHORT,
    },
    /** Why setups were refused, biggest cause first — the "trades not taken" list. */
    blockedBy: Object.entries(t.vetoReasons)
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
    byArchetype: Object.entries(t.byArchetype)
      .map(([archetype, v]) => ({ archetype, found: v.found, open: v.open }))
      .sort((a, b) => b.found - a.found),
    byAsset: Object.entries(t.byAsset).map(([asset, count]) => ({ asset, count })),
  });
});

/** One row per trade for the order-history table, newest first, paged. */
analyticsRouter.get("/orders", async (req, res) => {
  await refreshLedger();
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(5, Number(req.query.pageSize) || 10));

  let trades = getTrades();
  if (req.query.asset) trades = trades.filter((t) => t.asset === req.query.asset);
  if (req.query.status) trades = trades.filter((t) => t.status === req.query.status);
  if (req.query.direction) trades = trades.filter((t) => t.direction === req.query.direction);

  // Cumulative P&L runs oldest-to-newest so the column means "balance after this trade",
  // then the page is taken from the newest end.
  const chronological = [...trades].sort((a, b) => a.entryTime - b.entryTime);
  let running = 0;
  const cumulative = new Map<string, number>();
  for (const t of chronological) {
    if (t.status === "CLOSED") running += netPnl(t);
    cumulative.set(t.id, running);
  }

  const rows = trades.map((t) => {
    const charges = t.charges ?? chargesFor(t, getLastPrice(t.asset) ?? undefined);
    return {
      id: t.id,
      asset: t.asset,
      direction: t.direction,
      archetype: t.archetype,
      regime: t.regime,
      openedAt: t.entryTime,
      closedAt: t.exitTime,
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      lots: lots(t),
      quantity: t.initialQuantity,
      notionalUsd: t.entryPrice * t.initialQuantity,
      status: t.status,
      venue: t.execution?.venue ?? "SIMULATED",
      executionStatus: t.execution?.status ?? "SIMULATED",
      reason: t.reason,
      exitReason: t.exitReason,
      grossPnlUsd: grossPnl(t),
      chargesUsd: charges.totalUsd,
      netPnlUsd: t.status === "CLOSED" ? charges.netPnlUsd : null,
      pnlPct: t.pnlPct,
      rMultiple: t.rMultiple,
      cumulativeNetUsd: cumulative.get(t.id) ?? 0,
      charges,
    };
  });

  res.json({
    page,
    pageSize,
    total: rows.length,
    totalPages: Math.max(1, Math.ceil(rows.length / pageSize)),
    rows: rows.slice((page - 1) * pageSize, page * pageSize),
  });
});

/**
 * Training monitor: how much of the strategy's theoretical edge survives execution.
 *
 * Strategy P&L is what the decision was worth at the prices the engine decided on.
 * Execution P&L is what the fills actually produced. The gap is the cost of reaching
 * the exchange — slippage plus fees — and it is the number that decides whether a
 * marginally-positive strategy is worth running at all.
 */
analyticsRouter.get("/training", async (_req, res) => {
  await refreshLedger();
  const trades = getTrades();
  const closed = closedOf(trades);

  const strategyPnl = closed.reduce((s, t) => s + grossPnl(t), 0);
  const executionPnl = closed.reduce((s, t) => s + netPnl(t), 0);
  const chargeCost = closed.reduce((s, t) => s + (t.charges ?? chargesFor(t)).totalUsd, 0);

  // Entry slippage: what the fill cost versus the price the decision was made at.
  const slipped = trades.filter((t) => t.execution?.priceShift !== undefined && t.execution.priceShift !== 0);
  const slippageUsd = slipped.reduce((s, t) => {
    const shift = t.execution!.priceShift!;
    const adverse = t.direction === "LONG" ? shift : -shift; // paying up is adverse either way
    return s - adverse * t.initialQuantity;
  }, 0);

  const scored = closed.filter((t) => Number.isFinite(t.calibratedWinProb));
  const decisionWinRate = scored.length ? scored.filter((t) => netPnl(t) > 0).length / scored.length : 0;
  const predictedWinRate = scored.length ? scored.reduce((s, t) => s + t.calibratedWinProb, 0) / scored.length : 0;

  const activity = getActivity(30);

  res.json({
    strategyPnlUsd: strategyPnl,
    executionPnlUsd: executionPnl,
    chargeCostUsd: chargeCost,
    slippageUsd,
    /** Everything lost between the decision and the wallet. */
    executionGapUsd: strategyPnl - executionPnl,
    decisionWinRate,
    predictedWinRate,
    /**
     * Above zero means the engine is over-confident: it predicted a higher win rate
     * than it delivered. The calibration layer uses this signal to shrink scores.
     */
    calibrationGap: predictedWinRate - decisionWinRate,
    scoredTrades: scored.length,
    unscoredTrades: closed.length - scored.length,
    liveTrades: trades.filter((t) => t.execution?.venue === "DELTA").length,
    simulatedTrades: trades.filter((t) => t.execution?.venue !== "DELTA").length,
    blockedLast30d: Object.entries(activity.total.vetoReasons)
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
    recentClosed: closed.slice(0, 12).map((t) => {
      const charges = t.charges ?? chargesFor(t);
      return {
        id: t.id,
        asset: t.asset,
        direction: t.direction,
        closedAt: t.exitTime,
        entryPrice: t.entryPrice,
        exitPrice: t.exitPrice,
        grossPnlUsd: grossPnl(t),
        chargesUsd: charges.totalUsd,
        netPnlUsd: charges.netPnlUsd,
        slippage: t.execution?.priceShift ?? null,
        exitReason: t.exitReason,
      };
    }),
  });
});

/**
 * India tax position. Section 115BBH taxes each gain at 30% plus 4% cess and does
 * not let losses offset gains, so the taxable base is the winners alone — netting
 * first would understate what is owed.
 */
analyticsRouter.get("/tax", async (req, res) => {
  await refreshLedger();
  const closed = closedOf(getTrades()).filter((t) => t.exitTime);
  const fy = String(req.query.fy ?? financialYear(Date.now()));
  const inYear = closed.filter((t) => financialYear(t.exitTime!) === fy);

  const summary = taxSummary(inYear.map(netPnl));
  const charges = inYear.map((t) => t.charges ?? chargesFor(t));

  res.json({
    financialYear: fy,
    availableYears: [...new Set(closed.map((t) => financialYear(t.exitTime!)))].sort().reverse(),
    ...summary,
    charges: {
      tradingFeeUsd: charges.reduce((s, c) => s + c.entry.feeUsd + c.exit.feeUsd, 0),
      gstUsd: charges.reduce((s, c) => s + c.entry.gstUsd + c.exit.gstUsd, 0),
      tdsUsd: charges.reduce((s, c) => s + c.entry.tdsUsd + c.exit.tdsUsd, 0),
      totalUsd: charges.reduce((s, c) => s + c.totalUsd, 0),
    },
    rates: {
      ...getFeeRates(),
      gstRate: chargeConfig.gstRate,
      tdsRate: chargeConfig.tdsRate,
      incomeTaxRate: chargeConfig.incomeTaxRate,
      cessRate: chargeConfig.cessRate,
      effectiveIncomeTaxRate: effectiveIncomeTaxRate(),
      usdInr: chargeConfig.usdInr,
    },
    /** Where each rate came from: a live feed, or the configured fallback. */
    provenance: rateProvenance(),
    estimated: charges.some((c) => c.estimated),
  });
});
