import { Firestore } from "@google-cloud/firestore";
import { Subscription } from "./types";

/**
 * Firestore-backed store for user subscriptions (userId -> ticker +
 * their own sensitivity thresholds).
 *
 * COST NOTE: getMinThresholdsForTicker() is the hot-path method
 * (detector-svc needs it to configure its per-ticker trigger), but
 * querying Firestore on every tick would be far too expensive (10-15
 * ticks/sec x a Firestore read each = massively over free-tier limits).
 * Instead this caches the computed min-thresholds per ticker in memory,
 * refreshed on a timer (default every 5 minutes) - subscriptions change
 * rarely relative to tick frequency, so a few minutes of staleness on a
 * new/changed subscription is an acceptable tradeoff, not a correctness
 * bug.
 */

const DEFAULT_THRESHOLDS = {
  price_z_threshold: 3.0,
  volume_z_threshold: 2.0,
  debounce_ms: 5 * 60 * 1000,
};

export class SubscriptionsStore {
  private db: Firestore;
  private cache: Map<
    string,
    { price_z_threshold: number; volume_z_threshold: number; debounce_ms: number }
  > = new Map();
  private lastRefreshedAt = 0;
  private refreshIntervalMs: number;

  constructor(refreshIntervalMs = 5 * 60 * 1000, projectId?: string) {
    this.db = projectId ? new Firestore({ projectId }) : new Firestore();
    this.refreshIntervalMs = refreshIntervalMs;
  }

  async create(sub: Omit<Subscription, "subscription_id" | "created_at">): Promise<Subscription> {
    const docRef = this.db.collection("subscriptions").doc();
    const full: Subscription = {
      ...sub,
      subscription_id: docRef.id,
      created_at: Date.now(),
    };
    await docRef.set(full);
    return full;
  }

  async getForTicker(ticker: string): Promise<Subscription[]> {
    const snapshot = await this.db
      .collection("subscriptions")
      .where("ticker", "==", ticker)
      .get();
    return snapshot.docs.map((d) => d.data() as Subscription);
  }

  /**
   * Returns the minimum (most sensitive) thresholds across all
   * subscribers for a ticker, using an in-memory cache refreshed on a
   * timer rather than querying Firestore per call. Falls back to
   * DEFAULT_THRESHOLDS if no subscribers exist yet, so the system works
   * out of the box with zero subscriptions - same behavior as before
   * this feature existed.
   */
  async getMinThresholdsForTicker(ticker: string): Promise<{
    price_z_threshold: number;
    volume_z_threshold: number;
    debounce_ms: number;
  }> {
    const now = Date.now();
    if (now - this.lastRefreshedAt > this.refreshIntervalMs) {
      await this.refreshCache();
    }
    return this.cache.get(ticker) ?? DEFAULT_THRESHOLDS;
  }

  private async refreshCache(): Promise<void> {
    const snapshot = await this.db.collection("subscriptions").get();
    const byTicker: Map<string, Subscription[]> = new Map();

    for (const doc of snapshot.docs) {
      const sub = doc.data() as Subscription;
      if (!byTicker.has(sub.ticker)) byTicker.set(sub.ticker, []);
      byTicker.get(sub.ticker)!.push(sub);
    }

    this.cache.clear();
    for (const [ticker, subs] of byTicker.entries()) {
      this.cache.set(ticker, {
        price_z_threshold: Math.min(...subs.map((s) => s.price_z_threshold)),
        volume_z_threshold: Math.min(...subs.map((s) => s.volume_z_threshold)),
        debounce_ms: Math.min(...subs.map((s) => s.debounce_ms)),
      });
    }
    this.lastRefreshedAt = Date.now();
  }
}
