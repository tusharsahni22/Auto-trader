import type { Trade } from "../types.js";
import { recordOutcome } from "./stats.js";
import { appendOutcome } from "./outcomeLog.js";
import { refitCalibration } from "../decision/calibration.js";

/** docs/07 — the learning loop, run synchronously on every trade close rather than on a monthly cadence (there is no monthly volume yet to justify batching). */
export function onTradeClosed(trade: Trade) {
  if (trade.rMultiple === null) return;
  const win = trade.rMultiple > 0;
  recordOutcome(trade.archetype, trade.regime, win, trade.rMultiple);
  appendOutcome({ rawScore: trade.rawScore, win });
  refitCalibration();
}
