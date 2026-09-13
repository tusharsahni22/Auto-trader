import { getKv, setKv } from "../db.js";
import { getTrades } from "../db.js";
import type { Archetype, Regime } from "../decision/types.js";

/**
 * docs/01 §3.2 (archetype x regime expectancy) + §6 (calibration params),
 * refit by docs/07's "learning loop" every time a trade closes (see
 * learning/recalibrate.ts). Persisted as one JSON blob in the kv store —
 * plenty for the trade volumes this MVP will ever see locally.
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

function load(): StatsBlob {
  const raw = getKv(KEY);
  if (!raw) return { cells: {}, platt: null };
  try {
    return JSON.parse(raw);
  } catch {
    return { cells: {}, platt: null };
  }
}

function save(blob: StatsBlob) {
  setKv(KEY, JSON.stringify(blob));
}

function cellKey(archetype: Archetype, regime: Regime): string {
  return `${archetype}:${regime}`;
}

export function getArchetypeRegimeStats(archetype: Archetype, regime: Regime): CellStats | null {
  const blob = load();
  return blob.cells[cellKey(archetype, regime)] ?? null;
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
