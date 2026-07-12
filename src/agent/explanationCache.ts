import { createHash } from "crypto";
import { Firestore } from "@google-cloud/firestore";
import { ExplanationGenerated, PriceAnomalyDetected } from "../events/types";
import { FirestoreEventStore } from "../events/firestoreStore";
import { v4 as uuidv4 } from "uuid";

/**
 * Caches an explanation by a fingerprint of what it was actually
 * explained FROM: ticker + price direction + tier + the exact sorted
 * set of candidate event_ids (news + sentiment) handed to Claude. If a
 * later anomaly on the same ticker arrives with the IDENTICAL
 * candidate set within the TTL window, its explanation is reused
 * instead of making another Claude call.
 *
 * This is deliberately narrower than the news/sentiment caches: those
 * cache the DATA (so it isn't re-fetched); this caches the REASONING
 * (so identical data isn't re-explained). With the cooldown tracker
 * (anomalyCooldown.ts) in place, exact-duplicate candidate sets should
 * become rare in practice - cooldown already suppresses the common
 * case of "same event, many consecutive ticks." This cache mainly
 * catches the remaining case: two SEPARATE anomalies (different
 * anomaly_event_id, e.g. after a cooldown window lapsed) that happen
 * to still be explained by the exact same underlying news/sentiment.
 *
 * 30-minute TTL - shorter than the news cache's 20 minutes would
 * suggest matching more precisely, but the point of this cache is
 * reasoning reuse over a slightly longer window than raw data
 * freshness, since the REASONING about a fixed set of facts doesn't
 * go stale as fast as the facts themselves might change.
 */
const EXPLANATION_CACHE_TTL_MS = 30 * 60 * 1000;

interface ExplanationCacheDoc {
  explanation_event_id: string;
  cached_at: number;
}

function computeKey(
  ticker: string,
  direction: string,
  tier: string,
  candidateIds: string[]
): string {
  const sorted = [...candidateIds].sort();
  const raw = `${ticker}|${direction}|${tier}|${sorted.join(",")}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 40);
}

export class ExplanationCache {
  private db: Firestore;
  private eventStore: FirestoreEventStore;

  constructor(eventStore: FirestoreEventStore, projectId?: string) {
    this.db = projectId ? new Firestore({ projectId }) : new Firestore();
    this.eventStore = eventStore;
  }

  /**
   * Returns a REUSED explanation (fresh event_id, pointing at THIS
   * anomaly's anomaly_event_id, but with the same claim/summary/
   * citations/confidence as the cached one) if an identical candidate
   * set was already explained recently. Returns null on a miss - the
   * caller should proceed to call Claude normally and then call
   * `store()` with the result.
   *
   * Deliberately does NOT reuse the cached explanation's own event_id
   * or anomaly_event_id - each anomaly gets its own explanation event
   * pointing at its own anomaly, even when the reasoning is reused,
   * so the event log stays a truthful one-explanation-per-anomaly
   * record rather than one event pretending to explain two anomalies.
   */
  async lookup(
    anomaly: PriceAnomalyDetected,
    tier: string,
    candidateIds: string[]
  ): Promise<ExplanationGenerated | null> {
    const key = computeKey(anomaly.ticker, anomaly.price_direction, tier, candidateIds);
    const docRef = this.db.collection("explanation_cache").doc(key);

    try {
      const doc = await docRef.get();
      if (!doc.exists) return null;

      const data = doc.data() as ExplanationCacheDoc;
      if (Date.now() - data.cached_at >= EXPLANATION_CACHE_TTL_MS) return null;

      const cached = await this.eventStore.getById(data.explanation_event_id);
      if (!cached || cached.type !== "ExplanationGenerated") return null;

      return {
        ...cached,
        event_id: uuidv4(),
        anomaly_event_id: anomaly.event_id,
        ticker: anomaly.ticker,
        timestamp: Date.now(),
      };
    } catch (err) {
      console.error(`[explanationCache] lookup failed for key ${key}:`, err);
      return null;
    }
  }

  /** Cache an explanation against its candidate-set fingerprint for future reuse. */
  async store(
    ticker: string,
    direction: string,
    tier: string,
    candidateIds: string[],
    explanation: ExplanationGenerated
  ): Promise<void> {
    const key = computeKey(ticker, direction, tier, candidateIds);
    const docRef = this.db.collection("explanation_cache").doc(key);
    try {
      await docRef.set({
        explanation_event_id: explanation.event_id,
        cached_at: Date.now(),
      } as ExplanationCacheDoc);
    } catch (err) {
      console.error(`[explanationCache] store failed for key ${key}:`, err);
    }
  }
}
