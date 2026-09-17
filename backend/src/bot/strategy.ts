/**
 * EMA / RSI / breakout signal strategy.
 *
 * Deliberately separate from the archetype + regime decision pipeline in
 * `decision/` — that engine is untouched by this file. This is a simple,
 * legible rule set that produces BUY / SELL / HOLD, and it runs on its own
 * schedule so the two never contend for the same code path.
 */

import { ema, rsi, rollingMax, rollingMin } from "../lib/indicators.js";
import type { Asset, Candle } from "../types.js";

export type Signal = "BUY" | "SELL" | "HOLD";

export interface StrategyConfig {
  emaFastPeriod: number;
  emaSlowPeriod: number;
  rsiPeriod: number;
  rsiOverbought: number;
  rsiOversold: number;
  breakoutLookback: number;
}

export const DEFAULT_STRATEGY_CONFIG: StrategyConfig = {
  emaFastPeriod: 9,
  emaSlowPeriod: 21,
  rsiPeriod: 14,
  rsiOverbought: 70,
  rsiOversold: 30,
  breakoutLookback: 20,
};

export interface IndicatorSnapshot {
  price: number;
  emaFast: number | null;
  emaSlow: number | null;
  rsi: number | null;
  breakoutHigh: number | null;
  breakoutLow: number | null;
  trend: "UP" | "DOWN" | "FLAT";
}

export interface StrategyDecision {
  asset: Asset;
  time: number;
  signal: Signal;
  confidence: number;
  reasons: string[];
  indicators: IndicatorSnapshot;
}

export function computeIndicators(candles: Candle[], config: StrategyConfig): IndicatorSnapshot | null {
  if (candles.length === 0) return null;

  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];

  const emaFast = ema(closes, config.emaFastPeriod);
  const emaSlow = ema(closes, config.emaSlowPeriod);

  // Exclude the current (still forming) bar so a breakout is measured against
  // levels that were actually established before this candle.
  const priorHighs = candles.slice(0, -1).map((c) => c.high);
  const priorLows = candles.slice(0, -1).map((c) => c.low);
  const breakoutHigh =
    priorHighs.length >= config.breakoutLookback ? rollingMax(priorHighs, config.breakoutLookback) : null;
  const breakoutLow =
    priorLows.length >= config.breakoutLookback ? rollingMin(priorLows, config.breakoutLookback) : null;

  let trend: IndicatorSnapshot["trend"] = "FLAT";
  if (emaFast !== null && emaSlow !== null) {
    if (emaFast > emaSlow) trend = "UP";
    else if (emaFast < emaSlow) trend = "DOWN";
  }

  return {
    price,
    emaFast,
    emaSlow,
    rsi: rsi(closes, config.rsiPeriod),
    breakoutHigh,
    breakoutLow,
    trend,
    };
}

/**
 * Scores three independent conditions (trend, momentum, breakout) and requires
 * agreement before committing. A single condition on its own returns HOLD —
 * confidence is the share of conditions that agree.
 */
export function decideSignal(
  asset: Asset,
  candles: Candle[],
  config: StrategyConfig = DEFAULT_STRATEGY_CONFIG
): StrategyDecision | null {
  const indicators = computeIndicators(candles, config);
  if (!indicators) return null;

  const reasons: string[] = [];
  let bullish = 0;
  let bearish = 0;
  let evaluated = 0;

  const { emaFast, emaSlow, rsi: rsiValue, breakoutHigh, breakoutLow, price } = indicators;

  if (emaFast !== null && emaSlow !== null) {
    evaluated++;
    if (emaFast > emaSlow) {
      bullish++;
      reasons.push(`EMA${config.emaFastPeriod} above EMA${config.emaSlowPeriod} (uptrend)`);
    } else if (emaFast < emaSlow) {
      bearish++;
      reasons.push(`EMA${config.emaFastPeriod} below EMA${config.emaSlowPeriod} (downtrend)`);
    }
  }

  if (rsiValue !== null) {
    evaluated++;
    if (rsiValue <= config.rsiOversold) {
      bullish++;
      reasons.push(`RSI ${rsiValue.toFixed(1)} oversold (<= ${config.rsiOversold})`);
    } else if (rsiValue >= config.rsiOverbought) {
      bearish++;
      reasons.push(`RSI ${rsiValue.toFixed(1)} overbought (>= ${config.rsiOverbought})`);
    } else {
      reasons.push(`RSI ${rsiValue.toFixed(1)} neutral`);
    }
  }

  if (breakoutHigh !== null && breakoutLow !== null) {
    evaluated++;
    if (price > breakoutHigh) {
      bullish++;
      reasons.push(`Price broke ${config.breakoutLookback}-bar high (${breakoutHigh.toFixed(2)})`);
    } else if (price < breakoutLow) {
      bearish++;
      reasons.push(`Price broke ${config.breakoutLookback}-bar low (${breakoutLow.toFixed(2)})`);
    } else {
      reasons.push(`Price inside the ${config.breakoutLookback}-bar range`);
    }
  }

  let signal: Signal = "HOLD";
  let agreeing = 0;

  if (bullish >= 2 && bearish === 0) {
    signal = "BUY";
    agreeing = bullish;
  } else if (bearish >= 2 && bullish === 0) {
    signal = "SELL";
    agreeing = bearish;
  } else {
    reasons.push("Conditions disagree or are too weak — holding");
  }

  return {
    asset,
    time: Date.now(),
    signal,
    confidence: evaluated > 0 ? agreeing / evaluated : 0,
    reasons,
    indicators,
  };
}
