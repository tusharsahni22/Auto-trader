import express from "express";
import cors from "cors";
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { api } from "./routes/api.js";
import { initEngine, setBroadcaster } from "./engine/index.js";

const PORT = Number(process.env.PORT ?? 4000);

const app = express();
app.use(cors());
app.use(express.json());
app.use("/api", api);
app.get("/health", (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

function broadcast(event: string, payload: unknown) {
  const msg = JSON.stringify({ event, payload });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ event: "hello", payload: { ok: true } }));
});

setBroadcaster(broadcast);

server.listen(PORT, async () => {
  console.log(`[server] listening on :${PORT}`);
  await initEngine();
  console.log("[server] engine initialized (stopped — call /api/engine/start)");
});
