import { v4 as uuidv4 } from "uuid";
import { NewsArticleIngested } from "../events/types";
import { classifyNewsScope } from "./scopeClassifier";

/**
 * Fetches recent news relevant to a ticker from Tiingo's News API -
 * replaces the earlier cryptocurrency.cv integration, which turned out
 * to be down (Vercel DEPLOYMENT_DISABLED on the maintainer's own
 * hosting - see DECISIONS.md ADR-016) rather than genuinely free/keyless
 * as advertised.
 *
 * Requires a free Tiingo account + API token (TIINGO_API_KEY env var) -
 * unlike cryptocurrency.cv, this is NOT keyless, but it's a funded,
 * commercially-operated financial news API (15+ years of history,
 * 8,000-12,000 articles/day), which is a materially more durable
 * dependency than a free side-project that can silently go dark.
 *
 * NOTE ON SCHEMA: confirmed directly from Tiingo's own documentation
 * page (https://www.tiingo.com/documentation/news, fetched 2026-07-11),
 * not guessed from marketing copy - this is the field-by-field schema
 * Tiingo itself publishes, not a reconstruction (learned from the
 * Adanos ADR-011/012 experience - go straight to the authoritative
 * source, not a screenshot or a blog post about it).
 *
 * Fetches from TWO endpoints and tags scope at ingestion time (paid
 * once per article, not once per anomaly):
 *   - ticker-specific query (?tickers=btc) -> mostly ticker_specific,
 *     but re-classified anyway since Tiingo's own tagging can surface
 *     multi-ticker articles that are more macro in nature
 *   - general/latest feed (no ticker filter, sorted by crawlDate) ->
 *     classified against the same ticker, surfaces market_wide articles
 *     a ticker-scoped query would miss entirely (e.g. a Fed rate
 *     decision article that never says "Bitcoin" but is still relevant
 *     context)
 */

const BASE_URL = "https://api.tiingo.com";

/** Matches Tiingo's real /tiingo/news response schema (docs, 2026-07-11). */
interface TiingoArticle {
  id: number;
  title: string;
  url: string;
  description: string;
  publishedDate: string; // ISO datetime, UTC
  crawlDate: string; // ISO datetime, UTC
  source: string; // domain, e.g. "coindesk.com"
  tickers: string[]; // Tiingo's own ticker tagging - lowercase, e.g. "btc"
  tags: string[];
}

/** Coinbase-style "BTC-USD" -> Tiingo-style "btc" (lowercase, no quote currency) */
function toBaseSymbol(ticker: string): string {
  return ticker.split("-")[0].toLowerCase();
}

function parseArticle(
  raw: TiingoArticle,
  ticker: string,
  tickerBaseSymbol: string,
): NewsArticleIngested | null {
  if (!raw.title || !raw.url) return null; // can't ground a citation without these

  const summary = raw.description ?? "";
  const timestamp = new Date(raw.publishedDate).getTime();
  const validTimestamp = Number.isFinite(timestamp) ? timestamp : Date.now();

  // Tiingo's own tickers[] tagging is a stronger signal than our text
  // heuristic when it's available - if Tiingo itself tagged this
  // article with our exact ticker, trust that over the lexicon
  // classifier's guess. Otherwise fall back to classifyNewsScope
  // (headline/summary text match) exactly as before.
  const taggedByTiingo = raw.tickers?.some(
    (t) => t.toLowerCase() === tickerBaseSymbol.toLowerCase(),
  );
  const scope = taggedByTiingo
    ? "ticker_specific"
    : classifyNewsScope(raw.title, summary, tickerBaseSymbol);

  if (scope === "unrelated") return null; // filtered out at ingestion time

  return {
    type: "NewsArticleIngested",
    event_id: uuidv4(),
    ticker,
    timestamp: validTimestamp,
    headline: raw.title,
    summary,
    source: raw.source,
    url: raw.url,
    scope,
  };
}

async function fetchFromEndpoint(
  url: string,
  ticker: string,
  tickerBaseSymbol: string,
  apiKey: string,
): Promise<NewsArticleIngested[]> {
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Token ${apiKey}` },
    });
    if (!res.ok) {
      console.error(`[newsIngestion] HTTP ${res.status} fetching ${url}`);
      return [];
    }
    const data = await res.json();
    // Tiingo's REST endpoints return a raw JSON array, not a wrapped
    // object - defensive fallback in case that assumption is ever wrong.
    const articles: TiingoArticle[] = Array.isArray(data)
      ? data
      : (data.articles ?? data.data ?? []);

    return articles
      .map((a) => parseArticle(a, ticker, tickerBaseSymbol))
      .filter((e): e is NewsArticleIngested => e !== null);
  } catch (err) {
    console.error(`[newsIngestion] fetch failed for ${url}:`, err);
    return [];
  }
}

/**
 * Fetch recent, scope-tagged news relevant to a ticker. Combines a
 * ticker-scoped query with a general/latest feed so market_wide
 * articles aren't missed just because they don't name the ticker.
 * Deduplicates by url in case both endpoints return the same article.
 * Returns [] if TIINGO_API_KEY is unset or on any failure, rather than
 * throwing - a missing news source should degrade to "no citations
 * available" (which correctly leads to an honest no_clear_cause - see
 * DECISIONS.md ADR-006/ADR-015), not crash the pipeline.
 */
export async function fetchRecentNews(
  ticker: string,
  limit = 10,
): Promise<NewsArticleIngested[]> {
  const apiKey = process.env.TIINGO_API_KEY;
  if (!apiKey) {
    console.warn(
      "[newsIngestion] TIINGO_API_KEY not set - skipping news fetch",
    );
    return [];
  }

  const symbol = toBaseSymbol(ticker);

  const tickerUrl = `${BASE_URL}/tiingo/news?tickers=${encodeURIComponent(symbol)}&limit=${limit}`;
  const latestUrl = `${BASE_URL}/tiingo/news?limit=${limit}&sortBy=crawlDate`;

  const [tickerArticles, latestArticles] = await Promise.all([
    fetchFromEndpoint(tickerUrl, ticker, symbol, apiKey),
    fetchFromEndpoint(latestUrl, ticker, symbol, apiKey),
  ]);

  const seen = new Set<string>();
  const combined: NewsArticleIngested[] = [];
  for (const article of [...tickerArticles, ...latestArticles]) {
    if (seen.has(article.url)) continue;
    seen.add(article.url);
    combined.push(article);
  }
  return combined;
}
