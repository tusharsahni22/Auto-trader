/**
 * Is the Delta connection actually working?
 *
 * Every signed request can fail for a reason that is not transient — an API key
 * whose IP allowlist no longer contains this host being the common one, because a
 * residential or cloud IP changes without warning. When that happens every order,
 * every close and every balance read starts returning 401, and the engine used to
 * carry on regardless: it opened positions locally that the exchange never saw,
 * marked trades closed that were still open on Delta, and sized new trades off a
 * frozen balance.
 *
 * This module makes that state explicit and refusable. `recordSuccess` and
 * `recordFailure` are called from the Delta client around every authenticated
 * call; everything else reads `exchangeHealth()` to decide whether it is safe to
 * act. A fatal auth error is sticky — it does not clear on a retry, only on a
 * genuine success — so the engine fails closed instead of thrashing.
 */

export type ExchangeFault =
  | "IP_NOT_WHITELISTED"
  | "INVALID_KEY"
  | "CLOCK_SKEW"
  | "RATE_LIMITED"
  | "UNREACHABLE"
  | "OTHER";

interface HealthState {
  healthy: boolean;
  fault: ExchangeFault | null;
  message: string | null;
  /** Delta echoes the rejected IP back; that is exactly what must be allowlisted. */
  clientIp: string | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  consecutiveFailures: number;
}

const state: HealthState = {
  healthy: false,
  fault: null,
  message: null,
  clientIp: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  consecutiveFailures: 0,
};

/** Faults that a retry cannot fix — they need a human to change something. */
const FATAL: ExchangeFault[] = ["IP_NOT_WHITELISTED", "INVALID_KEY", "CLOCK_SKEW"];

export function classifyDeltaError(error: unknown): { fault: ExchangeFault; clientIp: string | null } {
  const raw = error instanceof Error ? error.message : String(error);
  const text = raw.toLowerCase();

  // Delta returns the rejected address in the error context; capture it so the
  // operator is told the exact IP to allowlist rather than having to go find it.
  const ipMatch = raw.match(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/);
  const clientIp = ipMatch ? ipMatch[1] : null;

  if (text.includes("ip_not_whitelisted")) return { fault: "IP_NOT_WHITELISTED", clientIp };
  if (text.includes("invalid_api_key") || text.includes("unauthorized")) return { fault: "INVALID_KEY", clientIp };
  if (text.includes("signature") || text.includes("expired")) return { fault: "CLOCK_SKEW", clientIp };
  if (text.includes("429") || text.includes("rate limit")) return { fault: "RATE_LIMITED", clientIp };
  if (text.includes("fetch failed") || text.includes("econn") || text.includes("timeout") || text.includes("enotfound")) {
    return { fault: "UNREACHABLE", clientIp };
  }
  return { fault: "OTHER", clientIp };
}

function advice(fault: ExchangeFault, clientIp: string | null): string {
  switch (fault) {
    case "IP_NOT_WHITELISTED":
      return `Delta rejected this host's IP${clientIp ? ` (${clientIp})` : ""}. Add it to the API key's allowlist in the Delta dashboard (API Keys -> edit -> IP whitelist). Until then NO order, close or balance read can succeed.`;
    case "INVALID_KEY":
      return "Delta rejected the API key. Keys are environment-specific: an India-testnet key is refused by the global testnet and by production. Check DELTA_EXCHANGE_BASE_URL matches where the key was issued.";
    case "CLOCK_SKEW":
      return "Delta rejected the request signature, which usually means this host's clock has drifted. Sync it (systemd-timesyncd / chrony / Docker host time).";
    case "RATE_LIMITED":
      return "Delta is rate limiting this key. Requests will resume once the window clears.";
    case "UNREACHABLE":
      return "Delta could not be reached from this host — network, DNS or firewall.";
    default:
      return "Delta returned an unexpected error; see the message.";
  }
}

export function recordSuccess(): void {
  const wasUnhealthy = !state.healthy;
  state.healthy = true;
  state.fault = null;
  state.message = null;
  state.clientIp = null;
  state.lastSuccessAt = Date.now();
  state.consecutiveFailures = 0;
  if (wasUnhealthy) console.log("[exchange] Delta connection is healthy again");
}

export function recordFailure(error: unknown): ExchangeFault {
  const { fault, clientIp } = classifyDeltaError(error);
  const message = error instanceof Error ? error.message : String(error);

  state.lastFailureAt = Date.now();
  state.consecutiveFailures++;
  if (clientIp) state.clientIp = clientIp;

  // A fatal fault is sticky until a genuine success clears it. Without this a
  // later unrelated error — a transient 500 on a ticker, say — overwrote the
  // "your IP is not allowlisted" diagnosis with a generic one, throwing away the
  // only message that told the operator what to actually fix.
  const currentIsFatal = state.fault !== null && FATAL.includes(state.fault);
  if (!currentIsFatal || FATAL.includes(fault)) {
    state.fault = fault;
    state.message = message;
  }

  // A transient blip should not stop trading, but an auth fault is not a blip:
  // every subsequent call will fail the same way until a human intervenes.
  if (FATAL.includes(fault)) {
    if (state.healthy) console.error(`[exchange] FATAL: ${advice(fault, clientIp)}`);
    state.healthy = false;
  } else if (state.consecutiveFailures >= 3) {
    state.healthy = false;
  }
  return fault;
}

export function exchangeHealth() {
  return {
    ...state,
    fatal: state.fault !== null && FATAL.includes(state.fault),
    advice: state.fault ? advice(state.fault, state.clientIp) : null,
    staleForMs: state.lastSuccessAt ? Date.now() - state.lastSuccessAt : null,
  };
}

/**
 * True when it is safe to act on the exchange. Before the first successful call
 * this is false — "not yet proven" is treated as "not safe", which is the whole
 * point of failing closed.
 */
export function isExchangeUsable(): boolean {
  return state.healthy;
}

/** One authenticated call at boot, so a broken key is found before the first signal. */
export async function preflight(): Promise<ReturnType<typeof exchangeHealth>> {
  try {
    const { getDeltaBalance } = await import("./deltaExchange.js");
    await getDeltaBalance();
  } catch {
    /* getDeltaBalance already routed the error through recordFailure */
  }
  const health = exchangeHealth();
  if (health.healthy) console.log("[exchange] preflight OK — Delta accepted an authenticated request");
  else console.error(`[exchange] preflight FAILED — ${health.advice ?? health.message}`);
  return health;
}
