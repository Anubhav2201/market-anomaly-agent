import { createHash } from "crypto";
import { Firestore } from "@google-cloud/firestore";
import { NewsArticleIngested } from "../events/types";
import { FirestoreEventStore } from "../events/firestoreStore";
import { fetchRecentNews } from "./newsIngestion";

/**
 * Firestore-backed caching layer around fetchRecentNews(), mirroring
 * SentimentIngestion's pattern (same Cloud Run multi-instance reasoning
 * - an in-memory cache wouldn't be shared across instances).
 *
 * Fixes TWO real problems the raw fetchRecentNews() call had:
 *
 * 1. NO CACHING AT ALL: every anomaly re-fetched news from Tiingo, even
 *    for the same ticker seconds apart (before the cooldown tracker
 *    existed - see anomalyCooldown.ts - this compounds with that fix,
 *    it doesn't replace it: cooldown stops REDUNDANT pipeline runs for
 *    the same event, this cache makes runs for DIFFERENT anomalies on
 *    the same ticker within the TTL window cheap).
 *
 * 2. DUPLICATE event_ids FOR THE SAME ARTICLE: parseArticle() mints a
 *    fresh uuid every single call, even for an article Tiingo returns
 *    again identically. Five anomalies on the same ticker within an
 *    hour could store the SAME Robinhood Chain article five times
 *    under five different event_ids - a real correctness smell in an
 *    event-sourced system (any future "how often was X cited" analysis
 *    over the event log would be wrong), not just a cost issue. Fixed
 *    via a URL -> event_id index: an article already seen (by URL,
 *    regardless of which ticker/query first surfaced it - e.g. a
 *    bellwether-scoped ETH article and a later BTC query could both
 *    return the same URL) reuses its existing event_id rather than
 *    minting a new one.
 *
 * TTL is shorter than the sentiment cache's (1 hour) - news moves
 * faster than aggregate Reddit sentiment, so 20 minutes balances
 * freshness against not hammering Tiingo for closely-spaced anomalies.
 */
const NEWS_CACHE_TTL_MS = 20 * 60 * 1000;

interface NewsCacheDoc {
  ticker: string;
  last_fetched_at: number;
  event_ids: string[];
}

interface UrlIndexDoc {
  event_id: string;
  url: string;
  first_seen_at: number;
}

function urlHash(url: string): string {
  // Truncated SHA-256 is plenty collision-resistant for this use (a
  // Firestore doc id, not a security boundary) and keeps doc ids short.
  return createHash("sha256").update(url).digest("hex").slice(0, 40);
}

export class NewsCache {
  private db: Firestore;
  private eventStore: FirestoreEventStore;

  constructor(eventStore: FirestoreEventStore, projectId?: string) {
    this.db = projectId ? new Firestore({ projectId }) : new Firestore();
    this.eventStore = eventStore;
  }

  /**
   * Returns cached news for a ticker if fetched within the TTL window,
   * otherwise fetches fresh from Tiingo (via fetchRecentNews) and
   * caches the result. Same "confidence booster, not hard requirement"
   * philosophy as sentiment - any failure degrades to fetching fresh
   * rather than throwing.
   */
  async getRecentNews(ticker: string, limit = 10): Promise<NewsArticleIngested[]> {
    const cacheRef = this.db.collection("news_cache").doc(ticker);

    try {
      const cacheDoc = await cacheRef.get();
      if (cacheDoc.exists) {
        const cached = cacheDoc.data() as NewsCacheDoc;
        if (Date.now() - cached.last_fetched_at < NEWS_CACHE_TTL_MS) {
          const resolved = await this.resolveEventIds(cached.event_ids);
          if (resolved.length === cached.event_ids.length) {
            return resolved; // cache fully intact, nothing missing
          }
          // Some cached ids no longer resolve (e.g. store was reset in
          // a dev environment) - fall through to a fresh fetch below
          // rather than silently returning a partial/stale list.
        }
      }
    } catch (err) {
      console.error(`[newsCache] cache read failed for ${ticker}, fetching fresh:`, err);
    }

    return this.fetchAndCache(ticker, limit, cacheRef);
  }

  private async resolveEventIds(ids: string[]): Promise<NewsArticleIngested[]> {
    const events = await Promise.all(ids.map((id) => this.eventStore.getById(id)));
    return events.filter(
      (e): e is NewsArticleIngested => !!e && e.type === "NewsArticleIngested"
    );
  }

  private async fetchAndCache(
    ticker: string,
    limit: number,
    cacheRef: FirebaseFirestore.DocumentReference
  ): Promise<NewsArticleIngested[]> {
    const fresh = await fetchRecentNews(ticker, limit);
    const deduped: NewsArticleIngested[] = [];

    for (const article of fresh) {
      const hash = urlHash(article.url);
      const urlIndexRef = this.db.collection("news_url_index").doc(hash);

      try {
        const urlIndexDoc = await urlIndexRef.get();
        if (urlIndexDoc.exists) {
          const existingId = (urlIndexDoc.data() as UrlIndexDoc).event_id;
          const existing = await this.eventStore.getById(existingId);
          if (existing && existing.type === "NewsArticleIngested") {
            // Same article, already stored under this canonical id -
            // reuse it rather than minting a duplicate.
            deduped.push(existing);
            continue;
          }
          // Index pointed at a missing event - fall through to
          // re-append below and refresh the index.
        }
      } catch (err) {
        console.error(`[newsCache] url index lookup failed for ${article.url}, appending fresh:`, err);
      }

      await this.eventStore.append(article);
      await urlIndexRef.set({
        event_id: article.event_id,
        url: article.url,
        first_seen_at: Date.now(),
      } as UrlIndexDoc);
      deduped.push(article);
    }

    await cacheRef.set({
      ticker,
      last_fetched_at: Date.now(),
      event_ids: deduped.map((a) => a.event_id),
    } as NewsCacheDoc);

    return deduped;
  }
}
