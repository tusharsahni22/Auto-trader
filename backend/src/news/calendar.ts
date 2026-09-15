import fetch from "node-fetch";

/**
 * Free, no-key macro economic calendar (ForexFactory's public weekly JSON
 * feed — widely used, unofficial but stable). Gives docs/01 §7 G7's
 * EVENT_BLACKOUT gate something real to check against instead of being
 * permanently skipped, and lets the UI show upcoming/past tier-1 events
 * (CPI, FOMC, NFP, rate decisions) even though this system trades crypto,
 * because BTC/ETH trade macro risk-on/off alongside everything else.
 */

export interface MacroEvent {
  title: string;
  country: string;
  date: number; // ms epoch
  impact: "High" | "Medium" | "Low";
  forecast?: string;
  previous?: string;
  actual?: string;
}

const CALENDAR_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const TIER1_TITLES = /CPI|FOMC|Federal Funds Rate|Non-Farm|NFP|Interest Rate Decision|GDP|PCE/i;

let cache: { events: MacroEvent[]; fetchedAt: number } = { events: [], fetchedAt: 0 };
const CACHE_TTL_MS = 30 * 60 * 1000;

interface RawEvent {
  title: string;
  country: string;
  date: string;
  impact: string;
  forecast?: string;
  previous?: string;
  actual?: string;
}

export async function refreshCalendar(): Promise<void> {
  try {
    const res = await fetch(CALENDAR_URL, { headers: { "User-Agent": "auto-trader/0.1" } });
    if (!res.ok) return;
    const raw = (await res.json()) as RawEvent[];
    const events: MacroEvent[] = raw
      .map((r) => ({
        title: r.title,
        country: r.country,
        date: Date.parse(r.date),
        impact: (r.impact as MacroEvent["impact"]) ?? "Low",
        forecast: r.forecast,
        previous: r.previous,
        actual: r.actual,
      }))
      .filter((e) => !Number.isNaN(e.date));
    cache = { events, fetchedAt: Date.now() };
  } catch (e) {
    console.warn("[calendar] fetch failed", (e as Error).message);
  }
}

export function getUpcomingEvents(withinHours = 24 * 7): MacroEvent[] {
  const now = Date.now();
  return cache.events.filter((e) => e.date > now && e.date - now <= withinHours * 3600 * 1000).sort((a, b) => a.date - b.date);
}

export function getPastEvents(withinHours = 24 * 7): MacroEvent[] {
  const now = Date.now();
  return cache.events
    .filter((e) => e.date <= now && now - e.date <= withinHours * 3600 * 1000)
    .sort((a, b) => b.date - a.date);
}

/** Hours until the next tier-1 (CPI/FOMC/NFP/rate-decision) event, for the EVENT_BLACKOUT gate. */
export function hoursToNextTier1Event(): number {
  const now = Date.now();
  const tier1 = cache.events.filter((e) => e.date > now && e.impact === "High" && TIER1_TITLES.test(e.title));
  if (tier1.length === 0) return 999;
  const next = tier1.sort((a, b) => a.date - b.date)[0];
  return (next.date - now) / 3600000;
}

export function startCalendarRefresh() {
  refreshCalendar();
  setInterval(refreshCalendar, CACHE_TTL_MS);
}

export function getCalendarFetchedAt(): number {
  return cache.fetchedAt;
}
