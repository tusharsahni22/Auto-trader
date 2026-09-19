import { getKv, setKv } from "../db.js";
import { getTrades } from "../db.js";
import type { Archetype, Regime } from "../decision/types.js";

/**
 * docs/01 §3.2 (archetype x regime expectancy) + §6 (calibration params),
 * refit by docs/07's "learning loop" every time a trade closes (see
 * learning/recalibrate.ts). Persisted as one JSON blob in the kv store —
 * plenty for the trade volumes this MVP will ever see locally.
 *
 * FIX: Previously every call to getArchetypeRegimeStats() called load()
 * which called getKv() + JSON.parse() on the full blob. This is called on
 * every candle evaluation inside ensemble.ts -> pipeline.ts, meaning it
 * re-parsed a growing JSON blob thousands of times per minute. Now the blob
 * is cached in memory and only reloaded after a write.
 */

export interface CellStats {
  n: number;
  wins: number;
  winRate: number;
  sumR: number;
  meanR: number;
}

interface StatsBlob {
  cells: Record<string, CellStats>;
  platt: { a: number; b: number; n: number; fittedAt: number } | null;
}

const KEY = "learning_stats_v1";

// In-memory cache — single source of truth after first load.
let _cache: StatsBlob | null = null;

function load(): StatsBlob {
  if (_cache !== null) return _cache;
  const raw = getKv(KEY);
  if (!raw) {
    _cache = { cells: {}, platt: null };
    return _cache;
  }
  try {
    _cache = JSON.parse(raw);
    return _cache!;
  } catch {
    _cache = { cells: {}, platt: null };
    return _cache;
  }
}

function save(blob: StatsBlob) {
  _cache = blob; // update cache before writing so readers see it immediately
  setKv(KEY, JSON.stringify(blob));
}

function cellKey(archetype: Archetype, regime: Regime): string {
  return `${archetype}:${regime}`;
}

export function getArchetypeRegimeStats(archetype: Archetype, regime: Regime): CellStats | null {
  return load().cells[cellKey(archetype, regime)] ?? null;
}

export function recordOutcome(archetype: Archetype, regime: Regime, win: boolean, rMultiple: number) {
  const blob = load();
  const key = cellKey(archetype, regime);
  const existing = blob.cells[key] ?? { n: 0, wins: 0, winRate: 0.5, sumR: 0, meanR: 0 };
  const n = existing.n + 1;
  const wins = existing.wins + (win ? 1 : 0);
  const sumR = existing.sumR + rMultiple;
  blob.cells[key] = { n, wins, winRate: wins / n, sumR, meanR: sumR / n };
  save(blob);
}

export function getPlattParams(): { a: number; b: number; n: number } | null {
  return load().platt;
}

export function getPlattFittedAt(): number | null {
  return load().platt?.fittedAt ?? null;
}

export function setPlattParams(a: number, b: number, n: number) {
  const blob = load();
  blob.platt = { a, b, n, fittedAt: Date.now() };
  save(blob);
}

export function getAllCellStats(): Record<string, CellStats> {
  return load().cells;
}

/** Closed trades' realized R for a given archetype — this system's stand-in "analog set" (see ev/index.ts). */
export function getClosedTradeRMultiples(archetype: Archetype): number[] {
  return getTrades()
    .filter((t) => t.status === "CLOSED" && t.archetype === archetype && t.rMultiple !== null)
    .map((t) => t.rMultiple as number);
}
