import { v4 as uuidv4 } from "uuid";
import { NewsArticleIngested } from "../events/types";
import { classifyNewsScope } from "./scopeClassifier";

/**
 * Fetches recent news relevant to a ticker from cryptocurrency.cv - a
 * free, open source, no-API-key-required crypto news aggregator (130+
 * sources, historical archive back to 2017).
 *
 * Fetches from TWO endpoints and tags scope at ingestion time (paid
 * once per article, not once per anomaly):
 *   - ticker-specific query (?ticker=BTC) -> mostly ticker_specific, but
 *     re-classified anyway since a ticker-filtered feed can still
 *     surface market-wide pieces that happen to mention the ticker in
 *     passing
 *   - general/breaking feed (no ticker filter) -> classified against
 *     the same ticker, surfaces market_wide articles a ticker-scoped
 *     query would miss entirely (e.g. a Fed rate decision article that
 *     never says "Bitcoin" but is still relevant context)
 *
 * NOTE ON SCHEMA: built from cryptocurrency.cv's published examples,
 * not verified against a live response (this dev sandbox has no network
 * route to cryptocurrency.cv). Parsing is defensive - verify field names
 * on your machine and adjust `parseArticle` if they don't match.
 */

const BASE_URL = "https://cryptocurrency.cv";

interface RawArticle {
  title?: string;
  headline?: string;
  summary?: string;
  description?: string;
  source?: string;
  url?: string;
  link?: string;
  published_at?: string;
  publishedAt?: string;
  date?: string;
  timestamp?: number;
}

interface NewsApiResponse {
  articles: RawArticle[];
}

/** Coinbase-style "BTC-USD" -> cryptocurrency.cv-style "BTC" */
function toBaseSymbol(ticker: string): string {
  return ticker.split("-")[0];
}

function parseArticle(
  raw: RawArticle,
  ticker: string,
  tickerBaseSymbol: string
): NewsArticleIngested | null {
  const headline = raw.title ?? raw.headline;
  const summary = raw.summary ?? raw.description ?? "";
  const url = raw.url ?? raw.link;
  const source = raw.source ?? "cryptocurrency.cv";

  if (!headline || !url) return null; // can't ground a citation without these

  let timestamp: number;
  if (raw.timestamp) {
    timestamp = raw.timestamp;
  } else {
    const dateStr = raw.published_at ?? raw.publishedAt ?? raw.date;
    const parsed = dateStr ? new Date(dateStr).getTime() : NaN;
    timestamp = Number.isFinite(parsed) ? parsed : Date.now();
  }

  const scope = classifyNewsScope(headline, summary, tickerBaseSymbol);
  if (scope === "unrelated") return null; // filtered out at ingestion time

  return {
    type: "NewsArticleIngested",
    event_id: uuidv4(),
    ticker,
    timestamp,
    headline,
    summary,
    source,
    url,
    scope,
  };
}

async function fetchFromEndpoint(
  url: string,
  ticker: string,
  tickerBaseSymbol: string
): Promise<NewsArticleIngested[]> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`[newsIngestion] HTTP ${res.status} fetching ${url}`);
      return [];
    }
    const data: NewsApiResponse = await res.json();
    if (!data.articles) return [];

    return data.articles
      .map((a) => parseArticle(a, ticker, tickerBaseSymbol))
      .filter((e): e is NewsArticleIngested => e !== null);
  } catch (err) {
    console.error(`[newsIngestion] fetch failed for ${url}:`, err);
    return [];
  }
}

/**
 * Fetch recent, scope-tagged news relevant to a ticker. Combines a
 * ticker-scoped query with a general/breaking feed so market_wide
 * articles aren't missed just because they don't name the ticker.
 * Deduplicates by url in case both endpoints return the same article.
 * Returns [] on any failure rather than throwing - a missing news
 * source should degrade to "no citations available" (which the
 * grounding verifier correctly rejects), not crash the pipeline.
 */
export async function fetchRecentNews(
  ticker: string,
  limit = 10
): Promise<NewsArticleIngested[]> {
  const symbol = toBaseSymbol(ticker);

  const tickerUrl = `${BASE_URL}/api/news?ticker=${encodeURIComponent(symbol)}&limit=${limit}`;
  const breakingUrl = `${BASE_URL}/api/breaking?limit=${limit}`;

  const [tickerArticles, breakingArticles] = await Promise.all([
    fetchFromEndpoint(tickerUrl, ticker, symbol),
    fetchFromEndpoint(breakingUrl, ticker, symbol),
  ]);

  const seen = new Set<string>();
  const combined: NewsArticleIngested[] = [];
  for (const article of [...tickerArticles, ...breakingArticles]) {
    if (seen.has(article.url)) continue;
    seen.add(article.url);
    combined.push(article);
  }
  return combined;
}
