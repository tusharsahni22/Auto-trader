import { useEffect, useState } from "react";
import { AlertTriangle, CalendarClock, ExternalLink, Newspaper } from "lucide-react";
import clsx from "clsx";
import { api, type NewsBlackout } from "../lib/api";

interface NewsEvent {
  eventId: string;
  title: string;
  description?: string;
  category: "ECONOMIC" | "CRYPTO" | "REGULATORY" | "TECHNICAL" | "GENERAL";
  priority: "LOW" | "MEDIUM" | "HIGH";
  eventTime: string;
  publishedAt: string;
  source: string;
  sourceUrl?: string;
  assets: string[];
  economicData?: {
    indicator: string;
    actual?: number;
    forecast?: number;
    previous?: number;
  };
}

interface Props {
  hoursAhead?: number;
  assets?: string[];
  /**
   * "both" keeps the original tabbed panel. "news" and "calendar" render one feed
   * only, so the dashboard can show market headlines and the economic schedule as
   * two separate panels rather than two tabs competing for one column.
   */
  mode?: "both" | "news" | "calendar";
}

/** Impact drives the left rail and the source chip so severity scans down the column. */
function impactStyle(priority: string) {
  if (priority === "HIGH") return { bar: "bg-bear", chip: "text-bear bg-bear/15" };
  if (priority === "MEDIUM") return { bar: "bg-warn", chip: "text-warn bg-warn/15" };
  return { bar: "bg-accent/60", chip: "text-accent bg-accent/10" };
}

const SOURCE_CHIP: Record<string, string> = {
  coindesk: "text-sky-300 bg-sky-500/10 border-sky-500/25",
  cointelegraph: "text-amber-300 bg-amber-500/10 border-amber-500/25",
  "bitcoin.com": "text-orange-300 bg-orange-500/10 border-orange-500/25",
};

const sourceChip = (source: string) =>
  SOURCE_CHIP[(source || "").toLowerCase()] ?? "text-ink-muted bg-bg-raised border-bg-border";

function timeAgo(iso: string) {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function eventTime(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const diffMin = (d.getTime() - now.getTime()) / 60000;
  return {
    label: sameDay ? time : `${d.toLocaleDateString([], { weekday: "short" })} ${time}`,
    soon: diffMin >= 0 && diffMin <= 60,
    past: diffMin < -5,
  };
}

/** The currency code the backend embeds in the source string, e.g. "… (USD)". */
function currencyOf(source: string) {
  return source.match(/\(([A-Z]{3})\)/)?.[1] ?? "—";
}

export default function NewsCalendar({ hoursAhead = 48, assets = ["BTC", "ETH"], mode = "both" }: Props) {
  const [events, setEvents] = useState<NewsEvent[]>([]);
  const [blackout, setBlackout] = useState<NewsBlackout | null>(null);
  const [loading, setLoading] = useState(true);
  const [calendarError, setCalendarError] = useState<string | null>(null);
  const [calendarSource, setCalendarSource] = useState<string | null>(null);
  const [tab, setTab] = useState<"news" | "calendar">(mode === "news" ? "news" : "calendar");
  const [priorities, setPriorities] = useState<string[]>([]);

  const fetchEvents = async () => {
    try {
      const params = new URLSearchParams({
        hoursAhead: String(hoursAhead),
        assets: assets.join(","),
        limit: "200",
      });
      if (priorities.length) params.set("priority", priorities.join(","));

      const response = await fetch(`/api/news-calendar/upcoming?${params}`);
      const data = await response.json();
      setEvents(data.events ?? []);
    } catch {
      /* keep the last good render */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchEvents();
    api.newsBlackout().then(setBlackout).catch(() => {});
    fetch("/api/news-calendar/stats")
      .then((r) => r.json())
      .then((d) => {
        setCalendarError(d.economicCalendarError ?? null);
        setCalendarSource(d.economicCalendarSource ?? null);
      })
      .catch(() => {});
    const id = setInterval(() => {
      fetchEvents();
      api.newsBlackout().then(setBlackout).catch(() => {});
    }, 180_000);
    return () => clearInterval(id);
  }, [priorities.join(","), hoursAhead, assets.join(",")]);

  const togglePriority = (p: string) =>
    setPriorities((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));

  const economic = events.filter((e) => e.category === "ECONOMIC");
  const headlines = events
    .filter((e) => e.category !== "ECONOMIC")
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

  // A single-mode panel ignores the tab state entirely.
  const view = mode === "both" ? tab : mode;
  const rows = view === "calendar" ? economic : headlines;
  const title = mode === "calendar" ? "Economic calendar" : mode === "news" ? "Market news" : "News & calendar";

  return (
    <div className="panel flex flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-bg-border px-3 py-2">
        <h2 className="section-label">{title}</h2>
        <span className="flex items-center gap-1.5 text-[11px] text-ink-faint">
          {mode === "calendar" && calendarSource && (
            <span className="text-[10px]" title="Source of the economic schedule">
              {calendarSource === "forexfactory" ? "ForexFactory" : "FCS"}
            </span>
          )}
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
          live
        </span>
      </div>

      {/* Blackout is the one thing here that changes trading behaviour, so it
          sits above the feeds rather than inside them. */}
      {blackout?.active && blackout.event && (
        <div className="flex items-start gap-1.5 border-b border-warn/30 bg-warn/10 px-3 py-2 text-[11px] text-warn">
          <AlertTriangle size={12} className="mt-px shrink-0" />
          <span>
            <strong>New entries paused</strong> — {blackout.event.title} in {blackout.event.minutesAway}m
            (±{blackout.minutes}m window). Open positions still managed.
          </span>
        </div>
      )}

      <div className="flex items-center gap-1 border-b border-bg-border px-2 py-1.5">
        {mode === "both" ? (
          (
            [
              { id: "calendar", icon: CalendarClock, label: "Calendar", n: economic.length },
              { id: "news", icon: Newspaper, label: "Headlines", n: headlines.length },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={clsx(
                "flex items-center gap-1 rounded px-2 py-1 text-[10px] font-semibold uppercase tracking-wider transition",
                tab === t.id
                  ? "border border-bg-border bg-bg-raised text-ink"
                  : "border border-transparent text-ink-faint hover:text-ink-muted"
              )}
            >
              <t.icon size={11} /> {t.label}
              <span className="text-[9px] font-normal text-ink-faint">{t.n}</span>
            </button>
          ))
        ) : (
          <span className="flex items-center gap-1 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
            {mode === "calendar" ? <CalendarClock size={11} /> : <Newspaper size={11} />}
            {rows.length} {mode === "calendar" ? "events" : "headlines"}
          </span>
        )}

        <div className="ml-auto flex items-center gap-1">
          {["HIGH", "MEDIUM", "LOW"].map((p) => (
            <button
              key={p}
              onClick={() => togglePriority(p)}
              className={clsx(
                "rounded px-1.5 py-0.5 text-[9px] font-semibold transition",
                priorities.includes(p) ? impactStyle(p).chip : "bg-bg-raised text-ink-faint hover:text-ink-muted"
              )}
            >
              {p[0]}
            </button>
          ))}
        </div>
      </div>

      <div className="max-h-[320px] divide-y divide-bg-border/60 overflow-y-auto">
        {loading && rows.length === 0 ? (
          <p className="px-3 py-4 text-xs text-ink-faint">Loading…</p>
        ) : rows.length === 0 ? (
          <div className="px-3 py-4 text-xs text-ink-faint">
            {view === "calendar" ? (
              calendarError ? (
                <span className="text-warn">Calendar unavailable — {calendarError}</span>
              ) : (
                "No economic events in this window."
              )
            ) : (
              "No headlines right now."
            )}
          </div>
        ) : view === "calendar" ? (
          rows.map((e) => {
            const style = impactStyle(e.priority);
            const t = eventTime(e.eventTime);
            return (
              <div
                key={e.eventId}
                className={clsx("relative py-2 pl-4 pr-3 transition hover:bg-bg-raised", t.past && "opacity-50")}
              >
                <span className={clsx("absolute bottom-0 left-0 top-0 w-[3px]", style.bar)} title={e.priority} />
                <div className="flex items-center gap-2">
                  <span
                    className={clsx(
                      "w-9 shrink-0 rounded px-1 py-0.5 text-center text-[10px] font-bold tracking-wide",
                      style.chip
                    )}
                  >
                    {currencyOf(e.source)}
                  </span>
                  <span className="line-clamp-1 flex-1 text-xs leading-snug text-ink">{e.title}</span>
                  <span
                    className={clsx(
                      "shrink-0 text-[10px] tabular-nums",
                      t.soon ? "font-semibold text-accent" : "text-ink-faint"
                    )}
                  >
                    {t.label}
                  </span>
                </div>
                {e.economicData &&
                  (e.economicData.actual !== undefined ||
                    e.economicData.forecast !== undefined ||
                    e.economicData.previous !== undefined) && (
                    <div className="mt-1 flex items-center gap-3 pl-11 text-[10px] tabular-nums">
                      {e.economicData.actual !== undefined && (
                        <span className="text-ink-faint">
                          A <span className="font-semibold text-ink">{e.economicData.actual}</span>
                        </span>
                      )}
                      {e.economicData.forecast !== undefined && (
                        <span className="text-ink-faint">
                          F <span className="text-accent">{e.economicData.forecast}</span>
                        </span>
                      )}
                      {e.economicData.previous !== undefined && (
                        <span className="text-ink-faint">
                          P <span className="text-ink-muted">{e.economicData.previous}</span>
                        </span>
                      )}
                    </div>
                  )}
              </div>
            );
          })
        ) : (
          rows.map((e) => (
            <a
              key={e.eventId}
              href={e.sourceUrl || undefined}
              target="_blank"
              rel="noopener noreferrer"
              className="group block px-3 py-2 transition hover:bg-bg-raised"
            >
              <div className="mb-0.5 flex items-center gap-2">
                <span className={clsx("h-1.5 w-1.5 shrink-0 rounded-full", impactStyle(e.priority).bar)} />
                <span
                  className={clsx(
                    "max-w-[120px] shrink-0 truncate rounded border px-1.5 py-px text-[9px] font-semibold",
                    sourceChip(e.source)
                  )}
                >
                  {e.source}
                </span>
                <span className="ml-auto shrink-0 text-[10px] text-ink-faint">{timeAgo(e.publishedAt)}</span>
              </div>
              <p className="flex items-start gap-1 text-xs leading-snug text-ink-muted group-hover:text-ink">
                <span className="line-clamp-2">{e.title}</span>
                <ExternalLink
                  size={10}
                  className="mt-0.5 shrink-0 text-ink-faint opacity-0 transition group-hover:opacity-100"
                />
              </p>
            </a>
          ))
        )}
      </div>
    </div>
  );
}
