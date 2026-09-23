import "./env.js";
import express from "express";
import cors from "cors";
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { api } from "./routes/api.js";
import { initEngine, reloadPersistedState, pauseEngineForShutdown, resumeEngineIfWasRunning, setBroadcaster } from "./engine/index.js";
import { initializeLedger } from "./db.js";
import { startNewsCalendarUpdates, setNewsCalendarBroadcaster } from "./services/newsCalendar.js";
import { startRateRefresh } from "./services/rates.js";
import { preflight } from "./services/exchangeHealth.js";
import { setBotBroadcaster } from "./bot/scheduler.js";
import { getMarketFeedHealth } from "./marketData.js";

// MongoDB is optional - system works without it
let connectMongoDB: (() => Promise<void>) | null = null;
let isMongoConnected: (() => boolean) = () => false;
try {
  const mongoModule = await import("./db/mongodb.js");
  connectMongoDB = mongoModule.connectMongoDB;
  isMongoConnected = mongoModule.isMongoConnected;
} catch (e) {
  console.log("[server] MongoDB module not available - running without database persistence");
}

const PORT = Number(process.env.PORT ?? 4000);

// FIX CONFIG 5 (CORS): Restrict to configured allowlist instead of wildcard '*'
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((s) => s.trim())
  : ["http://localhost:3000", "http://localhost:5173", "http://localhost:4173"];

const app = express();
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json());
app.use("/api", api);

// FIX CONFIG 7 (Health): Return real system state instead of always-ok
app.get("/health", (_req, res) => {
  const btcFeed = getMarketFeedHealth("BTCUSDT");
  const healthy = btcFeed.fresh;
  res.status(healthy ? 200 : 503).json({
    ok: healthy,
    feed: { btcUsdt: btcFeed },
    mongoConnected: isMongoConnected(),
    uptime: process.uptime(),
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// FIX CONFIG 6 (WebSocket auth): Validate token on connection
const WS_TOKEN = process.env.WS_AUTH_TOKEN;

function broadcast(event: string, payload: unknown) {
  const msg = JSON.stringify({ event, payload });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

wss.on("connection", (ws, req) => {
  if (WS_TOKEN) {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const token = url.searchParams.get("token");
    if (token !== WS_TOKEN) {
      ws.close(4401, "Unauthorized");
      return;
    }
  }
  ws.send(JSON.stringify({ event: "hello", payload: { ok: true } }));
});

setBroadcaster(broadcast);
setBotBroadcaster(broadcast);
setNewsCalendarBroadcaster(broadcast); // Wire news signals to chart

// FIX CONFIG 1 (startup validation): Log resolved config before starting
function logStartupConfig() {
  const table: Record<string, string> = {
    LIVE_TRADING: process.env.LIVE_TRADING ?? "false",
    DELTA_API_KEY: process.env.DELTA_EXCHANGE_API_KEY ? "SET ✓" : "NOT SET ⚠️",
    DELTA_BASE_URL: process.env.DELTA_EXCHANGE_BASE_URL ?? "testnet (default)",
    STARTING_EQUITY: process.env.STARTING_EQUITY ?? "10000 (default)",
    WS_AUTH_TOKEN: WS_TOKEN ? "SET ✓" : "not set (open access)",
    ALLOWED_ORIGINS: allowedOrigins.join(", "),
    NEWS_ENABLED: process.env.NEWS_ENABLED ?? "true (default)",
    LIMIT_ORDER_TIMEOUT: process.env.LIMIT_ORDER_TIMEOUT_MS ?? "120000ms (default)",
    TRADING_ASSETS: process.env.TRADING_ASSETS ?? "BTCUSDT,ETHUSDT (default)",
    PORT: String(PORT),
  };
  console.log("\n[server] ── Startup Configuration ──────────────────────────");
  for (const [k, v] of Object.entries(table)) console.log(`  ${k.padEnd(22)} ${v}`);
  console.log("[server] ────────────────────────────────────────────────────\n");
}

server.listen(PORT, async () => {
  logStartupConfig();
  console.log(`[server] listening on :${PORT}`);

  const originalLog = console.log;
  const initLogs: string[] = [];
  console.log = (...args) => {
    const msg = args.map(a => String(a)).join(" ");
    if (msg.startsWith("[mongodb]") || msg.startsWith("[ledger]") || msg.startsWith("[exchange]") || msg.startsWith("[rates]") || msg.startsWith("[engine]") || msg.startsWith("[newsCalendar]")) {
      initLogs.push(msg);
    } else {
      originalLog(...args);
    }
  };

  if (connectMongoDB) {
    try {
      await connectMongoDB();
      await initializeLedger();
      reloadPersistedState();
    } catch (error) {
      console.error("[server] MongoDB connection failed, continuing without persistence:", error);
    }
  }

  if (process.env.DELTA_EXCHANGE_API_KEY && process.env.DELTA_EXCHANGE_API_SECRET) {
    const health = await preflight();
    if (!health.healthy && process.env.LIVE_TRADING === "true") {
      console.error("[server] LIVE_TRADING is on but Delta is not usable. No trades will be opened until this is fixed.");
    }
  }

  await startNewsCalendarUpdates();
  await startRateRefresh();
  await initEngine();
  const wasRunning = await resumeEngineIfWasRunning();

  console.log = originalLog;

  const maxWidth = Math.max(...initLogs.map(l => l.length), 50);
  console.log("\n[server] ┌" + "─".repeat(maxWidth + 2) + "┐");
  console.log("[server] │ " + "API & Service Status".padEnd(maxWidth) + " │");
  console.log("[server] ├" + "─".repeat(maxWidth + 2) + "┤");
  for (const log of initLogs) {
    console.log("[server] │ " + log.padEnd(maxWidth) + " │");
  }
  console.log("[server] └" + "─".repeat(maxWidth + 2) + "┘\n");

  if (wasRunning) {
    console.log("[server] engine initialized and started automatically (set AUTO_START_ENGINE=false to disable)");
  } else {
    console.log("[server] engine initialized (stopped — call /api/engine/start)");
  }
});

// FIX CONFIG 2 (graceful shutdown): Cancel pending exchange orders before exit
async function shutdown(signal: string) {
  console.log(`\n[server] ${signal} received — shutting down gracefully`);
  pauseEngineForShutdown();
  // Give open limit orders a moment to be cancelled via the execution layer
  await new Promise((r) => setTimeout(r, 1500));
  server.close(() => {
    console.log("[server] closed");
    process.exit(0);
  });
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT",  () => void shutdown("SIGINT"));

