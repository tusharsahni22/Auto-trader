import { getKv, getTrades, setKv } from "../db.js";
import type { Trade } from "../types.js";

/**
 * Persistent activity statistics: how many scans ran, how many setups (opportunities) the
 * engine found, what it decided about each, and which trades were actually taken — per day,
 * rolled up to week and month. Kept in the ledger's key/value store so it survives restarts.
 */

const DAILY_KEY = "activity_daily_v1";
const LOG_KEY = "opp_log_v1";
const MAX_LOG = 3000;

export interface LoggedOpportunity {
  id: string;
  time: number;
  asset: string;
  direction: string;
  archetype: string;
  regime: string;
  decision: string;
  vetoReasons: string[];
  vetoDetails?: string[];
  setupReason?: string;
  calibratedWinProb: number;
  evNetR: number;
}

interface DayCounters {
  scans: number; // candle evaluations (per asset)
  noSetup: number; // evaluations where no detector fired
  opportunities: number; // setups found
  open: number;
  watch: number;
  veto: number;
  byArchetype: Record<string, { found: number; open: number }>;
  byAsset: Record<string, number>;
  byDirection: { LONG: number; SHORT: number };
  vetoReasons: Record<string, number>;
}

function emptyDay(): DayCounters {
  return { scans: 0, noSetup: 0, opportunities: 0, open: 0, watch: 0, veto: 0, byArchetype: {}, byAsset: {}, byDirection: { LONG: 0, SHORT: 0 }, vetoReasons: {} };
}

let daily: Record<string, DayCounters> | null = null;
let log: LoggedOpportunity[] | null = null;

function loadDaily(): Record<string, DayCounters> {
  if (daily) return daily;
  try {
    daily = JSON.parse(getKv(DAILY_KEY) ?? "{}");
  } catch {
    daily = {};
  }
  return daily!;
}

function loadLog(): LoggedOpportunity[] {
  if (log) return log;
  try {
    log = JSON.parse(getKv(LOG_KEY) ?? "[]");
  } catch {
    log = [];
  }
  return log!;
}

/** Re-read from the ledger (called after MongoDB hydration replaces the store). */
export function reloadActivity() {
  daily = null;
  log = null;
}

/** Local calendar date, so a "day" matches the trader's clock rather than UTC. */
export function dateKey(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dayFor(ms: number): DayCounters {
  const all = loadDaily();
  const key = dateKey(ms);
  return (all[key] ??= emptyDay());
}

function saveDaily() {
  setKv(DAILY_KEY, JSON.stringify(loadDaily()));
}

export function recordScan(hadSetup: boolean) {
  const day = dayFor(Date.now());
  day.scans++;
  if (!hadSetup) day.noSetup++;
  saveDaily();
}

export function recordOpportunity(o: LoggedOpportunity) {
  const day = dayFor(o.time);
  day.opportunities++;
  if (o.decision === "OPEN") day.open++;
  else if (o.decision === "WATCH") day.watch++;
  else day.veto++;

  const arch = (day.byArchetype[o.archetype] ??= { found: 0, open: 0 });
  arch.found++;
  if (o.decision === "OPEN") arch.open++;
  day.byAsset[o.asset] = (day.byAsset[o.asset] ?? 0) + 1;
  if (o.direction === "LONG" || o.direction === "SHORT") day.byDirection[o.direction]++;
  if (o.decision !== "OPEN") {
    for (const code of o.vetoReasons) {
      if (code.startsWith("FEED_SOURCE")) continue;
      const key = code.startsWith("EXTREME_FUNDING") ? "EXTREME_FUNDING" : code;
      day.vetoReasons[key] = (day.vetoReasons[key] ?? 0) + 1;
    }
  }
  saveDaily();

  const entries = loadLog();
  entries.unshift(o);
  if (entries.length > MAX_LOG) entries.length = MAX_LOG;
  setKv(LOG_KEY, JSON.stringify(entries));
}

/** Most recent logged opportunities, newest first (used to refill the live feed after a restart). */
export function recentLoggedOpportunities(limit: number): LoggedOpportunity[] {
  return loadLog().slice(0, limit);
}

export function opportunitiesOnDay(date: string): LoggedOpportunity[] {
  return loadLog().filter((o) => dateKey(o.time) === date);
}

// ── Trade-derived numbers (from the ledger, so they always match the trade list) ──────────

interface TradeCounters {
  tradesOpened: number;
  tradesClosed: number;
  wins: number;
  losses: number;
  pnlUsd: number;
  exitReasons: Record<string, number>;
}

function emptyTrades(): TradeCounters {
  return { tradesOpened: 0, tradesClosed: 0, wins: 0, losses: 0, pnlUsd: 0, exitReasons: {} };
}

function tradeCountersByDay(trades: Trade[]): Record<string, TradeCounters> {
  const out: Record<string, TradeCounters> = {};
  for (const t of trades) {
    (out[dateKey(t.entryTime)] ??= emptyTrades()).tradesOpened++;
    if (t.status === "CLOSED" && t.exitTime) {
      const c = (out[dateKey(t.exitTime)] ??= emptyTrades());
      c.tradesClosed++;
      const pnl = t.pnlUsd ?? t.realizedPnlUsd;
      c.pnlUsd += pnl;
      if (pnl > 0) c.wins++;
      else c.losses++;
      const reason = t.exitReason ?? "UNKNOWN";
      c.exitReasons[reason] = (c.exitReasons[reason] ?? 0) + 1;
    }
  }
  return out;
}

// ── Roll-ups ────────────────────────────────────────────────────────────────────────────

export interface ActivityRow extends DayCounters, TradeCounters {
  key: string;
  label: string;
  /** Finer rows inside this one (days inside a week or month). */
  children?: ActivityRow[];
}

function merge(target: ActivityRow, source: ActivityRow) {
  target.scans += source.scans;
  target.noSetup += source.noSetup;
  target.opportunities += source.opportunities;
  target.open += source.open;
  target.watch += source.watch;
  target.veto += source.veto;
  target.byDirection.LONG += source.byDirection.LONG;
  target.byDirection.SHORT += source.byDirection.SHORT;
  for (const [k, v] of Object.entries(source.byAsset)) target.byAsset[k] = (target.byAsset[k] ?? 0) + v;
  for (const [k, v] of Object.entries(source.vetoReasons)) target.vetoReasons[k] = (target.vetoReasons[k] ?? 0) + v;
  for (const [k, v] of Object.entries(source.byArchetype)) {
    const a = (target.byArchetype[k] ??= { found: 0, open: 0 });
    a.found += v.found;
    a.open += v.open;
  }
  target.tradesOpened += source.tradesOpened;
  target.tradesClosed += source.tradesClosed;
  target.wins += source.wins;
  target.losses += source.losses;
  target.pnlUsd += source.pnlUsd;
  for (const [k, v] of Object.entries(source.exitReasons)) target.exitReasons[k] = (target.exitReasons[k] ?? 0) + v;
}

function blankRow(key: string, label: string): ActivityRow {
  return { key, label, ...emptyDay(), ...emptyTrades() };
}

/** Monday-start week containing this local date. */
function weekStart(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const offset = (dt.getDay() + 6) % 7; // Monday = 0
  dt.setDate(dt.getDate() - offset);
  return dateKey(dt.getTime());
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function dayLabel(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return `${dt.toLocaleDateString(undefined, { weekday: "short" })} ${d} ${MONTHS[m - 1]}`;
}

export function getActivity(days = 90) {
  const counters = loadDaily();
  const tradeDays = tradeCountersByDay(getTrades());
  const cutoff = dateKey(Date.now() - days * 86_400_000);

  const dates = [...new Set([...Object.keys(counters), ...Object.keys(tradeDays)])].filter((d) => d >= cutoff).sort().reverse();

  const dayRows: ActivityRow[] = dates.map((date) => {
    const row = blankRow(date, dayLabel(date));
    merge(row, { ...blankRow(date, ""), ...(counters[date] ?? emptyDay()), ...(tradeDays[date] ?? emptyTrades()) });
    return row;
  });

  const weeks = new Map<string, ActivityRow>();
  const months = new Map<string, ActivityRow>();
  for (const day of dayRows) {
    const wk = weekStart(day.key);
    const week = weeks.get(wk) ?? blankRow(wk, `Week of ${dayLabel(wk).replace(/^\w+ /, "")}`);
    week.children ??= [];
    week.children.push(day);
    merge(week, day);
    weeks.set(wk, week);

    const mk = day.key.slice(0, 7);
    const [y, m] = mk.split("-").map(Number);
    const month = months.get(mk) ?? blankRow(mk, `${MONTHS[m - 1]} ${y}`);
    month.children ??= [];
    month.children.push(day);
    merge(month, day);
    months.set(mk, month);
  }

  const total = blankRow("total", "All time in range");
  for (const day of dayRows) merge(total, day);

  return {
    days: dayRows,
    weeks: [...weeks.values()].sort((a, b) => b.key.localeCompare(a.key)),
    months: [...months.values()].sort((a, b) => b.key.localeCompare(a.key)),
    total,
  };
}

export function getDayDetail(date: string) {
  const tradesOpened = getTrades()
    .filter((t) => dateKey(t.entryTime) === date)
    .map((t) => ({
      id: t.id, asset: t.asset, direction: t.direction, archetype: t.archetype, entryTime: t.entryTime, entryPrice: t.entryPrice,
      status: t.status, exitReason: t.exitReason, pnlUsd: t.pnlUsd ?? t.realizedPnlUsd,
    }));
  return { date, opportunities: opportunitiesOnDay(date), trades: tradesOpened };
}
