import type { Asset, Candle, Direction, EngineState, Opportunity, PnlPoint, RegimeSnapshot, ScanInfo, Trade } from "./types";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export const api = {
  status: () =>
    fetch("/api/status").then((r) => json<{ engine: EngineState; assets: Asset[]; interval: string; scans: ScanInfo[] }>(r)),
  startEngine: () => fetch("/api/engine/start", { method: "POST" }).then((r) => json<{ ok: boolean }>(r)),
  stopEngine: () => fetch("/api/engine/stop", { method: "POST" }).then((r) => json<{ ok: boolean }>(r)),
  candles: (asset: Asset) => fetch(`/api/candles/${asset}`).then((r) => json<Candle[]>(r)),
  trades: (params: Record<string, string> = {}) => {
    const qs = new URLSearchParams(params).toString();
    return fetch(`/api/trades${qs ? `?${qs}` : ""}`).then((r) => json<Trade[]>(r));
  },
  equityCurve: () => fetch("/api/equity-curve").then((r) => json<PnlPoint[]>(r)),
  opportunities: () => fetch("/api/opportunities").then((r) => json<Opportunity[]>(r)),
  regime: (asset: Asset) =>
    fetch(`/api/regime/${asset}`).then((r) => json<{ asset: Asset; regime: RegimeSnapshot; fundingRate: number }>(r)),
  forceTrade: (asset: Asset, direction: Direction) =>
    fetch("/api/engine/force-trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ asset, direction }),
    }).then(async (r) => {
      const body = (await r.json()) as { ok: boolean; trade?: Trade; error?: string };
      if (!r.ok || !body.ok) throw new Error(body.error ?? `${r.status} ${r.statusText}`);
      return body.trade!;
    }),
};
