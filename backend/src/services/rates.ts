/**
 * Live rate resolution for the charge model.
 *
 * Two of the numbers in `chargeConfig` are market data and go stale on their own:
 *
 *   • Delta's maker/taker commission — published per product on /v2/products, and
 *     it changes when the account's fee tier does.
 *   • USD/INR — moves every day. A hardcoded figure is wrong within weeks.
 *
 * The rest of `chargeConfig` is statutory: GST, the s.115BBH rate and the cess are
 * set by law and change only in a Union Budget, announced months ahead. No API
 * publishes them, so they stay configurable constants — fetching them would be
 * inventing a source, not reading one.
 *
 * Every fetch degrades to the configured value on failure, so a dead endpoint makes
 * the numbers stale, never absent. `rateProvenance()` reports which is in use so the
 * dashboard can say "live" or "fallback" rather than implying precision it lacks.
 */

import { chargeConfig } from "./charges.js";
import { getDeltaProduct, assetToDeltaSymbol } from "./deltaExchange.js";

const FX_REFRESH_MS = 12 * 60 * 60 * 1000; // twice a day is plenty for a tax display
const FX_TIMEOUT_MS = 10_000;

interface FeeRates {
  makerFeeRate: number;
  takerFeeRate: number;
}

const feeRatesBySymbol = new Map<string, FeeRates>();

const provenance = {
  fx: { value: chargeConfig.usdInr, source: "config" as "config" | "open.er-api.com" | "frankfurter.app", fetchedAt: null as number | null, error: null as string | null },
  fees: { source: "config" as "config" | "delta", fetchedAt: null as number | null, error: null as string | null, symbols: [] as string[] },
};

/** USD/INR, newest first by reliability. Both are free and keyless. */
const FX_SOURCES: { name: "open.er-api.com" | "frankfurter.app"; url: string; pick: (j: any) => unknown }[] = [
  { name: "open.er-api.com", url: "https://open.er-api.com/v6/latest/USD", pick: (j) => j?.rates?.INR },
  { name: "frankfurter.app", url: "https://api.frankfurter.app/latest?from=USD&to=INR", pick: (j) => j?.rates?.INR },
];

export async function refreshFxRate(): Promise<number> {
  const errors: string[] = [];
  for (const source of FX_SOURCES) {
    try {
      const response = await fetch(source.url, { signal: AbortSignal.timeout(FX_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const value = Number(source.pick(await response.json()));
      // A plausibility band, so a malformed or zeroed payload cannot silently make
      // every INR figure on the dashboard absurd.
      if (!Number.isFinite(value) || value < 30 || value > 300) throw new Error(`implausible rate ${value}`);

      chargeConfig.usdInr = value;
      provenance.fx = { value, source: source.name, fetchedAt: Date.now(), error: null };
      console.log(`[rates] USD/INR ${value.toFixed(4)} from ${source.name}`);
      return value;
    } catch (error: any) {
      errors.push(`${source.name}: ${error?.message ?? error}`);
    }
  }
  provenance.fx.error = errors.join("; ");
  console.warn(`[rates] USD/INR unavailable (${provenance.fx.error}); keeping ${chargeConfig.usdInr}`);
  return chargeConfig.usdInr;
}

/**
 * Commission rates straight from Delta's product metadata. This is the account's
 * real published tier, so it beats any figure typed into .env.
 */
export async function refreshDeltaFeeRates(assets: string[] = ["BTCUSDT", "ETHUSDT"]): Promise<void> {
  const errors: string[] = [];
  for (const asset of assets) {
    try {
      const product = await getDeltaProduct(asset);
      const makerFeeRate = Number(product.maker_commission_rate);
      const takerFeeRate = Number(product.taker_commission_rate);
      if (!Number.isFinite(makerFeeRate) || !Number.isFinite(takerFeeRate)) throw new Error("product has no commission rates");
      // Guard against a malformed payload turning fees into something ruinous.
      if (takerFeeRate < 0 || takerFeeRate > 0.01 || makerFeeRate < 0 || makerFeeRate > 0.01) {
        throw new Error(`implausible rates maker=${makerFeeRate} taker=${takerFeeRate}`);
      }

      feeRatesBySymbol.set(assetToDeltaSymbol(asset), { makerFeeRate, takerFeeRate });
      provenance.fees = {
        source: "delta",
        fetchedAt: Date.now(),
        error: null,
        symbols: [...feeRatesBySymbol.keys()],
      };
      console.log(`[rates] ${assetToDeltaSymbol(asset)} maker ${makerFeeRate} taker ${takerFeeRate} from Delta`);
    } catch (error: any) {
      errors.push(`${asset}: ${error?.message ?? error}`);
    }
  }
  if (errors.length) {
    provenance.fees.error = errors.join("; ");
    console.warn(`[rates] Delta fee rates unavailable (${provenance.fees.error}); using configured rates`);
  }
}

/**
 * Fee rates for an asset: Delta's published pair when we have it, else the
 * configured fallback. Note that for a trade that actually filled, the exchange's
 * own `paid_commission` overrides both — see services/charges.ts.
 */
export function getFeeRates(asset?: string): FeeRates {
  const fromDelta = asset ? feeRatesBySymbol.get(assetToDeltaSymbol(asset)) : undefined;
  return fromDelta ?? { makerFeeRate: chargeConfig.makerFeeRate, takerFeeRate: chargeConfig.takerFeeRate };
}

export function rateProvenance() {
  return {
    usdInr: { ...provenance.fx, value: chargeConfig.usdInr },
    fees: { ...provenance.fees, rates: Object.fromEntries(feeRatesBySymbol) },
    statutory: {
      source: "config",
      note:
        "GST, the s.115BBH rate and the cess are set by statute and change only in a Union Budget. " +
        "No API publishes them, so they are configuration, not a feed. Override via .env if the law changes.",
      gstRate: chargeConfig.gstRate,
      tdsRate: chargeConfig.tdsRate,
      incomeTaxRate: chargeConfig.incomeTaxRate,
      cessRate: chargeConfig.cessRate,
    },
  };
}

/** Warm both at boot, then keep FX on a slow timer. Never throws. */
export async function startRateRefresh(assets?: string[]): Promise<void> {
  await Promise.all([
    refreshFxRate().catch(() => {}),
    refreshDeltaFeeRates(assets).catch(() => {})
  ]);
  setInterval(() => void refreshFxRate().catch(() => {}), FX_REFRESH_MS);
}
