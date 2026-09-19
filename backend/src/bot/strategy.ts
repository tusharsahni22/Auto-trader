/**
 * EMA / RSI / breakout signal strategy.
 *
 * Deliberately separate from the archetype + regime decision pipeline in
 * `decision/` — that engine is untouched by this file. This is a simple,
 * legible rule set that produces BUY / SELL / HOLD, and it runs on its own
 * schedule so the two never contend for the same code path.
 */

import { ema, rsi, rollingMax, rollingMin, adx, atr } from "../lib/indicators.js";
import type { Asset, Candle } from "../types.js";

export type Signal = "BUY" | "SELL" | "HOLD";

export interface StrategyConfig {
  emaFastPeriod: number;
  emaSlowPeriod: number;
  rsiPeriod: number;
  rsiBullish: number;
  rsiBearish: number;
  breakoutLookback: number;
  adxPeriod: number;
  adxThreshold: number;
  volSpikeThreshold: number;
}

export const DEFAULT_STRATEGY_CONFIG: StrategyConfig = {
  emaFastPeriod: 9,
  emaSlowPeriod: 21,
  rsiPeriod: 14,
  rsiBullish: 55,
  rsiBearish: 45,
  breakoutLookback: 20,
  adxPeriod: 14,
  adxThreshold: 20,
  volSpikeThreshold: 1.5,
};

export interface IndicatorSnapshot {
  price: number;
  emaFast: number | null;
  emaSlow: number | null;
  rsi: number | null;
  adx: number | null;
  atr: number | null;
  breakoutHigh: number | null;
  breakoutLow: number | null;
  volSpike: number | null;
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

  // Volume spike check (current vs avg of previous 20)
  const volWindow = candles.slice(-21, -1);
  const avgVol = volWindow.length > 0 ? volWindow.reduce((sum, c) => sum + c.volume, 0) / volWindow.length : 1;
  const volSpike = candles[candles.length - 1].volume / (avgVol || 1);

  return {
    price,
    emaFast,
    emaSlow,
    rsi: rsi(closes, config.rsiPeriod),
    adx: adx(candles, config.adxPeriod),
    atr: atr(candles, 14),
    breakoutHigh,
    breakoutLow,
    volSpike,
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

  const { emaFast, emaSlow, rsi: rsiValue, adx: adxValue, breakoutHigh, breakoutLow, price, volSpike } = indicators;

  // 1. Trend & Strength (EMA + ADX)
  if (emaFast !== null && emaSlow !== null && adxValue !== null) {
    evaluated++;
    if (adxValue < config.adxThreshold) {
      reasons.push(`ADX ${adxValue.toFixed(1)} < ${config.adxThreshold} (choppy market)`);
    } else if (emaFast > emaSlow) {
      bullish++;
      reasons.push(`EMA${config.emaFastPeriod} > EMA${config.emaSlowPeriod} + ADX ${adxValue.toFixed(1)} (strong uptrend)`);
    } else if (emaFast < emaSlow) {
      bearish++;
      reasons.push(`EMA${config.emaFastPeriod} < EMA${config.emaSlowPeriod} + ADX ${adxValue.toFixed(1)} (strong downtrend)`);
    }
  }

  // 2. Momentum (RSI confirmation)
  if (rsiValue !== null) {
    evaluated++;
    if (rsiValue >= config.rsiBullish) {
      bullish++;
      reasons.push(`RSI ${rsiValue.toFixed(1)} >= ${config.rsiBullish} (bullish momentum)`);
    } else if (rsiValue <= config.rsiBearish) {
      bearish++;
      reasons.push(`RSI ${rsiValue.toFixed(1)} <= ${config.rsiBearish} (bearish momentum)`);
    } else {
      reasons.push(`RSI ${rsiValue.toFixed(1)} neutral`);
    }
  }

  // 3. Price Action & Volume (Breakout)
  if (breakoutHigh !== null && breakoutLow !== null && volSpike !== null) {
    evaluated++;
    if (price > breakoutHigh && volSpike >= config.volSpikeThreshold) {
      bullish++;
      reasons.push(`Price broke ${config.breakoutLookback}-bar high (${breakoutHigh.toFixed(2)}) with ${volSpike.toFixed(1)}x vol`);
    } else if (price < breakoutLow && volSpike >= config.volSpikeThreshold) {
      bearish++;
      reasons.push(`Price broke ${config.breakoutLookback}-bar low (${breakoutLow.toFixed(2)}) with ${volSpike.toFixed(1)}x vol`);
    } else {
      reasons.push(`No valid breakout with >= ${config.volSpikeThreshold}x volume`);
    }
  }

  let signal: Signal = "HOLD";
  let agreeing = 0;

  // Require 2 conditions to agree with NO disagreement
  if (bullish >= 2 && bearish === 0) {
    signal = "BUY";
    agreeing = bullish;
  } else if (bearish >= 2 && bullish === 0) {
    signal = "SELL";
    agreeing = bearish;
  } else {
    reasons.push("Conditions disagree or lack conviction — holding");
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
