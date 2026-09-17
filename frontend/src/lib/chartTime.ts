import { TickMarkType, type Time } from "lightweight-charts";

export type ChartTimezone = "local" | "utc";

/**
 * lightweight-charts renders numeric timestamps as UTC. These formatters let the
 * same underlying data be displayed in either UTC or the viewer's own zone, so
 * the timestamps stay canonical and only the labels change.
 */

/** Zones whose common abbreviation browsers don't reliably expose. */
const ZONE_ABBREVIATIONS: Record<string, string> = {
  "Asia/Kolkata": "IST",
  "Asia/Calcutta": "IST",
};

export function localZoneLabel(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone && ZONE_ABBREVIATIONS[zone]) return ZONE_ABBREVIATIONS[zone];

    const name = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName")?.value;

    // Browsers give either an abbreviation ("CET") or an offset ("GMT+5:30").
    if (name && /^[A-Z]{2,5}$/.test(name)) return name;

    const offsetMinutes = -new Date().getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? "+" : "-";
    const abs = Math.abs(offsetMinutes);
    const hh = Math.floor(abs / 60);
    const mm = abs % 60;
    return `UTC${sign}${hh}${mm ? ":" + String(mm).padStart(2, "0") : ""}`;
  } catch {
    return "Local";
  }
}

function toDate(time: Time): Date {
  if (typeof time === "number") return new Date(time * 1000);
  const d = time as { year: number; month: number; day: number };
  return new Date(Date.UTC(d.year, d.month - 1, d.day));
}

function options(timezone: ChartTimezone, base: Intl.DateTimeFormatOptions): Intl.DateTimeFormatOptions {
  return timezone === "utc" ? { ...base, timeZone: "UTC" } : base;
}

export function makeTickFormatter(timezone: ChartTimezone) {
  return (time: Time, tickMarkType: TickMarkType, locale: string): string => {
    const date = toDate(time);
    switch (tickMarkType) {
      case TickMarkType.Year:
        return date.toLocaleDateString(locale, options(timezone, { year: "numeric" }));
      case TickMarkType.Month:
        return date.toLocaleDateString(locale, options(timezone, { month: "short" }));
      case TickMarkType.DayOfMonth:
        return date.toLocaleDateString(locale, options(timezone, { day: "numeric", month: "short" }));
      case TickMarkType.TimeWithSeconds:
        return date.toLocaleTimeString(
          locale,
          options(timezone, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
        );
      default:
        return date.toLocaleTimeString(locale, options(timezone, { hour: "2-digit", minute: "2-digit" }));
    }
  };
}

export function makeCrosshairFormatter(timezone: ChartTimezone) {
  return (time: Time): string =>
    toDate(time).toLocaleString(
      undefined,
      options(timezone, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
    );
}
