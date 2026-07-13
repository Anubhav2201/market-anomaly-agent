import { Firestore } from "@google-cloud/firestore";

/**
 * Firestore-backed feature flags - the "stop spending money right now"
 * kill switch. Deliberately Firestore-backed rather than an env var:
 * an env var requires a redeploy (gcloud run services update
 * --set-env-vars) to change, which takes real time and requires a
 * terminal/gcloud session open. A Firestore doc can be flipped
 * instantly from the Firestore console (a checkbox, basically), the
 * gcloud CLI, or a phone browser - no redeploy, no terminal required
 * at the moment you actually need it.
 *
 * Doc lives at system_config/feature_flags. Missing doc/fields default
 * to TRUE (fail-open) - this is a safety feature layered ON TOP of
 * normal operation, its absence on first deploy shouldn't silently
 * break the pipeline. The point is to let you explicitly turn things
 * OFF, not to require explicitly turning them on.
 *
 * Cached in-memory with a short TTL (15s) so a kill-switch flip takes
 * effect quickly without hitting Firestore on every single request -
 * balances "toggling actually works fast" against "don't burn Firestore
 * read quota checking a flag that almost never changes."
 */

export type FeatureFlagName =
  | "pipeline_enabled" // MASTER switch - agent-svc does nothing at all if false
  | "claude_enabled" // gates every Claude API call
  | "tiingo_enabled" // gates news fetch (Tiingo Power - the one paid data source)
  | "adanos_enabled" // gates sentiment fetch
  | "groq_enabled"; // gates the optional semantic verification call

interface FeatureFlagsDoc {
  pipeline_enabled?: boolean;
  claude_enabled?: boolean;
  tiingo_enabled?: boolean;
  adanos_enabled?: boolean;
  groq_enabled?: boolean;
}

const CACHE_TTL_MS = 15 * 1000;
const DOC_PATH = { collection: "system_config", id: "feature_flags" };

export class FeatureFlags {
  private db: Firestore;
  private cache: FeatureFlagsDoc | null = null;
  private cachedAt = 0;

  constructor(projectId?: string) {
    this.db = projectId ? new Firestore({ projectId }) : new Firestore();
  }

  /**
   * Returns whether a given flag is enabled. Defaults to TRUE
   * (fail-open) if Firestore is unreachable, the doc doesn't exist, or
   * the specific field is unset - a transient Firestore hiccup should
   * never silently halt the whole pipeline. The kill switch is for
   * DELIBERATE stops, not accidental ones from an infra blip.
   */
  async isEnabled(flag: FeatureFlagName): Promise<boolean> {
    const doc = await this.getFlags();
    return doc[flag] !== false; // anything except explicit false is "enabled"
  }

  private async getFlags(): Promise<FeatureFlagsDoc> {
    const now = Date.now();
    if (this.cache && now - this.cachedAt < CACHE_TTL_MS) {
      return this.cache;
    }

    try {
      const snap = await this.db.collection(DOC_PATH.collection).doc(DOC_PATH.id).get();
      this.cache = snap.exists ? (snap.data() as FeatureFlagsDoc) : {};
      this.cachedAt = now;
      return this.cache;
    } catch (err) {
      console.error("[featureFlags] read failed, defaulting to all-enabled:", err);
      // Fail-open on error too, same reasoning as a missing doc - and
      // deliberately DON'T cache the failure, so the next check retries
      // rather than being stuck fail-open for a full TTL window if
      // Firestore comes back quickly.
      return {};
    }
  }
}
