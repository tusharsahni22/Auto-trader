import path from "node:path";
import fs from "node:fs";
import type { Trade, PnlPoint } from "./types.js";

/**
 * Plain-JSON persistence. Trade volume for a 2-asset swing engine is small
 * (a few thousand rows a year at most), so a flat file avoids native
 * dependencies (better-sqlite3 needs a C++ toolchain) without a real
 * durability trade-off at this scale. Swap for Postgres/Timescale per
 * docs/06-data-and-features.md if/when ingestion grows beyond this.
 */

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const FILE = path.join(DATA_DIR, "trader.json");

interface StoreShape {
  trades: Record<string, Trade>;
  equityCurve: Record<number, PnlPoint>;
  kv: Record<string, string>;
}

function load(): StoreShape {
  if (!fs.existsSync(FILE)) return { trades: {}, equityCurve: {}, kv: {} };
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf-8"));
  } catch {
    return { trades: {}, equityCurve: {}, kv: {} };
  }
}

const store: StoreShape = load();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFileSync(FILE, JSON.stringify(store));
  }, 250);
}

export function upsertTrade(t: Trade) {
  store.trades[t.id] = t;
  scheduleSave();
}

export function getTrades(): Trade[] {
  return Object.values(store.trades).sort((a, b) => b.entryTime - a.entryTime);
}

export function addEquityPoint(p: PnlPoint) {
  store.equityCurve[p.time] = p;
  scheduleSave();
}

export function getEquityCurve(): PnlPoint[] {
  return Object.values(store.equityCurve).sort((a, b) => a.time - b.time);
}

export function getKv(key: string): string | null {
  return store.kv[key] ?? null;
}

export function setKv(key: string, value: string) {
  store.kv[key] = value;
  scheduleSave();
}
