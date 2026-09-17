#!/usr/bin/env node
/**
 * MCP server exposing the running Auto Trader backend as tools.
 *
 * It is a thin client over the backend's HTTP API — it holds no trading logic
 * of its own and never places orders directly. Market tools are read-only; the
 * only state-changing tools are start/stop of the signal bot, and even those go
 * through the same endpoints the dashboard uses.
 *
 * Requires the backend to be running (default http://localhost:4000, override
 * with AUTO_TRADER_API).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_BASE = process.env.AUTO_TRADER_API ?? "http://localhost:4000";

const ASSET_ALIASES: Record<string, string> = {
  BTC: "BTCUSDT",
  BTCUSD: "BTCUSDT",
  BTCUSDT: "BTCUSDT",
  XBT: "BTCUSDT",
  ETH: "ETHUSDT",
  ETHUSD: "ETHUSDT",
  ETHUSDT: "ETHUSDT",
};

function normalizeAsset(symbol: string): string | null {
  return ASSET_ALIASES[symbol.trim().toUpperCase().replace(/[-/]/g, "")] ?? null;
}

async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`);
  if (!response.ok) {
    throw new Error(
      `Backend returned ${response.status} for ${path}. Is the backend running at ${API_BASE}?`
    );
  }
  return response.json() as Promise<T>;
}

async function apiPost<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, { method: "POST" });
  if (!response.ok) {
    throw new Error(`Backend returned ${response.status} for ${path}`);
  }
  return response.json() as Promise<T>;
}

function text(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function failure(error: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: `Error: ${error instanceof Error ? error.message : String(error)}`,
      },
    ],
    isError: true,
  };
}

const server = new McpServer({ name: "auto-trader", version: "1.0.0" });

server.registerTool(
  "analyze_symbol",
  {
    title: "Analyze a symbol",
    description:
      "Run the EMA/RSI/breakout strategy on a symbol right now and return the BUY/SELL/HOLD verdict with the reasoning behind it. Read-only — never places an order.",
    inputSchema: { symbol: z.string().describe("Symbol such as BTC, BTCUSD or ETHUSDT") },
  },
  async ({ symbol }) => {
    try {
      const asset = normalizeAsset(symbol);
      if (!asset) return failure(`Unsupported symbol "${symbol}". Supported: BTC, ETH.`);

      const [{ indicators }, { tickers }] = await Promise.all([
        apiGet<{ indicators: any[] }>("/api/bot/indicators"),
        apiGet<{ tickers: any[] }>("/api/market/ticker"),
      ]);

      const reading = indicators.find((i) => i.asset === asset);
      if (!reading?.indicators) return failure(`No indicator data for ${asset} yet.`);

      const ticker = tickers.find((t) => t.asset === asset);
      const i = reading.indicators;

      return text({
        asset,
        signal: reading.signal,
        candleSource: reading.candleSource,
        price: i.price,
        changePct: ticker?.changePct ?? null,
        trend: i.trend,
        rsi: i.rsi,
        emaFast: i.emaFast,
        emaSlow: i.emaSlow,
        breakoutRange: { high: i.breakoutHigh, low: i.breakoutLow },
        interpretation:
          reading.signal === "HOLD"
            ? "Fewer than two of the three conditions (trend, momentum, breakout) agree — no trade."
            : `At least two conditions agree on ${reading.signal}.`,
      });
    } catch (error) {
      return failure(error);
    }
  }
);

server.registerTool(
  "get_indicators",
  {
    title: "Get live indicators",
    description: "Current EMA, RSI, trend and breakout levels for every tracked asset. Read-only.",
    inputSchema: {},
  },
  async () => {
    try {
      return text(await apiGet("/api/bot/indicators"));
    } catch (error) {
      return failure(error);
    }
  }
);

server.registerTool(
  "get_pnl",
  {
    title: "Get P&L and account equity",
    description:
      "Account equity (the live Delta Exchange balance when configured) together with realised P&L, win rate and profit factor. Read-only.",
    inputSchema: {},
  },
  async () => {
    try {
      const [balance, tradeStats] = await Promise.all([
        apiGet<any>("/api/balance"),
        apiGet<any>("/api/trades/stats"),
      ]);
      return text({ balance, tradeStats });
    } catch (error) {
      return failure(error);
    }
  }
);

server.registerTool(
  "get_positions",
  {
    title: "Get open positions",
    description: "All currently open positions with entry, stop, targets and size. Read-only.",
    inputSchema: {},
  },
  async () => {
    try {
      const trades = await apiGet<any[]>("/api/trades?status=OPEN");
      return text({
        count: trades.length,
        positions: trades.map((t) => ({
          id: t.id,
          asset: t.asset,
          direction: t.direction,
          entryPrice: t.entryPrice,
          stopPrice: t.stopPrice,
          targets: t.targets?.map((x: any) => x.price),
          quantity: t.remainingQuantity,
          entryTime: new Date(t.entryTime).toISOString(),
          reason: t.reason,
        })),
      });
    } catch (error) {
      return failure(error);
    }
  }
);

server.registerTool(
  "recent_trades",
  {
    title: "Recent trades",
    description: "Most recent trades, newest first, with P&L for the closed ones. Read-only.",
    inputSchema: {
      limit: z.number().int().min(1).max(100).optional().describe("How many to return (default 20)"),
    },
  },
  async ({ limit }) => {
    try {
      const trades = await apiGet<any[]>("/api/trades");
      const sorted = [...trades].sort((a, b) => b.entryTime - a.entryTime).slice(0, limit ?? 20);
      return text({
        count: sorted.length,
        trades: sorted.map((t) => ({
          id: t.id,
          asset: t.asset,
          direction: t.direction,
          status: t.status,
          entryPrice: t.entryPrice,
          exitPrice: t.exitPrice,
          pnlUsd: t.pnlUsd,
          rMultiple: t.rMultiple,
          entryTime: new Date(t.entryTime).toISOString(),
          reason: t.reason,
        })),
      });
    } catch (error) {
      return failure(error);
    }
  }
);

server.registerTool(
  "bot_status",
  {
    title: "Signal bot status",
    description:
      "Whether the signal bot is running, its configuration, and optionally its recent decisions. Read-only.",
    inputSchema: {
      includeDecisions: z.boolean().optional().describe("Include the recent decision log"),
    },
  },
  async ({ includeDecisions }) => {
    try {
      const status = await apiGet<any>("/api/bot/status");
      if (!includeDecisions) return text(status);

      const { decisions } = await apiGet<{ decisions: any[] }>("/api/bot/decisions?limit=20");
      return text({
        ...status,
        decisions: decisions.map((d) => ({
          time: new Date(d.time).toISOString(),
          asset: d.asset,
          signal: d.signal,
          confidence: d.confidence,
          reasons: d.reasons,
          executed: d.executed,
        })),
      });
    } catch (error) {
      return failure(error);
    }
  }
);

server.registerTool(
  "start_bot",
  {
    title: "Start the signal bot",
    description:
      "Start the scheduled signal bot. Whether it places orders depends on the backend's autoExecute setting, which this tool does not change.",
    inputSchema: {},
  },
  async () => {
    try {
      const result = await apiPost<any>("/api/bot/start");
      const autoExecute = result.bot?.config?.autoExecute;
      return text({
        started: true,
        autoExecute,
        intervalMs: result.bot?.config?.intervalMs,
        note: autoExecute
          ? "autoExecute is ON — the bot will place orders on BUY/SELL."
          : "autoExecute is OFF — the bot only records decisions.",
      });
    } catch (error) {
      return failure(error);
    }
  }
);

server.registerTool(
  "stop_bot",
  {
    title: "Stop the signal bot",
    description: "Stop the scheduled signal bot. Open positions are left untouched.",
    inputSchema: {},
  },
  async () => {
    try {
      await apiPost("/api/bot/stop");
      return text({ stopped: true, note: "Open positions were not closed." });
    } catch (error) {
      return failure(error);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[mcp] auto-trader MCP server ready (backend: ${API_BASE})`);
