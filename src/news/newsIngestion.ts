import { v4 as uuidv4 } from "uuid";
import { NewsArticleIngested } from "../events/types";

/**
 * Fetches recent news for a ticker from cryptocurrency.cv - a free, open
 * source, no-API-key-required crypto news aggregator (130+ sources,
 * historical archive back to 2017). We use the plain REST endpoint
 * rather than their MCP server since we want raw events for our own
 * store, not a conversational tool interface.
 *
 * NOTE ON SCHEMA: this is built from cryptocurrency.cv's published
 * examples (GET /api/news?ticker=BTC&limit=N returns { articles: [...] }
 * with title/source/url fields), not a fully verified live response,
 * since this dev sandbox has no network route to cryptocurrency.cv to
 * confirm field names against a live call. The parsing below is
 * defensive (tries a couple of likely field name variants) - verify
 * against a real response on your machine and adjust field names in
 * `parseArticle` if they don't match.
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
  ticker: string
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

  return {
    type: "NewsArticleIngested",
    event_id: uuidv4(),
    ticker,
    timestamp,
    headline,
    summary,
    source,
    url,
  };
}

/**
 * Fetch recent news for a ticker. Returns [] on any failure rather than
 * throwing - a missing news source should degrade to "no citations
 * available" (which the grounding verifier correctly rejects), not crash
 * the pipeline.
 */
export async function fetchRecentNews(
  ticker: string,
  limit = 10
): Promise<NewsArticleIngested[]> {
  const symbol = toBaseSymbol(ticker);
  const url = `${BASE_URL}/api/news?ticker=${encodeURIComponent(symbol)}&limit=${limit}`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`[newsIngestion] HTTP ${res.status} fetching ${url}`);
      return [];
    }
    const data: NewsApiResponse = await res.json();
    if (!data.articles) return [];

    return data.articles
      .map((a) => parseArticle(a, ticker))
      .filter((e): e is NewsArticleIngested => e !== null);
  } catch (err) {
    console.error(`[newsIngestion] fetch failed for ${ticker}:`, err);
    return [];
  }
}
