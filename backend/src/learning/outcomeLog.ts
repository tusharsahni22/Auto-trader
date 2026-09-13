import { getKv, setKv } from "../db.js";

/** Raw-score/outcome pairs used to fit the global Platt scaling curve (docs/01 §6.2). */
export interface OutcomeSample {
  rawScore: number;
  win: boolean;
}

const KEY = "outcome_log_v1";
const MAX_SAMPLES = 2000;

export function appendOutcome(sample: OutcomeSample) {
  const samples = loadOutcomes();
  samples.push(sample);
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
  setKv(KEY, JSON.stringify(samples));
}

export function loadOutcomes(): OutcomeSample[] {
  const raw = getKv(KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}
