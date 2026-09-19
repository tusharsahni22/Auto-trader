import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { Trade, PnlPoint } from "./types.js";
import { getMongoConnection, isMongoConnected } from "./db/mongodb.js";

/**
 * Plain-JSON persistence. Trade volume for a 2-asset swing engine is small
 * (a few thousand rows a year at most), so a flat file avoids native
 * dependencies (better-sqlite3 needs a C++ toolchain) without a real
 * durability trade-off at this scale. Swap for Postgres/Timescale per
 * docs/06-data-and-features.md if/when ingestion grows beyond this.
 */

// FIX CONFIG 4: Use script-relative path so the data directory is always found
// regardless of which CWD Node was launched from (fixes `node backend/dist/index.js`).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "../../data");
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
let mongoReady = false;
const STATE_ID = "main";
const LEASE_ID = "engine-leader";
const INSTANCE_ID = process.env.ENGINE_INSTANCE_ID ?? "local";
const LEADER_ID = process.env.ENGINE_LEADER_ID ?? "domain";

export function getEngineRole() {
  return {
    instanceId: INSTANCE_ID,
    leaderId: LEADER_ID,
    isLeader: INSTANCE_ID === LEADER_ID,
    mongoConnected: isMongoConnected(),
  };
}

function stateCollection() {
  return getMongoConnection().collection<StoreShape & { _id: string }>("autoTraderState");
}

/** Load the canonical ledger before the engine starts. MongoDB wins over the file. */
export async function initializeLedger() {
  if (!isMongoConnected()) {
    console.warn("[ledger] MongoDB unavailable; using local JSON fallback");
    return;
  }

  const collection = stateCollection();
  const existing = await collection.findOne({ _id: STATE_ID });
  if (existing) {
    store.trades = existing.trades ?? {};
    store.equityCurve = existing.equityCurve ?? {};
    store.kv = existing.kv ?? {};
    mongoReady = true;
    console.log(`[ledger] loaded canonical MongoDB state (${Object.keys(store.trades).length} trades)`);
    return;
  }

  const migrateFile = process.env.LEDGER_MIGRATE_LOCAL_FILE === "true";
  const initial: StoreShape = migrateFile
    ? { trades: store.trades, equityCurve: store.equityCurve, kv: store.kv }
    : { trades: {}, equityCurve: {}, kv: {} };
  await collection.updateOne({ _id: STATE_ID }, { $setOnInsert: initial }, { upsert: true });
  const saved = await collection.findOne({ _id: STATE_ID });
  store.trades = saved?.trades ?? {};
  store.equityCurve = saved?.equityCurve ?? {};
  store.kv = saved?.kv ?? {};
  mongoReady = true;
  console.log(`[ledger] initialized canonical MongoDB state${migrateFile ? " from local JSON" : ""}`);
}

/** Refresh read-only API views so a second instance sees the leader's latest trades. */
export async function refreshLedger() {
  if (!mongoReady || !isMongoConnected()) return;
  const current = await stateCollection().findOne({ _id: STATE_ID });
  if (!current) return;
  store.trades = current.trades ?? {};
  store.equityCurve = current.equityCurve ?? {};
  store.kv = current.kv ?? {};
}

/** Only the configured leader may run the strategy against the shared account. */
export async function acquireEngineLease(): Promise<{ ok: boolean; owner?: string }> {
  if (!mongoReady || !isMongoConnected()) return { ok: INSTANCE_ID === LEADER_ID, owner: INSTANCE_ID };
  if (INSTANCE_ID !== LEADER_ID) return { ok: false, owner: LEADER_ID };
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60_000);
  const result = await stateCollection().findOneAndUpdate(
    { _id: LEASE_ID, $or: [{ "kv.leaseExpiresAt": { $lt: now.toISOString() } }, { "kv.leaseOwner": INSTANCE_ID }, { "kv.leaseOwner": { $exists: false } }] },
    { $set: { "kv.leaseOwner": INSTANCE_ID, "kv.leaseExpiresAt": expiresAt.toISOString() } },
    { upsert: true, returnDocument: "after" }
  );
  return { ok: result?.kv?.leaseOwner === INSTANCE_ID, owner: result?.kv?.leaseOwner };
}

export async function releaseEngineLease() {
  if (mongoReady && isMongoConnected() && INSTANCE_ID === LEADER_ID) {
    await stateCollection().updateOne({ _id: LEASE_ID, "kv.leaseOwner": INSTANCE_ID }, { $set: { "kv.leaseExpiresAt": new Date(0).toISOString() } });
  }
}

async function persistMongo() {
  if (!mongoReady || !isMongoConnected()) return;
  await stateCollection().updateOne(
    { _id: STATE_ID },
    { $set: { trades: store.trades, equityCurve: store.equityCurve, kv: store.kv } },
    { upsert: true }
  );
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFileSync(FILE, JSON.stringify(store));
    void persistMongo().catch((error) => console.error("[ledger] MongoDB save failed:", error));
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
