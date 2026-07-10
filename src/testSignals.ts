/**
 * Standalone sanity test for the new signal modules - no network needed,
 * so this runs fine even in a sandboxed environment. Not a full eval
 * harness, just a smoke test that the logic behaves as designed.
 */
import { NewsVolumeTracker } from "./signals/newsVolumeTracker";
import { checkSentimentCoherence } from "./signals/sentimentCoherence";
import {
  computeConfidence,
  temporalProximityScore,
} from "./signals/confidenceScorer";
import { NewsArticleIngested } from "./events/types";

console.log("=== News volume tracker ===");
const tracker = new NewsVolumeTracker();
// Simulate a normal baseline of ~2 articles per fetch for a while.
for (let i = 0; i < 5; i++) {
  const r = tracker.record("BTC-USD", 2);
  console.log(`  fetch ${i}: count=2 baseline=${r.baselineRate.toFixed(2)} spike=${r.isSpike}`);
}
// Then a real spike.
const spikeResult = tracker.record("BTC-USD", 12);
console.log(
  `  spike fetch: count=12 baseline=${spikeResult.baselineRate.toFixed(2)} ratio=${spikeResult.ratio.toFixed(2)} spike=${spikeResult.isSpike}`
);
if (!spikeResult.isSpike) {
  throw new Error("Expected a spike to be detected after baseline warmup");
}

console.log("\n=== Sentiment coherence ===");
const bearishArticle: NewsArticleIngested = {
  type: "NewsArticleIngested",
  event_id: "n1",
  ticker: "BTC-USD",
  timestamp: Date.now(),
  headline: "Regulator announces crackdown, exchange hack investigation continues",
  summary: "Fears of a ban grow after the exploit.",
  source: "test-source",
  url: "https://example.com",
};
const coherentCheck = checkSentimentCoherence(bearishArticle, "down");
console.log(
  `  bearish article + price down: sentiment=${coherentCheck.sentiment} coherent=${coherentCheck.isCoherent}`
);
if (!coherentCheck.isCoherent) {
  throw new Error("Expected bearish news + down price to be coherent");
}

const contradictionCheck = checkSentimentCoherence(bearishArticle, "up");
console.log(
  `  bearish article + price up: sentiment=${contradictionCheck.sentiment} coherent=${contradictionCheck.isCoherent}`
);
if (contradictionCheck.isCoherent) {
  throw new Error("Expected bearish news + up price to be a contradiction");
}

console.log("\n=== Temporal proximity ===");
const now = Date.now();
const closeScore = temporalProximityScore(now - 5 * 60 * 1000, now); // 5 min before
const farScore = temporalProximityScore(now - 24 * 60 * 60 * 1000, now); // 24h before
console.log(`  5 min before: ${closeScore.toFixed(3)}`);
console.log(`  24h before: ${farScore.toFixed(3)}`);
if (!(closeScore > farScore)) {
  throw new Error("Expected closer citation to score higher than a distant one");
}

console.log("\n=== Confidence scorer ===");
const goodConfidence = computeConfidence({
  structurallyGrounded: true,
  newsVolumeSpike: true,
  sentimentCoherent: true,
  sourceCount: 3,
  proximityScore: 0.9,
  semanticSupport: true,
});
console.log(`  strong signals: score=${goodConfidence.score.toFixed(2)}`, goodConfidence.breakdown);

const weakConfidence = computeConfidence({
  structurallyGrounded: true,
  newsVolumeSpike: false,
  sentimentCoherent: false,
  sourceCount: 1,
  proximityScore: 0.1,
  semanticSupport: false,
});
console.log(`  weak/contradictory signals: score=${weakConfidence.score.toFixed(2)}`, weakConfidence.breakdown);

const gatedConfidence = computeConfidence({
  structurallyGrounded: false,
  newsVolumeSpike: true,
  sentimentCoherent: true,
  sourceCount: 3,
  proximityScore: 1,
  semanticSupport: true,
});
console.log(`  structural gate failed (should be 0): score=${gatedConfidence.score.toFixed(2)}`);
if (gatedConfidence.score !== 0) {
  throw new Error("Expected structural grounding failure to force confidence to 0");
}
if (!(goodConfidence.score > weakConfidence.score)) {
  throw new Error("Expected strong signals to score higher than weak/contradictory ones");
}

console.log("\nAll signal sanity checks passed.");
