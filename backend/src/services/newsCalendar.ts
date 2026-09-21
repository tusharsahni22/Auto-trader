/**
 * News and Economic Calendar Service
 *
 * Events live in an in-memory store so the calendar works without a database.
 * MongoDB, when connected, is a best-effort persistence layer on top of it —
 * a Mongo outage must never make the calendar hang or disappear.
 */

// FIX: Global broadcaster so high-impact news articles can be sent as chart
// markers to the frontend via the WebSocket bus. Set by index.ts at startup.
type Broadcaster = (event: string, payload: unknown) => void;
let _broadcaster: Broadcaster | null = null;
export function setNewsCalendarBroadcaster(fn: Broadcaster) { _broadcaster = fn; }

const BULLISH_WORDS = ['surge', 'rally', 'soar', 'bullish', 'breakout', 'record high', 'all-time high', 'ath', 'gain', 'jump', 'adoption', 'approve', 'approval', 'inflow', 'upgrade', 'etf approved', 'institutional'];
const BEARISH_WORDS = ['crash', 'plunge', 'slump', 'bearish', 'sell-off', 'selloff', 'hack', 'exploit', 'ban', 'lawsuit', 'outflow', 'liquidation', 'fear', 'downgrade', 'collapse', 'bankrupt', 'fraud', 'seized'];

/**
 * Keyword-scored sentiment in [-1, 1] for a block of text.
 * Returns positive for bullish news, negative for bearish.
 */
export function scoreNewsSentiment(text: string): number {
  const lower = text.toLowerCase();
  let score = 0;
  for (const w of BULLISH_WORDS) if (lower.includes(w)) score += 1;
  for (const w of BEARISH_WORDS) if (lower.includes(w)) score -= 1;
  return Math.max(-1, Math.min(1, score));
}

/**
 * Aggregate sentiment score across the most recent HIGH/MEDIUM crypto news
 * for a given asset. Used by the trading pipeline as a live signal.
 * Returns a value in [-1, 1]: positive = net bullish, negative = net bearish.
 */
export function getNewsSentimentScore(asset: 'BTC' | 'ETH'): number {
  const now = Date.now();
  const cutoff = now - 4 * 60 * 60 * 1000; // only last 4 hours
  const relevant = [...eventStore.values()].filter(
    (e) =>
      e.category === 'CRYPTO' &&
      e.isActive &&
      (e.assets.includes(asset) || e.assets.length === 0) &&
      new Date(e.publishedAt).getTime() >= cutoff &&
      (e.priority === 'HIGH' || e.priority === 'MEDIUM')
  );
  if (relevant.length === 0) return 0;
  const total = relevant.reduce(
    (sum, ev) => sum + scoreNewsSentiment(ev.title + ' ' + (ev.description ?? '')),
    0
  );
  return Math.max(-1, Math.min(1, total / relevant.length));
}


export type EventPriority = 'LOW' | 'MEDIUM' | 'HIGH';
export type EventCategory = 'ECONOMIC' | 'CRYPTO' | 'REGULATORY' | 'TECHNICAL' | 'GENERAL';

export interface CalendarEvent {
  eventId: string;
  title: string;
  description?: string;
  category: EventCategory;
  priority: EventPriority;
  impactScore: number;
  eventTime: string;
  publishedAt: string;
  source: string;
  sourceUrl?: string;
  assets: string[];
  regions: string[];
  economicData?: {
    indicator: string;
    actual?: number;
    forecast?: number;
    previous?: number;
  };
  isActive: boolean;
}

/** Raw record shape from FCS `forex/economy_cal`. */
interface EconomicCalendarEvent {
  id: string;
  title: string;
  indicator: string;
  country: string;
  currency: string;
  /** "1" low · "2" medium · "3" high · "0" holiday/no impact */
  importance: string;
  date: string;
  actual?: string;
  forecast?: string;
  previous?: string;
  unit?: string;
}

interface NewsItem {
  id: string;
  title: string;
  body: string;
  url?: string;
  source: string;
  publishedAt: Date;
}

const eventStore = new Map<string, CalendarEvent>();
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_EVENTS = 2000;
let lastUpdate = 0;

/** Feature config — all optional, with sensible defaults. */
export const newsConfig = {
  enabled: process.env.NEWS_ENABLED !== "false",
  /** Don't open NEW trades within N minutes of a High-impact event (0 disables). */
  blackoutMinutes: Number(process.env.NEWS_BLACKOUT_MIN ?? 15),
  /** Currencies whose events matter; empty means all. */
  currencies: String(process.env.NEWS_CURRENCIES ?? "USD,EUR,GBP,JPY,CNY")
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean),
  refreshSec: Number(process.env.NEWS_REFRESH_SEC ?? 180),
  /**
   * The calendar publishes a whole week at a time, so it needs a far slower clock
   * than headlines. 30 minutes keeps forecast/actual revisions current without
   * provoking the host's rate limiter, which bans for a sustained period once tripped.
   */
  calendarRefreshSec: Number(process.env.NEWS_CALENDAR_REFRESH_SEC ?? 30 * 60),
};

let lastCalendarFetch = 0;
let calendarError: string | null = null;
let calendarSource: 'forexfactory' | 'fcsapi' | null = null;

function putEvent(event: CalendarEvent) {
  eventStore.set(event.eventId, event);
}

/**
 * Bounds the store by age rather than by count. A plain size cap would evict
 * news first — headlines carry past timestamps while the economic feed is
 * mostly future-dated — which is how the feed ends up showing no news at all.
 */
function pruneStaleEvents() {
  const cutoff = Date.now() - RETENTION_MS;
  for (const [id, event] of eventStore) {
    if (new Date(event.eventTime).getTime() < cutoff) eventStore.delete(id);
  }

  if (eventStore.size > MAX_EVENTS) {
    const surplus = [...eventStore.values()]
      .sort((a, b) => new Date(a.eventTime).getTime() - new Date(b.eventTime).getTime())
      .slice(0, eventStore.size - MAX_EVENTS);
    for (const event of surplus) eventStore.delete(event.eventId);
  }
}

/**
 * Reload the store from MongoDB at boot.
 *
 * Both upstreams fail closed in ways that last: ForexFactory answers 429 for a
 * sustained period once it has been polled too hard, and the FCS free tier is
 * capped at 500 calls a MONTH. Without this, a restart inside either window left
 * the calendar completely empty with nothing to show, even though a perfectly good
 * copy of the week was already sitting in the database.
 */
async function hydrateFromMongo(): Promise<number> {
  try {
    const { isMongoConnected } = await import('../db/mongodb.js');
    if (!isMongoConnected()) return 0;
    const { NewsEvent } = await import('../db/models/index.js');
    const cutoff = new Date(Date.now() - RETENTION_MS);
    const docs = await NewsEvent.find({ eventTime: { $gte: cutoff } }).lean();

    let restored = 0;
    for (const doc of docs as any[]) {
      if (!doc?.eventId || eventStore.has(doc.eventId)) continue;
      eventStore.set(doc.eventId, {
        eventId: doc.eventId,
        title: doc.title,
        description: doc.description,
        category: doc.category,
        priority: doc.priority,
        impactScore: doc.impactScore ?? 0,
        eventTime: new Date(doc.eventTime).toISOString(),
        publishedAt: new Date(doc.publishedAt ?? doc.eventTime).toISOString(),
        source: doc.source ?? 'cache',
        sourceUrl: doc.sourceUrl,
        assets: doc.assets ?? [],
        regions: doc.regions ?? [],
        economicData: doc.economicData,
        isActive: doc.isActive !== false,
      });
      restored++;
    }
    if (restored) console.log(`[newsCalendar] restored ${restored} cached events from MongoDB`);
    return restored;
  } catch (error) {
    console.warn('[newsCalendar] cache restore skipped:', (error as Error).message);
    return 0;
  }
}

/** Mirrors an event into MongoDB when available. Never throws. */
async function persistEvent(event: CalendarEvent): Promise<void> {
  try {
    const { isMongoConnected } = await import('../db/mongodb.js');
    if (!isMongoConnected()) return;
    const { NewsEvent } = await import('../db/models/index.js');
    await NewsEvent.findOneAndUpdate(
      { eventId: event.eventId },
      { ...event, eventTime: new Date(event.eventTime), publishedAt: new Date(event.publishedAt) },
      { upsert: true }
    );
  } catch {
    // Persistence is optional — the in-memory store is the source of truth.
  }
}

/**
 * ForexFactory's public weekly JSON, served by FairEconomy. No key, no quota, and
 * it is the same schedule the retail world trades off. This is the primary source.
 *
 * Shape: { title, country (currency code), date (ISO with offset), impact, forecast, previous }.
 */
const FOREX_FACTORY_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';

interface ForexFactoryEvent {
  title?: string;
  country?: string;
  date?: string;
  impact?: string;
  forecast?: string;
  previous?: string;
}

/**
 * The host answers 429 for a sustained period once it has been polled too often,
 * so a failure must back off properly rather than retry on the next tick and renew
 * the ban. Kept as a timestamp we refuse to fetch before.
 */
let calendarRetryAfter = 0;

async function fetchForexFactoryCalendar(): Promise<EconomicCalendarEvent[]> {
  if (Date.now() < calendarRetryAfter) return [];

  try {
    const response = await fetch(FOREX_FACTORY_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; auto-trader/1.0)' },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 429) {
      calendarRetryAfter = Date.now() + 30 * 60_000;
      throw new Error('rate limited by the calendar host (backing off for 30 minutes)');
    }
    if (!response.ok) throw new Error(`calendar feed returned ${response.status}`);

    const raw = (await response.json()) as ForexFactoryEvent[];
    if (!Array.isArray(raw)) throw new Error('calendar feed returned an unexpected shape');

    const events = raw.flatMap((e, i): EconomicCalendarEvent[] => {
      const when = e.date ? new Date(e.date) : null;
      if (!when || Number.isNaN(when.getTime()) || !e.title) return [];
      const currency = String(e.country ?? '').toUpperCase();
      return [{
        // The feed carries no id, so derive a stable one: the same event keeps its
        // identity across refreshes instead of being re-inserted every few minutes.
        id: `ff_${currency}_${when.getTime()}_${String(e.title).replace(/\W+/g, '').slice(0, 24)}_${i}`,
        title: String(e.title),
        indicator: String(e.title),
        country: currency,
        currency,
        importance: IMPACT_TO_IMPORTANCE[String(e.impact ?? '').toLowerCase()] ?? '1',
        // storeEconomicEvents appends "Z"; hand it an already-UTC wall-clock string.
        date: when.toISOString().slice(0, 19).replace('T', ' '),
        forecast: e.forecast || undefined,
        previous: e.previous || undefined,
      }];
    });

    calendarError = null;
    return events;
  } catch (error: any) {
    throw new Error(error?.message ?? String(error));
  }
}

const IMPACT_TO_IMPORTANCE: Record<string, string> = {
  high: '3',
  medium: '2',
  low: '1',
  holiday: '0',
};

/** FCS is a paid, metered fallback used only if it is configured AND ForexFactory failed. */
async function fetchFcsCalendar(): Promise<EconomicCalendarEvent[]> {
  const API_KEY = process.env.ECONOMIC_CALENDAR_API_KEY;
  if (!API_KEY) return [];

  const response = await fetch(
    `https://fcsapi.com/api-v3/forex/economy_cal?access_key=${API_KEY}&from=${getToday()}&to=${getFutureDate(7)}`,
    { signal: AbortSignal.timeout(15_000) }
  );
  if (!response.ok) throw new Error(`FCS returned ${response.status}`);
  const data = (await response.json()) as { status?: boolean; msg?: string; response?: EconomicCalendarEvent[] };
  if (!data.status) throw new Error(data.msg || 'FCS rejected the request');
  return data.response || [];
}

/**
 * Economic calendar, free source first.
 *
 * This used to call FCS only, whose free tier allows 500 calls a MONTH — so the
 * calendar was empty whenever the key was missing, wrong or spent, and the panel
 * showed nothing with no explanation. ForexFactory needs no key at all.
 */
async function fetchEconomicCalendar(): Promise<EconomicCalendarEvent[]> {
  try {
    const events = await fetchForexFactoryCalendar();
    if (events.length) {
      calendarSource = 'forexfactory';
      return events;
    }
    if (Date.now() < calendarRetryAfter) {
      calendarError = 'calendar host is rate limiting; using the last good week';
      return [];
    }
    throw new Error('calendar feed returned no events');
  } catch (primaryError: any) {
    const primaryMessage = primaryError?.message ?? String(primaryError);
    try {
      const fallback = await fetchFcsCalendar();
      if (fallback.length) {
        calendarSource = 'fcsapi';
        calendarError = null;
        console.warn(`[newsCalendar] ForexFactory failed (${primaryMessage}); served ${fallback.length} events from FCS`);
        return fallback;
      }
      calendarError = primaryMessage;
    } catch (fallbackError: any) {
      calendarError = `${primaryMessage}; FCS fallback: ${fallbackError?.message ?? fallbackError}`;
    }
    console.error('[newsCalendar] economic calendar unavailable:', calendarError);
    return [];
  }
}

/**
 * Crypto desks trade macro risk-on/off, so the mix is deliberately not crypto-only:
 * a hawkish Fed headline moves BTC as surely as an ETF approval does. Every feed is
 * public RSS, needs no key, and a dead one only costs its own stories.
 * Override with NEWS_FEEDS as comma-separated `Name|url` pairs.
 */
const DEFAULT_RSS_FEEDS = [
  { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', name: 'CoinDesk' },
  { url: 'https://cointelegraph.com/rss', name: 'Cointelegraph' },
  { url: 'https://news.bitcoin.com/feed/', name: 'Bitcoin.com' },
  { url: 'https://www.forexlive.com/feed/news', name: 'ForexLive' },
  { url: 'https://www.fxstreet.com/rss/news', name: 'FXStreet' },
  { url: 'https://decrypt.co/feed', name: 'Decrypt' },
  { url: 'https://finance.yahoo.com/news/rssindex', name: 'Yahoo Finance' },
];

function configuredFeeds(): { url: string; name: string }[] {
  const raw = process.env.NEWS_FEEDS;
  if (!raw) return DEFAULT_RSS_FEEDS;
  const parsed = raw
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => {
      const [name, url] = token.includes('|') ? token.split('|', 2) : ['', token];
      const finalUrl = (url ?? '').trim();
      return { name: name.trim() || new URL(finalUrl).hostname.replace(/^www\./, ''), url: finalUrl };
    })
    .filter((f) => f.url.startsWith('http'));
  return parsed.length ? parsed : DEFAULT_RSS_FEEDS;
}

const RSS_FEEDS = configuredFeeds();

function decodeXmlText(raw: string): string {
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstTag(block: string, name: string): string {
  const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return match ? decodeXmlText(match[1]) : '';
}

function parseRss(xml: string, sourceName: string): NewsItem[] {
  const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) ?? [];

  return blocks.flatMap((block) => {
    const title = firstTag(block, 'title');
    if (!title) return [];

    const link = firstTag(block, 'link');
    const pubDate = firstTag(block, 'pubDate') || firstTag(block, 'dc:date');
    const published = pubDate ? new Date(pubDate) : new Date();

    return [{
      id: firstTag(block, 'guid') || link || `${sourceName}_${title}`,
      title,
      body: firstTag(block, 'description'),
      url: link || undefined,
      source: sourceName,
      publishedAt: Number.isNaN(published.getTime()) ? new Date() : published,
    }];
  });
}

/**
 * Crypto headlines. RSS is the primary source because it needs no credentials —
 * CryptoCompare's public news endpoint now returns 401 without an API key.
 */
async function fetchCryptoNews(): Promise<NewsItem[]> {
  const items: NewsItem[] = [];

  const feeds = await Promise.allSettled(
    RSS_FEEDS.map(async (feed) => {
      const response = await fetch(feed.url, {
        headers: { 'User-Agent': 'auto-trader' },
        signal: AbortSignal.timeout(5_000), // FIX: never block pipeline for more than 5s
      });
      if (!response.ok) throw new Error(`${feed.name} returned ${response.status}`);
      return parseRss(await response.text(), feed.name);
    })
  );

  for (const [i, result] of feeds.entries()) {
    if (result.status === 'fulfilled') {
      items.push(...result.value);
    } else {
      console.error(`[newsCalendar] ${RSS_FEEDS[i].name} feed failed:`, result.reason);
    }
  }

  const API_KEY = process.env.CRYPTOCOMPARE_API_KEY;
  if (API_KEY) {
    try {
      const response = await fetch(
        `https://min-api.cryptocompare.com/data/v2/news/?lang=EN&api_key=${API_KEY}`
      );
      if (!response.ok) throw new Error(`API returned ${response.status}`);
      const data = (await response.json()) as { Data?: unknown };
      if (Array.isArray(data.Data)) {
        items.push(...data.Data.map((item: any) => ({
          id: `cc_${item.id}`,
          title: item.title,
          body: String(item.body ?? ''),
          url: item.url,
          source: item.source_info?.name || 'CryptoCompare',
          publishedAt: new Date(item.published_on * 1000),
        })));
      }
    } catch (error) {
      console.error('[newsCalendar] CryptoCompare fetch failed:', error);
    }
  }

  return items;
}

function storeEconomicEvents(events: EconomicCalendarEvent[]): number {
  let stored = 0;
  for (const event of events) {
    // FCS timestamps are UTC but carry no zone marker.
    const eventTime = new Date(`${event.date.replace(' ', 'T')}Z`);
    if (Number.isNaN(eventTime.getTime())) continue;

    const priority = mapImportanceToPriority(event.importance);
    const label = event.title || event.indicator;

    const calendarEvent: CalendarEvent = {
      eventId: `eco_${event.id}`,
      title: `${event.country} — ${label}`,
      description: [event.indicator, event.unit].filter(Boolean).join(' · ') || label,
      category: 'ECONOMIC',
      priority,
      impactScore: priority === 'HIGH' ? 80 : priority === 'MEDIUM' ? 50 : 20,
      eventTime: eventTime.toISOString(),
      publishedAt: new Date().toISOString(),
      source: `Economic Calendar (${event.currency})`,
      // Macro releases move crypto, so they stay visible under both asset filters.
      assets: ['BTC', 'ETH'],
      regions: [event.country],
      economicData: {
        indicator: event.indicator,
        actual: numberOrUndefined(event.actual),
        forecast: numberOrUndefined(event.forecast),
        previous: numberOrUndefined(event.previous),
      },
      isActive: true,
    };

    putEvent(calendarEvent);
    void persistEvent(calendarEvent);
    stored++;
  }
  return stored;
}

function storeCryptoNews(newsItems: NewsItem[]): number {
  let stored = 0;
  const newHighImpact: CalendarEvent[] = [];

  for (const item of newsItems) {
    if (Number.isNaN(item.publishedAt.getTime())) continue;

    const priority = classifyNewsPriority(`${item.title} ${item.body}`);
    const publishedAt = item.publishedAt.toISOString();
    const eventId = `news_${item.id}`.replace(/[^a-zA-Z0-9_:./-]/g, '_').slice(0, 200);

    // FIX: Track truly new HIGH-impact articles to broadcast as chart markers
    const isNew = !eventStore.has(eventId);

    const calendarEvent: CalendarEvent = {
      eventId,
      title: item.title,
      description: item.body.substring(0, 500),
      category: 'CRYPTO',
      priority,
      impactScore: priority === 'HIGH' ? 70 : priority === 'MEDIUM' ? 40 : 15,
      eventTime: publishedAt,
      publishedAt,
      source: item.source,
      sourceUrl: item.url,
      assets: extractAssets(`${item.title} ${item.body}`),
      regions: ['GLOBAL'],
      isActive: true,
    };

    putEvent(calendarEvent);
    void persistEvent(calendarEvent);
    stored++;

    if (isNew && priority === 'HIGH') newHighImpact.push(calendarEvent);
  }

  // Broadcast new high-impact articles as chart markers via the global broadcaster
  if (newHighImpact.length > 0 && _broadcaster) {
    for (const ev of newHighImpact) {
      const sentiment = scoreNewsSentiment(ev.title + ' ' + (ev.description ?? ''));
      _broadcaster('news_signal', {
        time: new Date(ev.eventTime).getTime(),
        title: ev.title,
        source: ev.source,
        url: ev.sourceUrl,
        assets: ev.assets,
        sentiment,          // positive = bullish, negative = bearish
        priority: ev.priority,
      });
    }
  }

  return stored;
}

function numberOrUndefined(raw?: string): number | undefined {
  if (!raw) return undefined;
  const parsed = parseFloat(String(raw).replace(/[%,]/g, ''));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function mapImportanceToPriority(importance: string): EventPriority {
  switch (String(importance)) {
    case '3': return 'HIGH';
    case '2': return 'MEDIUM';
    default: return 'LOW';
  }
}

function classifyNewsPriority(text: string): EventPriority {
  const highKeywords = ['crash', 'hack', 'sec ', 'regulation', 'ban', 'etf', 'institutional', 'fed', 'rate'];
  const mediumKeywords = ['upgrade', 'partnership', 'launch', 'listing', 'update'];

  const lowerText = text.toLowerCase();
  if (highKeywords.some((kw) => lowerText.includes(kw))) return 'HIGH';
  if (mediumKeywords.some((kw) => lowerText.includes(kw))) return 'MEDIUM';
  return 'LOW';
}

function extractAssets(text: string): string[] {
  const assets = new Set<string>();
  const lowerText = text.toLowerCase();

  const assetKeywords: Record<string, string[]> = {
    BTC: ['bitcoin', 'btc'],
    ETH: ['ethereum', 'eth', 'ether'],
    SOL: ['solana', 'sol'],
    BNB: ['binance', 'bnb'],
  };

  for (const [asset, keywords] of Object.entries(assetKeywords)) {
    if (keywords.some((kw) => lowerText.includes(kw))) assets.add(asset);
  }

  return Array.from(assets);
}

function getToday(): string {
  return new Date().toISOString().split('T')[0];
}

function getFutureDate(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().split('T')[0];
}

/** Free RSS headlines — no quota, safe to poll often. */
export async function updateHeadlines(): Promise<number> {
  const stored = storeCryptoNews(await fetchCryptoNews());
  pruneStaleEvents();
  lastUpdate = Date.now();
  return stored;
}

/**
 * Metered economic calendar. `force` bypasses the cadence guard for an explicit
 * manual refresh, but the guard is what keeps scheduled polling inside quota.
 */
export async function updateEconomicCalendar(force = false): Promise<number> {
  const dueAt = lastCalendarFetch + newsConfig.calendarRefreshSec * 1000;
  if (!force && lastCalendarFetch > 0 && Date.now() < dueAt) return 0;

  lastCalendarFetch = Date.now();
  const stored = storeEconomicEvents(await fetchEconomicCalendar());
  pruneStaleEvents();
  return stored;
}

export async function updateNewsCalendar(): Promise<{ economic: number; crypto: number; total: number }> {
  console.log('[newsCalendar] Fetching updates...');

  const [economicStored, cryptoStored] = await Promise.all([
    updateEconomicCalendar(true),
    updateHeadlines(),
  ]);

  console.log(`[newsCalendar] Stored ${economicStored} economic events, ${cryptoStored} crypto news`);

  return { economic: economicStored, crypto: cryptoStored, total: eventStore.size };
}

interface QueryOptions {
  priority?: EventPriority[];
  category?: EventCategory[];
  assets?: string[];
  limit?: number;
}

function applyFilters(events: CalendarEvent[], options: QueryOptions): CalendarEvent[] {
  let result = events.filter((e) => e.isActive);

  if (options.priority?.length) {
    result = result.filter((e) => options.priority!.includes(e.priority));
  }
  if (options.category?.length) {
    result = result.filter((e) => options.category!.includes(e.category));
  }
  if (options.assets?.length) {
    // An event with no asset tags is market-wide, so it survives an asset filter.
    result = result.filter(
      (e) => e.assets.length === 0 || e.assets.some((a) => options.assets!.includes(a))
    );
  }

  return result;
}

/**
 * Events in the calendar window. The window reaches backwards as well as
 * forwards: published news always carries a past timestamp, so a
 * strictly-future filter would hide every news item in the feed.
 */
export async function getUpcomingEvents(
  options: QueryOptions & { hoursAhead?: number; hoursBack?: number } = {}
): Promise<CalendarEvent[]> {
  if (eventStore.size === 0) {
    await hydrateFromMongo();
    if (eventStore.size === 0) await updateNewsCalendar();
  }

  const now = Date.now();
  const from = now - (options.hoursBack ?? 12) * 60 * 60 * 1000;
  const to = now + (options.hoursAhead ?? 72) * 60 * 60 * 1000;

  const inWindow = [...eventStore.values()].filter((e) => {
    const t = new Date(e.eventTime).getTime();
    return t >= from && t <= to;
  });

  return applyFilters(inWindow, options)
    .sort((a, b) => new Date(b.eventTime).getTime() - new Date(a.eventTime).getTime())
    .slice(0, options.limit ?? 50);
}

export async function getRecentNews(
  options: QueryOptions & { hoursBack?: number } = {}
): Promise<CalendarEvent[]> {
  if (eventStore.size === 0) {
    await hydrateFromMongo();
    if (eventStore.size === 0) await updateNewsCalendar();
  }

  const from = Date.now() - (options.hoursBack ?? 24) * 60 * 60 * 1000;

  const recent = [...eventStore.values()].filter(
    (e) => new Date(e.publishedAt).getTime() >= from
  );

  return applyFilters(recent, options)
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
    .slice(0, options.limit ?? 50);
}

export function getEventById(eventId: string): CalendarEvent | undefined {
  return eventStore.get(eventId);
}

export function dismissEvent(eventId: string): CalendarEvent | undefined {
  const event = eventStore.get(eventId);
  if (!event) return undefined;
  event.isActive = false;
  void persistEvent(event);
  return event;
}

export function getCalendarStats() {
  const now = Date.now();
  const next24h = now + 24 * 60 * 60 * 1000;
  const next7d = now + 7 * 24 * 60 * 60 * 1000;
  const events = [...eventStore.values()];
  const time = (e: CalendarEvent) => new Date(e.eventTime).getTime();

  return {
    totalActive: events.filter((e) => e.isActive).length,
    highPriorityNext24h: events.filter(
      (e) => e.isActive && e.priority === 'HIGH' && time(e) >= now && time(e) <= next24h
    ).length,
    economicNext7d: events.filter(
      (e) => e.isActive && e.category === 'ECONOMIC' && time(e) >= now && time(e) <= next7d
    ).length,
    recentCryptoNews: events.filter(
      (e) => e.category === 'CRYPTO' && new Date(e.publishedAt).getTime() >= now - 24 * 60 * 60 * 1000
    ).length,
    // The free ForexFactory feed is the primary source, so the calendar is
    // "configured" whether or not a paid FCS key exists.
    economicCalendarConfigured: true,
    economicCalendarSource: calendarSource,
    economicCalendarFallbackConfigured: Boolean(process.env.ECONOMIC_CALENDAR_API_KEY),
    economicCalendarError: calendarError,
    newsFeeds: RSS_FEEDS.map((f) => f.name),
    economicCalendarNextRefresh: lastCalendarFetch
      ? new Date(lastCalendarFetch + newsConfig.calendarRefreshSec * 1000).toISOString()
      : null,
    lastUpdate: lastUpdate ? new Date(lastUpdate).toISOString() : null,
  };
}

/** Warms the store at boot and refreshes it every 5 minutes. */
export function startNewsCalendarUpdates(): void {
  if (!newsConfig.enabled) {
    console.log("[newsCalendar] disabled via NEWS_ENABLED=false");
    return;
  }

  // Serve the cached week first, then refresh. A rate-limited or quota-exhausted
  // upstream then degrades to "slightly stale" instead of "blank panel".
  void hydrateFromMongo()
    .then(() => updateNewsCalendar())
    .catch((e) => console.error('[newsCalendar] initial update failed:', e));

  setInterval(() => {
    void updateHeadlines().catch((e) =>
      console.error('[newsCalendar] headline refresh failed:', e)
    );
  }, Math.max(60, newsConfig.refreshSec) * 1000);

  setInterval(() => {
    void updateEconomicCalendar().catch((e) =>
      console.error('[newsCalendar] calendar refresh failed:', e)
    );
  }, Math.max(600, newsConfig.calendarRefreshSec) * 1000);
}


/** True when an economic event's currency is one we care about. */
function isRelevantCurrency(event: CalendarEvent): boolean {
  if (newsConfig.currencies.length === 0) return true;
  const match = event.source.match(/(([A-Z]{3}))/);
  return match ? newsConfig.currencies.includes(match[1]) : true;
}

export interface BlackoutStatus {
  active: boolean;
  minutes: number;
  event?: { title: string; eventTime: string; minutesAway: number };
}

/**
 * High-impact releases move price violently and unpredictably, so entering just
 * before one is closer to a coin flip than to a signal. This reports whether we
 * are inside that window; it gates new entries only — open positions are left
 * alone so their stops and targets still manage them.
 */
export function getNewsBlackout(now = Date.now()): BlackoutStatus {
  const minutes = newsConfig.blackoutMinutes;
  if (!newsConfig.enabled || minutes <= 0) return { active: false, minutes };

  const windowMs = minutes * 60 * 1000;

  for (const event of eventStore.values()) {
    if (!event.isActive || event.category !== "ECONOMIC" || event.priority !== "HIGH") continue;
    if (!isRelevantCurrency(event)) continue;

    const eventTime = new Date(event.eventTime).getTime();
    const delta = eventTime - now;
    if (delta >= -windowMs && delta <= windowMs) {
      return {
        active: true,
        minutes,
        event: {
          title: event.title,
          eventTime: event.eventTime,
          minutesAway: Math.round(delta / 60000),
        },
      };
    }
  }

  return { active: false, minutes };
}
