import fetch from "node-fetch";

/**
 * Free, no-key news ingestion via public RSS feeds. This is deliberately
 * simple: no NLP model, just a keyword-scored sentiment used as a numeric
 * feature (`news_sentiment_score`) so it fits the same verified-snapshot /
 * citation-checked claim pipeline as every technical indicator (docs/01 §4).
 * The raw headlines are also exposed as-is via the API for the news panel
 * and as context an LLM agent can read when it's enabled.
 */

export interface Headline {
  title: string;
  source: string;
  url: string;
  publishedAt: number;
}

const FEEDS: { url: string; source: string }[] = [
  { url: "https://www.coindesk.com/arc/outboundfeeds/rss/", source: "CoinDesk" },
  { url: "https://cointelegraph.com/rss", source: "Cointelegraph" },
];

const BULLISH_WORDS = ["surge", "rally", "soar", "bullish", "breakout", "record high", "all-time high", "gain", "jump", "adoption", "approve", "approval", "inflow", "upgrade"];
const BEARISH_WORDS = ["crash", "plunge", "slump", "bearish", "sell-off", "selloff", "hack", "exploit", "ban", "lawsuit", "outflow", "liquidation", "fear", "downgrade", "collapse"];

let cache: { headlines: Headline[]; fetchedAt: number } = { headlines: [], fetchedAt: 0 };
const CACHE_TTL_MS = 10 * 60 * 1000;

function extractItems(xml: string, source: string): Headline[] {
  const items: Headline[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match: RegExpExecArray | null;
  while ((match = itemRegex.exec(xml))) {
    const block = match[1];
    const title = decodeEntities(extractTag(block, "title"));
    const link = extractTag(block, "link");
    const pubDateRaw = extractTag(block, "pubDate");
    const publishedAt = pubDateRaw ? Date.parse(pubDateRaw) : Date.now();
    if (title) items.push({ title, source, url: link, publishedAt: Number.isNaN(publishedAt) ? Date.now() : publishedAt });
  }
  return items;
}

function extractTag(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  if (!m) return "";
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1").trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

async function fetchFeed(feed: { url: string; source: string }): Promise<Headline[]> {
  try {
    const res = await fetch(feed.url, { headers: { "User-Agent": "auto-trader/0.1 (+paper-trading research bot)" } });
    if (!res.ok) return [];
    const xml = await res.text();
    return extractItems(xml, feed.source);
  } catch (e) {
    console.warn(`[news] feed fetch failed for ${feed.source}`, (e as Error).message);
    return [];
  }
}

export async function refreshHeadlines(): Promise<void> {
  const results = await Promise.all(FEEDS.map(fetchFeed));
  const all = results.flat().sort((a, b) => b.publishedAt - a.publishedAt);
  cache = { headlines: all.slice(0, 60), fetchedAt: Date.now() };
}

export function getHeadlines(asset?: "BTCUSDT" | "ETHUSDT"): Headline[] {
  const keyword = asset === "ETHUSDT" ? /\b(eth|ether|ethereum)\b/i : asset === "BTCUSDT" ? /\b(btc|bitcoin)\b/i : null;
  const relevant = keyword ? cache.headlines.filter((h) => keyword.test(h.title)) : cache.headlines;
  return relevant.slice(0, 15);
}

export function getAllHeadlines(): Headline[] {
  return cache.headlines;
}

/** Keyword-scored sentiment in [-1, 1], averaged over the asset's recent relevant headlines. */
export function computeNewsSentiment(asset: "BTCUSDT" | "ETHUSDT"): number {
  const headlines = getHeadlines(asset);
  if (headlines.length === 0) return 0;
  let score = 0;
  for (const h of headlines) {
    const text = h.title.toLowerCase();
    let s = 0;
    for (const w of BULLISH_WORDS) if (text.includes(w)) s += 1;
    for (const w of BEARISH_WORDS) if (text.includes(w)) s -= 1;
    score += Math.max(-1, Math.min(1, s));
  }
  return Math.max(-1, Math.min(1, score / headlines.length));
}

export function startNewsRefresh() {
  refreshHeadlines();
  setInterval(refreshHeadlines, CACHE_TTL_MS);
}

export function getHeadlinesFetchedAt(): number {
  return cache.fetchedAt;
}
