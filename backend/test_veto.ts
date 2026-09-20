import { getDeltaCandles } from './src/services/deltaExchange.js';
import { runPipeline } from './src/decision/pipeline.js';

process.env.DELTA_EXCHANGE_BASE_URL = 'https://cdn-ind.testnet.deltaex.org';

async function main() {
  const candles = await getDeltaCandles('BTCUSD', '15m', 250);
  console.log(`Fetched ${candles.length} candles from Delta.`);
  const out = runPipeline('BTCUSD', candles, 10000, [], false, Date.now());
  console.log("Decision:", out.decision);
  console.log("Veto Reasons:", out.vetoReasons);
  if (out.candidate) {
     console.log("Archetype:", out.candidate.archetype);
     console.log("Regime:", out.regime.label);
     console.log("EV Net R:", out.evNetR);
     console.log("Calibrated Win Prob:", out.calibratedWinProb);
  } else {
     console.log("No candidate generated.");
  }
}
main().catch(console.error);
