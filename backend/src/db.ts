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
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf-8"));
    return { trades: parsed.trades ?? {}, equityCurve: parsed.equityCurve ?? {}, kv: parsed.kv ?? {} };
  } catch (error) {
    // A truncated or corrupt file must not silently become an empty ledger: keep the
    // bytes so the history can be recovered by hand, and say loudly what happened.
    const quarantine = `${FILE}.corrupt-${Date.now()}`;
    try {
      fs.copyFileSync(FILE, quarantine);
      console.error(`[ledger] ${FILE} is unreadable (${(error as Error).message}); copied to ${quarantine}`);
    } catch {
      console.error(`[ledger] ${FILE} is unreadable and could not be quarantined:`, error);
    }
    return { trades: {}, equityCurve: {}, kv: {} };
  }
}

/**
 * Which of two copies of the same trade is newer.
 *
 * `updatedAt` decides it when both carry one. Older rows predate that field, so
 * fall back to observable progress: a closed trade supersedes an open one, and
 * more fills supersede fewer. Anything still tied keeps the incumbent.
 */
function isNewerTrade(candidate: Trade, incumbent: Trade): boolean {
  const a = candidate.updatedAt ?? 0;
  const b = incumbent.updatedAt ?? 0;
  if (a !== b) return a > b;
  if (candidate.status !== incumbent.status) return candidate.status === "CLOSED";
  if ((candidate.fills?.length ?? 0) !== (incumbent.fills?.length ?? 0)) {
    return (candidate.fills?.length ?? 0) > (incumbent.fills?.length ?? 0);
  }
  return (candidate.exitTime ?? 0) > (incumbent.exitTime ?? 0);
}

/**
 * Union two ledgers. This replaced a straight assignment that cost real trades:
 * whenever a MongoDB write failed (an Atlas blip, an IP allowlist change) the
 * local store still held the trade, and the next read replaced the whole store
 * with Mongo's older copy — then the debounced save wrote that shrunken store
 * back over the JSON file. A trade could vanish from both within seconds.
 *
 * Merging makes a missing row mean "this copy has not heard about it yet",
 * never "this row was deleted". Nothing in this system ever deletes a trade.
 */
export function mergeStores(base: StoreShape, incoming: StoreShape): { store: StoreShape; added: number; updated: number } {
  const trades: Record<string, Trade> = { ...base.trades };
  let added = 0;
  let updated = 0;
  for (const [id, trade] of Object.entries(incoming.trades ?? {})) {
    const existing = trades[id];
    if (!existing) {
      trades[id] = trade;
      added++;
    } else if (isNewerTrade(trade, existing)) {
      trades[id] = trade;
      updated++;
    }
  }
  return {
    store: {
      trades,
      equityCurve: { ...base.equityCurve, ...(incoming.equityCurve ?? {}) },
      // Counters and learning state live in kv; the remote copy wins per key,
      // but a key only present locally survives.
      kv: { ...base.kv, ...(incoming.kv ?? {}) },
    },
    added,
    updated,
  };
}

function applyStore(next: StoreShape) {
  store.trades = next.trades;
  store.equityCurve = next.equityCurve;
  store.kv = next.kv;
}

const store: StoreShape = load();
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let mongoReady = false;
let lastPersistError: string | null = null;
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
  const localTrades = Object.keys(store.trades).length;

  // Union, never replace. The old code assigned Mongo's document straight over the
  // in-memory store, so any trade that had only ever been written locally — including
  // every trade taken while Mongo was unreachable — was dropped on the next boot.
  const merged = mergeStores(store, {
    trades: existing?.trades ?? {},
    equityCurve: existing?.equityCurve ?? {},
    kv: existing?.kv ?? {},
  });
  applyStore(merged.store);
  mongoReady = true;

  const total = Object.keys(store.trades).length;
  console.log(
    `[ledger] merged MongoDB state: ${total} trades (${localTrades} local, ${Object.keys(existing?.trades ?? {}).length} remote, ` +
      `${merged.added} added from remote, ${merged.updated} refreshed)`
  );

  // Push the union straight back so both copies agree from here on.
  if (!existing || merged.added !== Object.keys(existing.trades ?? {}).length || total !== Object.keys(existing.trades ?? {}).length) {
    await persistMongo().catch((error) => console.error("[ledger] initial MongoDB sync failed:", error));
  }
}

/**
 * Refresh read-only API views so a second instance sees the leader's latest trades.
 * Merges rather than replaces, for the reason described on `mergeStores`.
 */
export async function refreshLedger() {
  if (!mongoReady || !isMongoConnected()) return;
  const current = await stateCollection().findOne({ _id: STATE_ID });
  if (!current) return;
  const before = Object.keys(store.trades).length;
  const merged = mergeStores(store, {
    trades: current.trades ?? {},
    equityCurve: current.equityCurve ?? {},
    kv: current.kv ?? {},
  });
  applyStore(merged.store);
  const after = Object.keys(store.trades).length;
  if (after !== before) console.log(`[ledger] refresh: ${before} -> ${after} trades`);
  try {
    const current = await stateCollection().findOne({ _id: STATE_ID });
    if (!current) return;
    const before = Object.keys(store.trades).length;
    const merged = mergeStores(store, {
      trades: current.trades ?? {},
      equityCurve: current.equityCurve ?? {},
      kv: current.kv ?? {},
    });
    applyStore(merged.store);
    const after = Object.keys(store.trades).length;
    if (after !== before) console.log(`[ledger] refresh: ${before} -> ${after} trades`);
  } catch (error) {
    console.error("[ledger] refreshLedger failed:", error);
  }
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
  try {
    const result = await stateCollection().findOneAndUpdate(
      { _id: LEASE_ID, $or: [{ "kv.leaseExpiresAt": { $lt: now.toISOString() } }, { "kv.leaseOwner": INSTANCE_ID }, { "kv.leaseOwner": { $exists: false } }] },
      { $set: { "kv.leaseOwner": INSTANCE_ID, "kv.leaseExpiresAt": expiresAt.toISOString() } },
      { upsert: true, returnDocument: "after" }
    );
    return { ok: result?.kv?.leaseOwner === INSTANCE_ID, owner: result?.kv?.leaseOwner };
  } catch (error) {
    console.error("[ledger] acquireEngineLease failed:", error);
    return { ok: false, owner: "unknown" };
  }
}

export async function releaseEngineLease() {
  if (mongoReady && isMongoConnected() && INSTANCE_ID === LEADER_ID) {
    await stateCollection().updateOne({ _id: LEASE_ID, "kv.leaseOwner": INSTANCE_ID }, { $set: { "kv.leaseExpiresAt": new Date(0).toISOString() } });
    try {
      await stateCollection().updateOne({ _id: LEASE_ID, "kv.leaseOwner": INSTANCE_ID }, { $set: { "kv.leaseExpiresAt": new Date(0).toISOString() } });
    } catch (error) {
      console.error("[ledger] releaseEngineLease failed:", error);
    }
  }
}

async function persistMongo() {
  if (!mongoReady || !isMongoConnected()) return;
  await stateCollection().updateOne(
    { _id: STATE_ID },
    { $set: { trades: store.trades, equityCurve: store.equityCurve, kv: store.kv } },
    { upsert: true }
  );
  lastPersistError = null;
  try {
    await stateCollection().updateOne(
      { _id: STATE_ID },
      { $set: { trades: store.trades, equityCurve: store.equityCurve, kv: store.kv } },
      { upsert: true }
    );
    lastPersistError = null;
  } catch (error) {
    console.error("[ledger] persistMongo failed:", error);
    lastPersistError = String(error);
  }
}

/**
 * Write via a temporary file and rename. A direct write leaves a half-written
 * JSON file if the process dies mid-write, and the next boot then reads a
 * corrupt ledger — which used to mean starting from zero trades.
 */
function writeFileAtomic(contents: string) {
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, FILE);
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      writeFileAtomic(JSON.stringify(store));
    } catch (error) {
      lastPersistError = `file: ${(error as Error).message}`;
      console.error("[ledger] local save failed:", error);
    }
    void persistMongo().catch((error) => {
      lastPersistError = `mongo: ${error?.message ?? error}`;
      console.error("[ledger] MongoDB save failed:", error);
    });
  }, 250);
}

export function upsertTrade(t: Trade) {
  t.updatedAt = Date.now();
  store.trades[t.id] = t;
  scheduleSave();
}

/** Trade count by source, for the ledger-health card on the dashboard. */
export async function getLedgerHealth() {
  const local = Object.keys(store.trades).length;
  let remote: number | null = null;
  let error: string | null = null;
  if (mongoReady && isMongoConnected()) {
    try {
      const doc = await stateCollection().findOne({ _id: STATE_ID });
      remote = Object.keys(doc?.trades ?? {}).length;
    } catch (e: any) {
      error = e?.message ?? String(e);
    }
  }
  return {
    trades: local,
    remoteTrades: remote,
    mongoConnected: isMongoConnected(),
    file: FILE,
    lastPersistError,
    error,
    /** Rows held here but not yet in MongoDB. Non-zero after a failed write, and self-heals. */
    pendingSync: remote === null ? null : Math.max(0, local - remote),
  };
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
