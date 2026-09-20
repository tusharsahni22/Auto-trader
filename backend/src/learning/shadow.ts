import { randomUUID } from "node:crypto";
import type { Candle } from "../types.js";
import type { PipelineOutput } from "../decision/pipeline.js";
import { getKv, setKv } from "../db.js";
import { recordOutcome } from "./stats.js";
import { appendOutcome } from "./outcomeLog.js";
import { refitCalibration } from "../decision/calibration.js";

/**
 * Shadow trades — every setup the engine tracked but did NOT trade (VETO/WATCH)
 * is followed forward on real candles with the same stop/target ladder a live
 * trade would use. When it resolves, its net-of-cost R feeds the same
 * calibration stats as real trades.
 *
 * Why: the engine's win-probability is a per-(archetype, regime) base rate. With
 * only a handful of real trades that base rate is meaningless, and vetoed setups
 * never produce data, so calibration could never leave cold start. Shadow
 * outcomes give it honest data without risking money.
 */

interface Shadow {
  id: string;
  asset: string;
  archetype: string;
  regime: string;
  direction: "LONG" | "SHORT";
  entryPrice: number;
  stopPrice: number;
  /** Current stop after breakeven moves; stopPrice stays the original for R maths. */
  curStop?: number;
  targets: { price: number; fraction: number }[];
  entryTimeSec: number;
  maxHoldHours: number;
  costR: number;
  rawScore: number;
  remaining: number;
  realizedR: number;
  hit: number[];
  breakeven: boolean;
  lastCandleTime: number;
}

export interface ShadowResult {
  id: string;
  asset: string;
  archetype: string;
  direction: string;
  regime: string;
  netR: number;
  closedAt: number;
}

const OPEN_KEY = "shadow_open_v1";
const DONE_KEY = "shadow_done_v1";
const MAX_OPEN = 200;
const MAX_DONE = 300;

function load<T>(key: string): T[] {
  const raw = getKv(key);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as T[];
  } catch {
    return [];
  }
}

export function openShadow(asset: string, out: PipelineOutput, candles: Candle[]) {
  const c = out.candidate;
  if (!c || candles.length < 2) return;
  const stopDist = Math.abs(c.entryPrice - c.stopPrice);
  if (stopDist <= 0) return;

  const shadows = load<Shadow>(OPEN_KEY);
  shadows.push({
    id: randomUUID(),
    asset,
    archetype: c.archetype,
    regime: out.regime.label,
    direction: c.direction,
    entryPrice: c.entryPrice,
    stopPrice: c.stopPrice,
    targets: c.targets.map((t) => ({ price: t.price, fraction: t.fraction })),
    entryTimeSec: candles[candles.length - 1].time,
    maxHoldHours: c.maxHoldHours,
    costR: out.costBreakdown?.totalR ?? 0,
    rawScore: out.rawScore ?? 0.5,
    remaining: 1,
    realizedR: 0,
    hit: [],
    breakeven: false,
    // The forming candle is processed once it closes, so it is not skipped.
    lastCandleTime: candles[candles.length - 2].time,
  });
  if (shadows.length > MAX_OPEN) shadows.splice(0, shadows.length - MAX_OPEN);
  setKv(OPEN_KEY, JSON.stringify(shadows));
}

/** Advances this asset's shadow trades over any newly closed candles. */
export function updateShadows(asset: string, candles: Candle[]) {
  if (candles.length < 2) return;
  const shadows = load<Shadow>(OPEN_KEY);
  if (!shadows.some((s) => s.asset === asset)) return;

  const closed = candles.slice(0, -1); // last candle is still forming
  const finished: ShadowResult[] = [];
  const stillOpen: Shadow[] = [];

  for (const s of shadows) {
    if (s.asset !== asset) {
      stillOpen.push(s);
      continue;
    }
    const dir = s.direction === "LONG" ? 1 : -1;
    const stopDist = Math.abs(s.entryPrice - s.stopPrice);
    let stop = s.curStop ?? s.stopPrice;
    let done = false;

    for (const bar of closed) {
      if (bar.time <= s.lastCandleTime) continue;
      s.lastCandleTime = bar.time;

      // Stop is checked first: when a bar touches both levels the outcome is unknowable, so assume the worse one.
      const stopHit = dir === 1 ? bar.low <= stop : bar.high >= stop;
      if (stopHit) {
        s.realizedR += (s.remaining * ((stop - s.entryPrice) * dir)) / stopDist;
        s.remaining = 0;
        done = true;
        break;
      }
      s.targets.forEach((t, i) => {
        if (s.hit.includes(i)) return;
        const reached = dir === 1 ? bar.high >= t.price : bar.low <= t.price;
        if (!reached) return;
        s.realizedR += (t.fraction * ((t.price - s.entryPrice) * dir)) / stopDist;
        s.remaining -= t.fraction;
        s.hit.push(i);
        if (!s.breakeven) {
          s.breakeven = true;
          stop = dir === 1 ? Math.max(stop, s.entryPrice) : Math.min(stop, s.entryPrice);
        }
      });
      if (s.remaining <= 1e-6) {
        done = true;
        break;
      }
      if (bar.time - s.entryTimeSec > s.maxHoldHours * 3600) {
        s.realizedR += (s.remaining * ((bar.close - s.entryPrice) * dir)) / stopDist;
        s.remaining = 0;
        done = true;
        break;
      }
    }

    if (!done) {
      s.curStop = stop; // persist a breakeven move for the next pass
      stillOpen.push(s);
      continue;
    }

    const netR = s.realizedR - s.costR;
    finished.push({ id: s.id, asset: s.asset, archetype: s.archetype, direction: s.direction, regime: s.regime, netR, closedAt: Date.now() });
    recordOutcome(s.archetype as any, s.regime as any, netR > 0, netR);
    appendOutcome({ rawScore: s.rawScore, win: netR > 0, tradeId: `shadow:${s.id}` });
  }

  setKv(OPEN_KEY, JSON.stringify(stillOpen));
  if (finished.length > 0) {
    const done = [...finished, ...load<ShadowResult>(DONE_KEY)].slice(0, MAX_DONE);
    setKv(DONE_KEY, JSON.stringify(done));
    refitCalibration();
  }
}

export function getShadowSummary() {
  const open = load<Shadow>(OPEN_KEY);
  const done = load<ShadowResult>(DONE_KEY);
  const byKey: Record<string, { n: number; wins: number; sumNetR: number }> = {};
  for (const r of done) {
    const k = `${r.archetype} ${r.direction}`;
    const t = (byKey[k] ??= { n: 0, wins: 0, sumNetR: 0 });
    t.n++;
    if (r.netR > 0) t.wins++;
    t.sumNetR += r.netR;
  }
  return {
    open: open.length,
    resolved: done.length,
    bySetup: Object.entries(byKey).map(([setup, t]) => ({ setup, n: t.n, winRate: t.wins / t.n, avgNetR: t.sumNetR / t.n })),
    recent: done.slice(0, 20),
  };
}
