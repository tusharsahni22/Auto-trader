/**
 * Delta Exchange India — trading charges and Indian tax treatment.
 *
 * Two different things live here and they must not be confused:
 *
 *   1. EXCHANGE CHARGES, deducted from the wallet on every fill:
 *        trading fee  = notional x fee rate (maker or taker)
 *        GST          = 18% ON THE FEE (not on the notional, not on the profit)
 *        TDS          = 1% u/s 194S, only where it applies
 *      These are real money and are subtracted from a trade's net P&L.
 *
 *   2. INCOME TAX on gains from virtual digital assets (s.115BBH): 30% plus a 4%
 *      health-and-education cess = 31.2% effective. It is assessed on the financial
 *      year, NOT per trade, losses cannot be set off against gains, and no expense
 *      other than cost of acquisition is deductible. What we show per trade is a
 *      PROVISION — what to set aside — never a settled liability.
 *
 * Everything is a rate in a table below so a fee-tier change is a one-line edit.
 * Rates are the published defaults; override per deployment via .env if the
 * account is on a different tier. They are estimates, and the UI says so —
 * the exchange's own `paid_commission` on a fill always wins when present.
 */

const num = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const chargeConfig = {
  /**
   * Fallbacks only. services/rates.ts replaces these at boot with the commission
   * rates Delta publishes for the account's own fee tier, and a filled order's
   * reported commission overrides even those.
   */
  takerFeeRate: num("DELTA_TAKER_FEE_RATE", 0.0005),
  makerFeeRate: num("DELTA_MAKER_FEE_RATE", 0.0002),
  /** GST on the trading fee (18% in India). Applies to the FEE only. */
  gstRate: num("INDIA_GST_RATE", 0.18),
  /**
   * TDS u/s 194S, fraction of turnover. Left at 0 by default: 194S targets the
   * transfer of a virtual digital asset, and cash-settled futures on an Indian
   * exchange are generally outside it. Set INDIA_TDS_RATE=0.01 if your CA says
   * otherwise for this product, and the number will flow through every screen.
   */
  tdsRate: num("INDIA_TDS_RATE", 0),
  /** s.115BBH flat rate on VDA gains. */
  incomeTaxRate: num("INDIA_VDA_TAX_RATE", 0.30),
  /** Health and education cess levied on the tax amount. */
  cessRate: num("INDIA_CESS_RATE", 0.04),
  /**
   * USD per INR, used only to show an INR figure beside a USD-settled trade.
   * Refreshed twice a day from a live FX feed by services/rates.ts; this is the
   * value used before the first fetch lands and if every source is unreachable.
   */
  usdInr: num("USD_INR_RATE", 88),
};

/** Effective income-tax rate on a gain: 30% + 4% cess on that 30% = 31.2%. */
export const effectiveIncomeTaxRate = () =>
  chargeConfig.incomeTaxRate * (1 + chargeConfig.cessRate);

export interface SideCharges {
  /** Notional value transacted on this side, in USD. */
  notionalUsd: number;
  feeUsd: number;
  gstUsd: number;
  tdsUsd: number;
  totalUsd: number;
  /** "taker" | "maker" — which fee rate was applied. */
  liquidity: "taker" | "maker";
  /** True when the fee came from the exchange rather than from these rates. */
  fromExchange: boolean;
}

export interface TradeCharges {
  entry: SideCharges;
  exit: SideCharges;
  /** entry.totalUsd + exit.totalUsd — the real cost of the round trip. */
  totalUsd: number;
  totalInr: number;
  /** P&L before any charges. */
  grossPnlUsd: number;
  /** grossPnlUsd - totalUsd. This is what actually hit the wallet. */
  netPnlUsd: number;
  /** Provision on a net gain at 31.2%; 0 when the trade lost money. */
  incomeTaxProvisionUsd: number;
  /** netPnlUsd - incomeTaxProvisionUsd. What is left after setting tax aside. */
  afterTaxPnlUsd: number;
  rates: {
    takerFeeRate: number;
    makerFeeRate: number;
    gstRate: number;
    tdsRate: number;
    incomeTaxRate: number;
    cessRate: number;
    effectiveIncomeTaxRate: number;
    usdInr: number;
  };
  /** True when both sides used published rates rather than exchange-reported fees. */
  estimated: boolean;
}

/**
 * Charges for one side of a trade.
 *
 * `exchangeFeeUsd` is Delta's own `paid_commission` when we have it. It already
 * includes GST, so the GST is backed out of it rather than added on top — adding
 * would double-count and overstate the cost of every live trade.
 */
export function sideCharges(
  notionalUsd: number,
  liquidity: "taker" | "maker",
  exchangeFeeUsd?: number,
  feeRates?: { makerFeeRate: number; takerFeeRate: number }
): SideCharges {
  const notional = Math.abs(notionalUsd);
  const fromExchange = exchangeFeeUsd !== undefined && Number.isFinite(exchangeFeeUsd) && exchangeFeeUsd > 0;

  let feeUsd: number;
  let gstUsd: number;
  if (fromExchange) {
    // Delta bills fee + GST as one commission line: fee = commission / (1 + gst).
    feeUsd = exchangeFeeUsd! / (1 + chargeConfig.gstRate);
    gstUsd = exchangeFeeUsd! - feeUsd;
  } else {
    const rates = feeRates ?? { makerFeeRate: chargeConfig.makerFeeRate, takerFeeRate: chargeConfig.takerFeeRate };
    const rate = liquidity === "maker" ? rates.makerFeeRate : rates.takerFeeRate;
    feeUsd = notional * rate;
    gstUsd = feeUsd * chargeConfig.gstRate;
  }

  const tdsUsd = notional * chargeConfig.tdsRate;
  return {
    notionalUsd: notional,
    feeUsd,
    gstUsd,
    tdsUsd,
    totalUsd: feeUsd + gstUsd + tdsUsd,
    liquidity,
    fromExchange,
  };
}

export interface ChargeInput {
  entryPrice: number;
  exitPrice: number | null;
  quantity: number;
  grossPnlUsd: number;
  /** Entries rest as limit orders (maker); stops and targets cross the book (taker). */
  entryLiquidity?: "taker" | "maker";
  exitLiquidity?: "taker" | "maker";
  exchangeEntryFeeUsd?: number;
  exchangeExitFeeUsd?: number;
  /** Delta's published rates for this product; falls back to the configured pair. */
  feeRates?: { makerFeeRate: number; takerFeeRate: number };
}

/** Full round-trip charge and tax breakdown for one trade. */
export function computeTradeCharges(input: ChargeInput): TradeCharges {
  const entryNotional = input.entryPrice * input.quantity;
  // An open trade has no exit yet; value the exit leg at the entry so the
  // estimate is not silently half the real cost.
  const exitNotional = (input.exitPrice ?? input.entryPrice) * input.quantity;

  const entry = sideCharges(entryNotional, input.entryLiquidity ?? "maker", input.exchangeEntryFeeUsd, input.feeRates);
  const exit = sideCharges(exitNotional, input.exitLiquidity ?? "taker", input.exchangeExitFeeUsd, input.feeRates);

  const totalUsd = entry.totalUsd + exit.totalUsd;
  const netPnlUsd = input.grossPnlUsd - totalUsd;
  const incomeTaxProvisionUsd = netPnlUsd > 0 ? netPnlUsd * effectiveIncomeTaxRate() : 0;

  return {
    entry,
    exit,
    totalUsd,
    totalInr: totalUsd * chargeConfig.usdInr,
    grossPnlUsd: input.grossPnlUsd,
    netPnlUsd,
    incomeTaxProvisionUsd,
    afterTaxPnlUsd: netPnlUsd - incomeTaxProvisionUsd,
    rates: {
      // Report the rates this calculation actually used, not the configured fallbacks.
      takerFeeRate: input.feeRates?.takerFeeRate ?? chargeConfig.takerFeeRate,
      makerFeeRate: input.feeRates?.makerFeeRate ?? chargeConfig.makerFeeRate,
      gstRate: chargeConfig.gstRate,
      tdsRate: chargeConfig.tdsRate,
      incomeTaxRate: chargeConfig.incomeTaxRate,
      cessRate: chargeConfig.cessRate,
      effectiveIncomeTaxRate: effectiveIncomeTaxRate(),
      usdInr: chargeConfig.usdInr,
    },
    estimated: !entry.fromExchange || !exit.fromExchange,
  };
}

/**
 * Financial-year tax position across many trades.
 *
 * s.115BBH does not allow a loss on one VDA to be set off against a gain on
 * another, so the taxable base is the sum of the WINNERS alone. Reporting
 * net-of-losses here would understate the liability, sometimes badly.
 */
export function taxSummary(netPnls: number[]) {
  const gains = netPnls.filter((p) => p > 0);
  const losses = netPnls.filter((p) => p < 0);
  const totalGain = gains.reduce((s, p) => s + p, 0);
  const totalLoss = Math.abs(losses.reduce((s, p) => s + p, 0));
  const taxable = totalGain; // losses are NOT deductible under 115BBH
  const tax = taxable * effectiveIncomeTaxRate();
  return {
    winningTrades: gains.length,
    losingTrades: losses.length,
    totalGainUsd: totalGain,
    totalLossUsd: totalLoss,
    netPnlUsd: totalGain - totalLoss,
    taxableGainUsd: taxable,
    estimatedTaxUsd: tax,
    estimatedTaxInr: tax * chargeConfig.usdInr,
    afterTaxUsd: totalGain - totalLoss - tax,
    effectiveRate: effectiveIncomeTaxRate(),
    note:
      "Section 115BBH taxes each gain at 30% plus 4% cess and does not allow losses to be set off, " +
      "so the taxable base is the sum of winning trades only. This is a provision for planning, not a filing.",
  };
}

/** Financial year label for a timestamp: India's runs 1 April to 31 March. */
export function financialYear(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const startYear = d.getMonth() >= 3 ? y : y - 1; // month 3 = April
  return `FY${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}
