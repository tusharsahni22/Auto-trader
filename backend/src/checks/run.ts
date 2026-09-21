/**
 * Dependency-free checks for the two places where a silent mistake costs real money:
 * the ledger merge (which decides whether a trade survives) and the charge/tax model
 * (which decides whether a trade is reported as a win or a loss).
 *
 *   npm run check
 *
 * Plain asserts and a non-zero exit, so this runs anywhere without a test framework.
 */
import { mergeStores } from "../db.js";
import { computeTradeCharges, taxSummary, financialYear, effectiveIncomeTaxRate, chargeConfig } from "../services/charges.js";

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    passed++;
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Floating-point comparison; charge maths never needs more than this. */
const near = (a: number, b: number, tolerance = 1e-9) => Math.abs(a - b) < tolerance;

// ── Ledger merge ────────────────────────────────────────────────────────────────
// Regression guard for a bug that permanently destroyed trades: the store used to be
// REPLACED by whichever copy was read last, so a failed MongoDB write meant the next
// read dropped the trade from memory and the next save wrote that loss to disk.
function trade(id: string, extra: Record<string, unknown> = {}) {
  return { id, status: "OPEN", fills: [], exitTime: null, ...extra } as never;
}
const store = (trades: Record<string, never>, kv: Record<string, string> = {}) => ({ trades, equityCurve: {}, kv });

function ledgerChecks() {
  console.log("Ledger merge");

  const local = store({ a: trade("a"), b: trade("b"), c: trade("c") }, { local: "1" });
  const staleRemote = store({ a: trade("a"), b: trade("b") });
  const merged = mergeStores(local, staleRemote).store;
  check("a trade missing from MongoDB is not deleted", Object.keys(merged.trades).length === 3, `${Object.keys(merged.trades).length} trades`);
  check("a kv key missing from MongoDB is not deleted", merged.kv.local === "1");

  const pulled = mergeStores(store({ a: trade("a") }), store({ a: trade("a"), z: trade("z") }));
  check("a trade only MongoDB has is pulled in", Object.keys(pulled.store.trades).length === 2 && pulled.added === 1);

  const localNewer = mergeStores(
    store({ a: trade("a", { updatedAt: 200, stopPrice: 111 }) }),
    store({ a: trade("a", { updatedAt: 100, stopPrice: 999 }) })
  ).store.trades as Record<string, { stopPrice: number }>;
  check("the newer copy wins when local is newer", localNewer.a.stopPrice === 111);

  const remoteNewer = mergeStores(
    store({ a: trade("a", { updatedAt: 100, stopPrice: 111 }) }),
    store({ a: trade("a", { updatedAt: 300, stopPrice: 999 }) })
  ).store.trades as Record<string, { stopPrice: number }>;
  check("the newer copy wins when remote is newer", remoteNewer.a.stopPrice === 999);

  // Rows written before `updatedAt` existed have to fall back to observable progress.
  const open = store({ a: trade("a") });
  const closed = store({ a: trade("a", { status: "CLOSED", exitTime: 5 }) });
  const t = (s: ReturnType<typeof mergeStores>) => (s.store.trades as Record<string, { status: string }>).a;
  check("a CLOSED copy supersedes an OPEN one", t(mergeStores(open, closed)).status === "CLOSED");
  check("an OPEN copy never overwrites a CLOSED one", t(mergeStores(closed, open)).status === "CLOSED");

  const fill = { time: 0, price: 0, fraction: 0, reason: "", pnlUsd: 0 };
  const few = store({ a: trade("a", { fills: [fill] }) });
  const many = store({ a: trade("a", { fills: [fill, fill, fill] }) });
  const fills = (s: ReturnType<typeof mergeStores>) => s.store.trades.a.fills.length;
  check("more fills supersede fewer", fills(mergeStores(few, many)) === 3);
  check("fewer fills never overwrite more", fills(mergeStores(many, few)) === 3);

  const survived = mergeStores(store({ a: trade("a"), b: trade("b"), c: trade("c"), d: trade("d") }), store({})).store;
  check("an empty MongoDB document never empties the ledger", Object.keys(survived.trades).length === 4);
}

// ── Charges and tax ─────────────────────────────────────────────────────────────
function chargeChecks() {
  console.log("Delta India charges and tax");

  // $1,000 notional per side, taker both ways.
  const flat = computeTradeCharges({ entryPrice: 100_000, exitPrice: 100_000, quantity: 0.01, grossPnlUsd: 0, entryLiquidity: "taker", exitLiquidity: "taker" });
  check("taker fee is the configured rate of notional", near(flat.entry.feeUsd, 1000 * chargeConfig.takerFeeRate));
  check("GST is charged on the fee, not the notional", near(flat.entry.gstUsd, flat.entry.feeUsd * chargeConfig.gstRate));
  check("both legs are charged", near(flat.totalUsd, flat.entry.totalUsd + flat.exit.totalUsd));
  check("a flat round trip nets a loss equal to the charges", near(flat.netPnlUsd, -flat.totalUsd));

  const maker = computeTradeCharges({ entryPrice: 100_000, exitPrice: 100_000, quantity: 0.01, grossPnlUsd: 0, entryLiquidity: "maker", exitLiquidity: "taker" });
  check("the maker rate is cheaper than the taker rate", maker.entry.feeUsd < flat.entry.feeUsd);

  // Delta bills fee + GST as one commission line, so it must be split, never grossed up again.
  const reported = computeTradeCharges({ entryPrice: 100_000, exitPrice: 100_000, quantity: 0.01, grossPnlUsd: 0, exchangeEntryFeeUsd: 1.18, exchangeExitFeeUsd: 1.18 });
  check("an exchange commission is split into fee and GST, not re-taxed", near(reported.entry.feeUsd + reported.entry.gstUsd, 1.18, 1e-9));
  check("the fee backed out of a commission excludes GST", near(reported.entry.feeUsd, 1.18 / 1.18));
  check("a reported commission is not flagged as estimated", reported.entry.fromExchange && reported.exit.fromExchange && !reported.estimated);

  // A small gross profit can be a net loss once both legs are charged. This is the
  // case that made losing trades read as wins on the dashboard.
  const marginal = computeTradeCharges({ entryPrice: 100_000, exitPrice: 100_020, quantity: 0.01, grossPnlUsd: 0.2, entryLiquidity: "taker", exitLiquidity: "taker" });
  check("a thin gross win becomes a net loss after charges", marginal.grossPnlUsd > 0 && marginal.netPnlUsd < 0, `net ${marginal.netPnlUsd.toFixed(4)}`);
  check("no tax is provisioned on a net loss", marginal.incomeTaxProvisionUsd === 0);

  const winner = computeTradeCharges({ entryPrice: 100_000, exitPrice: 110_000, quantity: 0.01, grossPnlUsd: 100 });
  check("tax is provisioned at 30% plus cess on the NET gain", near(winner.incomeTaxProvisionUsd, winner.netPnlUsd * effectiveIncomeTaxRate()));
  check("the effective rate is 31.2%", near(effectiveIncomeTaxRate(), 0.312, 1e-12));
  check("after-tax P&L is net minus the provision", near(winner.afterTaxPnlUsd, winner.netPnlUsd - winner.incomeTaxProvisionUsd));

  // s.115BBH does not allow a loss on one VDA to offset a gain on another.
  const summary = taxSummary([100, -100, 50]);
  check("losses are not set off against gains", near(summary.taxableGainUsd, 150), `taxable ${summary.taxableGainUsd}`);
  check("tax is charged on winners alone", near(summary.estimatedTaxUsd, 150 * effectiveIncomeTaxRate()));
  check("net P&L is still reported honestly alongside it", near(summary.netPnlUsd, 50));
  check("a loss-only year owes nothing", taxSummary([-10, -20]).estimatedTaxUsd === 0);

  // India's financial year runs 1 April to 31 March.
  check("31 March falls in the previous financial year", financialYear(Date.UTC(2026, 2, 31)) === "FY2025-26", financialYear(Date.UTC(2026, 2, 31)));
  check("1 April starts a new financial year", financialYear(Date.UTC(2026, 3, 1)) === "FY2026-27", financialYear(Date.UTC(2026, 3, 1)));
}

ledgerChecks();
chargeChecks();

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
