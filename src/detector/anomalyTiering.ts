/**
 * Magnitude tiering for the explanation pipeline.
 *
 * Why this exists: a low subscriber sensitivity threshold means
 * detector-svc fires far more PriceAnomalyDetected events, many of which
 * are just statistical noise near the threshold boundary. Without
 * tiering, EVERY one of those triggers a Claude API call in agent-svc
 * (cost) and risks the model manufacturing a plausible-sounding but
 * false explanation for a move that has no real cause (accuracy).
 *
 * Tiers:
 *  - small:  skip the explanation agent entirely. Report the raw stat
 *            (price moved X%, z-score Y) with no cause attempted. Zero
 *            LLM calls, zero false-explanation risk.
 *  - medium: normal one-shot explanation pipeline (unchanged behavior -
 *            no retry budget).
 *  - large:  full bounded retry loop (see explanationAgent.ts /
 *            agent-svc) - most likely to be a genuinely notable move,
 *            so it's worth the extra attempts to get a grounded
 *            explanation instead of falling back early.
 */

export type AnomalyTier = "small" | "medium" | "large";

export interface TieringThresholds {
  /** max(priceZ, volumeZ) at/above which an anomaly is "medium". */
  mediumZ: number;
  /** max(priceZ, volumeZ) at/above which an anomaly is "large". */
  largeZ: number;
}

export const DEFAULT_TIERING_THRESHOLDS: TieringThresholds = {
  mediumZ: 3.5,
  largeZ: 6.0,
};

const MAX_RETRIES_BY_TIER: Record<AnomalyTier, number> = {
  small: 0, // explanation agent never called
  medium: 0, // one-shot only, matches existing pre-tiering behavior
  large: 3, // bounded Plan-Act-Observe-Decide loop
};

/**
 * Model routing by tier - a cost lever applied the same way maxRetries
 * already is. Medium-tier anomalies are the bulk of production volume
 * (one-shot, no retry) and this is a fairly bounded citation task -
 * read a handful of news/sentiment candidates, decide which (if any)
 * support the anomaly, cite the event_id. That doesn't need frontier
 * reasoning, so it routes to the cheapest current model. Large-tier
 * anomalies (the retry loop, highest fabrication-risk stakes - see
 * ADR-008) keep the more capable model, since that's where schema
 * reliability and citation judgment under repeated rejection feedback
 * matter most.
 */
const MODEL_BY_TIER: Record<AnomalyTier, string> = {
  small: "", // explanation agent never called for small tier - value unused
  medium: "claude-haiku-4-5-20251001",
  large: "claude-sonnet-5",
};

export function selectModelForTier(tier: AnomalyTier): string {
  return MODEL_BY_TIER[tier];
}

export interface TieringResult {
  tier: AnomalyTier;
  maxRetries: number;
}

export function classifyAnomalyTier(
  priceZScore: number,
  volumeZScore: number,
  thresholds: TieringThresholds = DEFAULT_TIERING_THRESHOLDS,
): TieringResult {
  const maxZ = Math.max(priceZScore, volumeZScore);
  let tier: AnomalyTier;
  if (maxZ >= thresholds.largeZ) {
    tier = "large";
  } else if (maxZ >= thresholds.mediumZ) {
    tier = "medium";
  } else {
    tier = "small";
  }
  return { tier, maxRetries: MAX_RETRIES_BY_TIER[tier] };
}
