/**
 * Computes a composite confidence score from independently verifiable
 * signals, rather than trusting the LLM's bare self-reported confidence
 * number. Each input here is either a deterministic computation (news
 * volume spike, sentiment coherence, source diversity, temporal
 * proximity) or a narrow, cheap free-model check (semantic support) -
 * none of it is "ask the model how confident it feels."
 */
export interface ConfidenceInputs {
  structurallyGrounded: boolean; // hard gate - see note below
  newsVolumeSpike: boolean;
  sentimentCoherent: boolean | null; // null = no sentiment signal available
  sourceCount: number; // distinct sources among cited articles
  proximityScore: number; // 0-1, 1 = very close in time, decays with distance
  semanticSupport: boolean | null; // null = check skipped (no GROQ_API_KEY etc.)
}

export interface ConfidenceResult {
  score: number; // 0-1
  breakdown: Record<string, number>;
}

export function computeConfidence(inputs: ConfidenceInputs): ConfidenceResult {
  // Hard gate: if structural grounding failed (fabricated id, or citing
  // a future event), no amount of other signal should produce a
  // nonzero confidence - this is a correctness violation, not a weak
  // signal.
  if (!inputs.structurallyGrounded) {
    return { score: 0, breakdown: { structural_gate: 0 } };
  }

  const breakdown: Record<string, number> = {};

  // Weighted combination. Weights are a starting point, not tuned against
  // real data yet - this is exactly what your eval harness (replaying
  // historical anomalies against documented real causes) should
  // calibrate over time.
  breakdown.news_volume_spike = inputs.newsVolumeSpike ? 0.25 : 0.05;
  breakdown.sentiment_coherence =
    inputs.sentimentCoherent === null
      ? 0.1 // unknown - small neutral credit, not a penalty
      : inputs.sentimentCoherent
        ? 0.2
        : 0.0; // directional contradiction - real penalty
  breakdown.source_diversity = Math.min(inputs.sourceCount / 3, 1) * 0.2;
  breakdown.temporal_proximity = inputs.proximityScore * 0.15;
  breakdown.semantic_support =
    inputs.semanticSupport === null
      ? 0.1 // check skipped - small neutral credit
      : inputs.semanticSupport
        ? 0.2
        : 0.0; // model actively said the content doesn't support the claim

  const score = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return { score: Math.min(score, 1), breakdown };
}

/** Simple exponential decay: closer in time to the anomaly = closer to 1. */
export function temporalProximityScore(
  citationTimestamp: number,
  anomalyTimestamp: number,
  halfLifeMs = 2 * 60 * 60 * 1000 // 2 hours
): number {
  const deltaMs = Math.max(anomalyTimestamp - citationTimestamp, 0);
  return Math.pow(0.5, deltaMs / halfLifeMs);
}
