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
 * NOTE ON SCHEMA: endpoint/field names built from Adanos' published
 * docs and SDK examples, not verified against a live response (no
 * network route to api.adanos.org from this dev sandbox). Verify field
 * names on your machine against a real response before relying on this
 * in production - same caveat as newsIngestion.ts.
 */

const BASE_URL = "https://api.adanos.org";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour - matches Adanos' own refresh cycle

interface SentimentCacheDoc {
  ticker: string;
  last_fetched_at: number;
  event_id: string;
}

interface RawSentimentResponse {
  buzz_score?: number;
  sentiment_score?: number;
  trend?: string;
  mention_count?: number;
  mentions?: number;
}

function toBaseSymbol(ticker: string): string {
  return ticker.split("-")[0];
}

function normalizeTrend(raw?: string): "rising" | "falling" | "stable" {
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
   * Returns a cached (or freshly fetched, if stale) sentiment snapshot
   * event for a ticker. Returns null if no API key is configured, the
   * fetch fails, or the ticker has no sentiment data available -
   * sentiment is a confidence-booster, not a hard requirement, same
   * philosophy as the semantic verifier's optional GROQ_API_KEY.
   */
  async getSnapshot(ticker: string): Promise<SentimentSnapshotIngested | null> {
    const cacheRef = this.db.collection("sentiment_cache").doc(ticker);
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

    return this.fetchAndCache(ticker, cacheRef);
  }

  private async fetchAndCache(
    ticker: string,
    cacheRef: FirebaseFirestore.DocumentReference
  ): Promise<SentimentSnapshotIngested | null> {
    if (!this.apiKey) {
      console.warn(
        "[sentimentIngestion] ADANOS_API_KEY not set - skipping sentiment fetch"
      );
      return null;
    }

    const symbol = toBaseSymbol(ticker);
    const url = `${BASE_URL}/v1/reddit-crypto/token?ticker=${encodeURIComponent(symbol)}`;

    try {
      const res = await fetch(url, {
        headers: { "X-API-Key": this.apiKey },
      });
      if (!res.ok) {
        console.error(`[sentimentIngestion] HTTP ${res.status} fetching ${url}`);
        return null;
      }
      const data: RawSentimentResponse = await res.json();

      const snapshot: SentimentSnapshotIngested = {
        type: "SentimentSnapshotIngested",
        event_id: uuidv4(),
        ticker,
        timestamp: Date.now(),
        source: "adanos-reddit-crypto",
        buzz_score: data.buzz_score ?? 0,
        sentiment_score: data.sentiment_score ?? 0,
        trend: normalizeTrend(data.trend),
        mention_count: data.mention_count ?? data.mentions ?? 0,
      };

      await this.eventStore.append(snapshot);
      await cacheRef.set({
        ticker,
        last_fetched_at: Date.now(),
        event_id: snapshot.event_id,
      } as SentimentCacheDoc);

      return snapshot;
    } catch (err) {
      console.error(`[sentimentIngestion] fetch failed for ${ticker}:`, err);
      return null;
    }
  }
}
