# Auto Trader — BTC/ETH Opportunity Engine

Implements the architecture in [`PLAN.md`](PLAN.md) and `docs/`: a decision engine
(regime classifier → archetype detector → evidence graph → calibrated probability →
expected-value model → risk gates → sizing), a lifecycle manager that runs each paper
position after entry, and a dashboard with live charts, engine controls, and full
trade/opportunity transparency. Backend and frontend are separate deployable services.

## What's implemented, mapped to `docs/`

| Doc | Component | Where |
|---|---|---|
| `01-decision-engine` | Regime classifier (6 regimes, rule-based) | `backend/src/decision/regime.ts` |
| | Archetype detector (3 of 7 archetypes — MVP scope) | `backend/src/decision/archetypes.ts` |
| | Claims + citation verification | `backend/src/decision/claims.ts` |
| | Evidence graph (cluster collapse, conflict, N_eff) | `backend/src/decision/evidence.ts` |
| | Correlation-aware log-odds ensemble | `backend/src/decision/ensemble.ts` |
| | Calibration (Stage A/B uncalibrated, Stage C Platt) | `backend/src/decision/calibration.ts` |
| | Hard gates G1–G6, G8, G9, G11, G12 | `backend/src/decision/gates.ts` |
| `02-expected-value-model` | Cost model (fees/slippage/funding → R) | `backend/src/ev/costs.ts` |
| | Outcome distribution (closed-form + Monte Carlo + own-ledger bootstrap) | `backend/src/ev/distribution.ts`, `backend/src/ev/index.ts` |
| | Kelly sizing + Bayesian haircut + constraint stack | `backend/src/ev/sizing.ts` |
| `03-risk-and-portfolio` | Correlation-adjusted portfolio heat, correlation stacking | `backend/src/risk/portfolio.ts` |
| | Circuit breakers (daily loss, drawdown, consecutive losses) | `backend/src/risk/portfolio.ts` |
| `04-trade-lifecycle` | Thesis decay, scale-out ladder, breakeven, chandelier trail, time stop | `backend/src/lifecycle/manager.ts` |
| `07-validation-and-learning` | Outcome ledger → archetype/regime stats → Platt refit on every close | `backend/src/learning/` |
| `09-contracts` | Type names (`Regime`, `Archetype`, `Cluster`, `Claim`, …) | `backend/src/decision/types.ts` |

**Deliberately not implemented**, and why: the HMM regime model, isotonic
calibration, Ledoit-Wolf cluster correlation, a real LLM agent mesh, options/IV
archetypes, an L2 orderbook feed, and a news/macro event feed. Each needs either a
real LLM provider and budget, or hundreds of labelled trades this paper account
hasn't produced yet — building them now would mean faking the inputs they need to be
honest. Every module that simplifies its doc says so in a comment at the top of the
file, including exactly what's approximated and why.

Notably: **claims are generated deterministically from the verified feature
snapshot, not by an LLM.** `docs/01` §4 and `docs/05` describe claims as agent
testimony with citations; this MVP has no model call, no prompt, no provider — it
computes the same shape of object (`featureIds`, `observedValues`, `cluster`,
`stance`, `strength`) directly from indicators. The evidence graph, ensemble, and
calibration code downstream only ever consume `Claim[]` and have no idea whether a
human, a rule, or a model produced it — so a real LLM-based agent can be dropped
into `decision/claims.ts` later without touching anything else.

## Stack

- **Backend** — Node.js + TypeScript + Express + `ws`. Live BTC/ETH candles and
  funding rates from Binance's free public REST + WebSocket + Futures APIs. Trades,
  equity curve, and learned calibration/archetype stats persist to a JSON file (no
  native build dependency — deliberately avoided `better-sqlite3`, which needs a
  C++ toolchain this machine didn't have configured).
- **Frontend** — React + TypeScript + Vite + Tailwind, dark trading-terminal UI.
  Charts via TradingView's `lightweight-charts` (candlestick price chart + equity
  area chart).
- **Docker** — separate Dockerfiles per service, `docker-compose.yml` at the repo
  root, no native deps to compile in the image either.

## Run locally (no Docker)

```bash
# backend
cd backend
npm install
npm run dev        # http://localhost:4000

# frontend (new terminal)
cd frontend
npm install
npm run dev         # http://localhost:5173, proxies /api and /ws to :4000
```

Open http://localhost:5173, click **Start Engine**. Everything — candles, funding
rates, regime classification, trades — runs on live market data; nothing ever
reaches a real exchange (paper mode only, by construction: there is no order-
placement code path in this repo at all).

## Run with Docker

```bash
cp .env.example .env   # fill in optional API keys
docker compose up --build
```

- Frontend: http://localhost:8080
- Backend API: http://localhost:4000

`docker compose config` validates cleanly. If your Docker daemon won't come up,
that's a Docker Desktop / host issue, not this repo — `docker info` should show a
`Server Version` line before `up --build` will work.

## API surface

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/status` | Engine state, tracked assets, candle interval |
| POST | `/api/engine/start` | Start the paper-trading engine |
| POST | `/api/engine/stop` | Stop it (does not close open positions) |
| GET | `/api/candles/:asset` | OHLCV history for `BTCUSDT` / `ETHUSDT` |
| GET | `/api/trades` | Trade history; filter with `?asset=&status=&direction=&from=&to=` |
| GET | `/api/equity-curve` | Equity-over-time series |
| GET | `/api/opportunities` | Recent scored opportunities (OPEN/WATCH/VETO), with reasons |
| GET | `/api/regime/:asset` | Current regime classification + funding rate |
| GET | `/api/learning` | Archetype×regime stats and the fitted Platt calibration params |
| WS | `/ws` | Live events: `price`, `trade_opened`, `trade_updated`, `trade_closed`, `equity`, `engine_state`, `opportunity` |

## UI

Dark, high-density trading-terminal layout: engine start/stop with a live status
pill, equity/net-P&L/win-rate/open-positions stat cards, a live candlestick chart
with regime badge and funding rate, an equity curve, a filterable trade list
(asset/direction/status) with per-trade detail — calibrated win probability with
its confidence interval, the full EV/cost breakdown, evidence clusters and
conflict, sizing and haircuts, and the scale-out target ladder — plus a live
opportunity feed showing every OPEN/WATCH/VETO decision with its reasons, so a
veto is as visible as a trade.
