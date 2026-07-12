import { Firestore } from "@google-cloud/firestore";
import { AnomalyTier } from "./anomalyTiering";

/**
 * Per-ticker cooldown: stops a single sustained price move from firing
 * the ENTIRE downstream pipeline (news fetch, sentiment fetch, Claude
 * call) on every consecutive tick that stays past threshold.
 *
 * Why this exists: EWMA/MAD doesn't fire once per real-world event - it
 * fires once per TICK that's past threshold, and a real 10-minute pump
 * can hold the detector above threshold for dozens of consecutive
 * ticks. Without a cooldown, that's dozens of redundant news fetches,
 * sentiment fetches, and Claude calls for what is, causally, ONE event.
 * This is the single highest-impact cost lever in the whole pipeline -
 * bigger than any caching strategy, because it eliminates the
 * redundant work at the source instead of making it cheaper.
 *
 * Design:
 *   - Firestore-backed (not in-memory), same reasoning as every other
 *     shared-state cache in this project (sentimentIngestion.ts,
 *     newsCache.ts) - agent-svc can run multiple Cloud Run instances,
 *     and an in-memory cooldown wouldn't be shared across them.
 *   - Tier escalation BREAKS the cooldown deliberately: if a ticker is
 *     in cooldown at "medium" tier and a new anomaly arrives at
 *     "large" tier, that's genuinely new information (the move got
 *     materially bigger) and should NOT be suppressed just because a
 *     smaller version of it was recently explained.
 *   - Cooldown window is intentionally shorter than the sentiment
 *     cache TTL (1 hour) - a real news-driven move often keeps
 *     evolving over 15-30 minutes, and we don't want to suppress a
 *     second GENUINE anomaly that arrives after the first one's cause
 *     has already played out, just because it's the same ticker.
 */

const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes

const TIER_RANK: Record<AnomalyTier, number> = {
  small: 0,
  medium: 1,
  large: 2,
};

interface CooldownDoc {
  ticker: string;
  last_processed_at: number;
  last_tier: AnomalyTier;
}

export class AnomalyCooldownTracker {
  private db: Firestore;
  private cooldownMs: number;

  constructor(projectId?: string, cooldownMs: number = DEFAULT_COOLDOWN_MS) {
    this.db = projectId ? new Firestore({ projectId }) : new Firestore();
    this.cooldownMs = cooldownMs;
  }

  /**
   * Returns true if this anomaly should be processed (fetch news,
   * fetch sentiment, call Claude), false if it should be suppressed as
   * a redundant re-fire of a recently-processed move at the same or
   * lower tier.
   *
   * Does NOT itself record the attempt - call `recordProcessed()`
   * separately once the pipeline has actually run, so a crash/error
   * mid-pipeline doesn't incorrectly suppress a legitimate retry of
   * the SAME anomaly on Pub/Sub redelivery.
   */
  async shouldProcess(ticker: string, tier: AnomalyTier): Promise<boolean> {
    const docRef = this.db.collection("anomaly_cooldown").doc(ticker);
    const doc = await docRef.get();

    if (!doc.exists) return true; // never seen this ticker before

    const data = doc.data() as CooldownDoc;
    const elapsed = Date.now() - data.last_processed_at;
    const tierEscalated = TIER_RANK[tier] > TIER_RANK[data.last_tier];

    if (tierEscalated) return true; // genuinely bigger move - always let it through
    if (elapsed >= this.cooldownMs) return true; // cooldown window has passed

    return false; // same-or-lower tier, still within cooldown - suppress
  }

  /** Record that this ticker/tier was actually processed, resetting the cooldown clock. */
  async recordProcessed(ticker: string, tier: AnomalyTier): Promise<void> {
    const docRef = this.db.collection("anomaly_cooldown").doc(ticker);
    await docRef.set({
      ticker,
      last_processed_at: Date.now(),
      last_tier: tier,
    } as CooldownDoc);
  }
}
