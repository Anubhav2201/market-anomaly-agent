import { Firestore } from "@google-cloud/firestore";
import { v4 as uuidv4 } from "uuid";
import { SentimentSnapshotIngested } from "../events/types";
import { FirestoreEventStore } from "../events/firestoreStore";

/**
 * Fetches Reddit crypto sentiment from Adanos' free tier - 250
 * requests/month total, so this MUST be cached, not called per-anomaly.
 * Caching is done in Firestore (not in-memory) specifically because
 * agent-svc can run multiple Cloud Run instances - an in-memory cache
 * would let each instance independently burn through the shared
 * monthly quota. A Firestore-backed cache document per ticker keeps
 * every instance honoring the same "last fetched" timestamp.
 *
 * NOTE ON SCHEMA (CORRECTED AGAIN, this time from the real OpenAPI
 * spec): the previous "fix" (see DECISIONS.md ADR-011) pointed this at
 * `/reddit/stocks/v1/stock/{ticker}` - the STOCKS endpoint. Adanos
 * actually has a SEPARATE, dedicated crypto endpoint entirely:
 * `/reddit/crypto/v1/token/{symbol}`. This was confirmed directly from
 * Adanos' OpenAPI spec (2026-07-10), not docs/marketing copy - see
 * DECISIONS.md ADR-012 for the full story.
 *
 * Per the spec: `found: false` on a 200 response means the symbol is
 * SUPPORTED but has no qualifying data in the requested window (still
 * a valid, expected case for a quiet ticker). A genuinely unsupported
 * symbol returns HTTP 404, not `found: false` - these are two distinct
 * "no data" cases, both handled below by returning null.
 */

const BASE_URL = "https://api.adanos.org";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour - matches Adanos' own refresh cycle

interface SentimentCacheDoc {
  ticker: string;
  last_fetched_at: number;
  event_id: string;
}

/** Matches Adanos' real CryptoTokenSentiment schema (OpenAPI spec, 2026-07-10). */
interface RawCryptoTokenSentiment {
  symbol: string;
  name?: string | null;
  /** true = data exists for this window. false = symbol supported, no data this window (still a 200). */
  found: boolean;
  buzz_score?: number | null;
  mentions?: number | null;
  sentiment_score?: number | null;
  total_upvotes?: number | null;
  unique_posts?: number | null;
  subreddit_count?: number | null;
  trend?: "rising" | "falling" | "stable" | null;
  bullish_pct?: number | null;
  bearish_pct?: number | null;
  period_days?: number;
}

/**
 * GET /reddit/crypto/v1/market-sentiment response shape (llms.txt,
 * confirmed 2026-07-10, see DECISIONS.md ADR-013/ADR-014). Aggregate
 * crypto-wide reading, NOT specific to any one symbol - hence no
 * `symbol`/`found` fields the per-token endpoint has.
 */
interface RawCryptoMarketSentiment {
  buzz_score?: number | null;
  trend?: "rising" | "falling" | "stable" | null;
  mentions?: number | null;
  unique_posts?: number | null;
  subreddit_count?: number | null;
  total_upvotes?: number | null;
  active_tickers?: number | null;
  sentiment_score?: number | null;
  bullish_pct?: number | null;
  bearish_pct?: number | null;
  trend_history?: number[];
  drivers?: { symbol: string; mentions: number; buzz_score: number; sentiment_score: number }[];
}

/** Cache key used for the market-wide reading - not a real ticker, deliberately global. */
const MARKET_WIDE_CACHE_KEY = "__MARKET_WIDE__";

function toBaseSymbol(ticker: string): string {
  return ticker.split("-")[0];
}

function normalizeTrend(raw?: string | null): "rising" | "falling" | "stable" {
  if (raw === "rising" || raw === "falling") return raw;
  return "stable";
}

export class SentimentIngestion {
  private db: Firestore;
  private eventStore: FirestoreEventStore;
  private apiKey: string | undefined;

  constructor(eventStore: FirestoreEventStore, projectId?: string) {
    this.db = projectId ? new Firestore({ projectId }) : new Firestore();
    this.eventStore = eventStore;
    this.apiKey = process.env.ADANOS_API_KEY;
  }

  /**
   * Returns a cached (or freshly fetched, if stale) ticker_specific
   * sentiment snapshot for one crypto symbol. Returns null if no API
   * key is configured, the fetch fails, or the ticker has no
   * sentiment data available - sentiment is a confidence-booster, not
   * a hard requirement, same philosophy as the semantic verifier's
   * optional GROQ_API_KEY.
   */
  async getSnapshot(ticker: string): Promise<SentimentSnapshotIngested | null> {
    return this.getCached(ticker, () => this.fetchTickerSnapshot(ticker));
  }

  /**
   * Returns a cached (or freshly fetched, if stale) market_wide
   * sentiment snapshot - aggregate crypto-wide mood, not specific to
   * any one ticker. Cached under a single global key (not per-ticker)
   * since the underlying Adanos reading itself isn't per-ticker either -
   * every anomaly, regardless of which ticker it's for, shares the same
   * cached market-wide reading within the hourly TTL.
   */
  async getMarketSnapshot(): Promise<SentimentSnapshotIngested | null> {
    return this.getCached(MARKET_WIDE_CACHE_KEY, () => this.fetchMarketSnapshot());
  }

  /** Shared cache-check-then-fetch logic for both snapshot types. */
  private async getCached(
    cacheKey: string,
    fetchFn: () => Promise<SentimentSnapshotIngested | null>
  ): Promise<SentimentSnapshotIngested | null> {
    const cacheRef = this.db.collection("sentiment_cache").doc(cacheKey);
    const cacheDoc = await cacheRef.get();

    if (cacheDoc.exists) {
      const cached = cacheDoc.data() as SentimentCacheDoc;
      if (Date.now() - cached.last_fetched_at < CACHE_TTL_MS) {
        const event = await this.eventStore.getById(cached.event_id);
        if (event && event.type === "SentimentSnapshotIngested") {
          return event;
        }
        // Cache pointed at an event that's gone missing - fall through
        // to refetch rather than returning nothing.
      }
    }

    const snapshot = await fetchFn();
    if (snapshot) {
      await this.eventStore.append(snapshot);
      await cacheRef.set({
        ticker: cacheKey,
        last_fetched_at: Date.now(),
        event_id: snapshot.event_id,
      } as SentimentCacheDoc);
    }
    return snapshot;
  }

  /** Parses Adanos' structured 404 error_code when present, for clearer logs. */
  private async parse404ErrorCode(res: Response): Promise<string> {
    try {
      const body = await res.json();
      return body?.detail?.error_code ?? "unknown";
    } catch {
      return "unknown";
    }
  }

  private async fetchTickerSnapshot(ticker: string): Promise<SentimentSnapshotIngested | null> {
    if (!this.apiKey) {
      console.warn("[sentimentIngestion] ADANOS_API_KEY not set - skipping sentiment fetch");
      return null;
    }

    const symbol = toBaseSymbol(ticker);
    const url = `${BASE_URL}/reddit/crypto/v1/token/${encodeURIComponent(symbol)}`;

    try {
      const res = await fetch(url, { headers: { "X-API-Key": this.apiKey } });

      if (res.status === 404) {
        const errorCode = await this.parse404ErrorCode(res);
        console.warn(
          `[sentimentIngestion] Adanos 404 (error_code=${errorCode}) - "${symbol}" is not a supported crypto symbol`
        );
        return null;
      }
      if (!res.ok) {
        console.error(`[sentimentIngestion] HTTP ${res.status} fetching ${url}`);
        return null;
      }
      const data: RawCryptoTokenSentiment = await res.json();

      if (data.found === false) {
        console.log(`[sentimentIngestion] "${symbol}" supported but no data this window (found:false)`);
        return null;
      }

      return {
        type: "SentimentSnapshotIngested",
        event_id: uuidv4(),
        ticker,
        timestamp: Date.now(),
        source: "adanos-reddit-crypto",
        scope: "ticker_specific",
        buzz_score: data.buzz_score ?? 0,
        sentiment_score: data.sentiment_score ?? 0,
        trend: normalizeTrend(data.trend),
        mention_count: data.mentions ?? 0,
      };
    } catch (err) {
      console.error(`[sentimentIngestion] fetch failed for ${ticker}:`, err);
      return null;
    }
  }

  /**
   * Fetches the aggregate crypto-wide market-sentiment reading. Not
   * tied to any specific ticker - the `ticker` field on the resulting
   * event is set to the global cache key placeholder, not a real
   * symbol (the grounding verifier only checks event_id existence +
   * causality, not ticker matching, so this doesn't break anything -
   * see groundingVerifier.ts).
   */
  private async fetchMarketSnapshot(): Promise<SentimentSnapshotIngested | null> {
    if (!this.apiKey) {
      console.warn("[sentimentIngestion] ADANOS_API_KEY not set - skipping market-sentiment fetch");
      return null;
    }

    const url = `${BASE_URL}/reddit/crypto/v1/market-sentiment`;

    try {
      const res = await fetch(url, { headers: { "X-API-Key": this.apiKey } });
      if (!res.ok) {
        console.error(`[sentimentIngestion] HTTP ${res.status} fetching ${url}`);
        return null;
      }
      const data: RawCryptoMarketSentiment = await res.json();

      return {
        type: "SentimentSnapshotIngested",
        event_id: uuidv4(),
        ticker: MARKET_WIDE_CACHE_KEY,
        timestamp: Date.now(),
        source: "adanos-reddit-crypto",
        scope: "market_wide",
        buzz_score: data.buzz_score ?? 0,
        sentiment_score: data.sentiment_score ?? 0,
        trend: normalizeTrend(data.trend),
        mention_count: data.mentions ?? 0,
        drivers: data.drivers ?? [],
      };
    } catch (err) {
      console.error("[sentimentIngestion] market-sentiment fetch failed:", err);
      return null;
    }
  }
}
