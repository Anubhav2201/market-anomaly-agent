/**
 * End-to-end demo: replay synthetic price ticks through the detector,
 * generate a (hand-scripted, standing in for an LLM call) explanation,
 * and run it through the grounding verifier.
 *
 * This proves the shape of the pipeline works before wiring live
 * websockets, Pub/Sub, or the real Claude API call.
 */
import { EventStore } from "./events/store";
import { AnomalyDetector } from "./detector/anomalyDetector";
import { GroundingVerifier } from "./agent/groundingVerifier";
import { PriceTick, NewsArticleIngested, ExplanationGenerated } from "./events/types";
import { v4 as uuidv4 } from "uuid";

const store = new EventStore();
const detector = new AnomalyDetector();
const verifier = new GroundingVerifier(store);

const TICKER = "BTCUSDT";
const startTime = Date.now() - 60 * 60 * 1000; // 1 hour ago

function tick(offsetMs: number, price: number, volume: number): PriceTick {
  const t: PriceTick = {
    type: "PriceTick",
    event_id: uuidv4(),
    ticker: TICKER,
    timestamp: startTime + offsetMs,
    price,
    volume,
  };
  store.append(t);
  return t;
}

console.log("=== Phase 1: warm up baseline with 40 normal ticks ===");
let price = 65000;
for (let i = 0; i < 40; i++) {
  // small random walk, normal volume
  price += (Math.random() - 0.5) * 20;
  const t = tick(i * 1000, price, 10 + Math.random() * 2);
  detector.process(t);
}
console.log(`Baseline warmed up around price=${price.toFixed(2)}`);

console.log("\n=== Phase 2: ingest a news article BEFORE the anomaly ===");
const newsEvent: NewsArticleIngested = {
  type: "NewsArticleIngested",
  event_id: uuidv4(),
  ticker: TICKER,
  timestamp: startTime + 40 * 1000 + 500, // just after warmup, before the spike
  headline: "Regulator announces new crypto custody rules",
  summary:
    "A major regulator announced stricter custody requirements for exchanges, effective immediately.",
  source: "example-news-feed",
  url: "https://example.com/news/123",
};
store.append(newsEvent);
console.log(`Ingested news event_id=${newsEvent.event_id}`);

console.log("\n=== Phase 3: inject a genuine anomaly (price+volume spike) ===");
const spikeTick = tick(41 * 1000, price * 0.94, 80); // 6% drop, 8x volume
const anomalyResult = detector.process(spikeTick);

if (!anomalyResult) {
  throw new Error("No anomaly detected - unexpected for this synthetic scenario.");
}
const anomaly = anomalyResult;
store.append(anomaly);
console.log(
  `Anomaly detected: priceZ=${anomaly.price_z_score.toFixed(2)} volumeZ=${anomaly.volume_z_score.toFixed(2)} event_id=${anomaly.event_id}`
);

console.log("\n=== Phase 4: agent generates a (scripted) grounded explanation ===");
const goodExplanation: ExplanationGenerated = {
  type: "ExplanationGenerated",
  event_id: uuidv4(),
  ticker: TICKER,
  timestamp: anomaly.timestamp + 100,
  anomaly_event_id: anomaly.event_id,
  claim: "regulatory_news",
  human_summary:
    "BTC dropped sharply alongside a volume spike shortly after a regulator announced new custody rules.",
  cited_event_ids: [newsEvent.event_id],
  confidence: 0.82,
  candidate_news_count: 1,
};
store.append(goodExplanation);

const verdictGood = verifier.verifyStructural(goodExplanation);
store.append(verdictGood);
console.log("Verdict for grounded explanation:", verdictGood);

console.log(
  "\n=== Phase 5: agent generates a BAD explanation citing a future event ==="
);
const futureNews: NewsArticleIngested = {
  type: "NewsArticleIngested",
  event_id: uuidv4(),
  ticker: TICKER,
  timestamp: anomaly.timestamp + 10 * 60 * 1000, // 10 min AFTER the anomaly
  headline: "Analysts explain yesterday's BTC drop",
  summary: "Retrospective analysis of the earlier price action.",
  source: "example-news-feed",
  url: "https://example.com/news/124",
};
store.append(futureNews);

const badExplanation: ExplanationGenerated = {
  type: "ExplanationGenerated",
  event_id: uuidv4(),
  ticker: TICKER,
  timestamp: anomaly.timestamp + 100,
  anomaly_event_id: anomaly.event_id,
  claim: "analyst_retrospective",
  human_summary: "Analysts say the drop was due to profit taking.",
  cited_event_ids: [futureNews.event_id], // BUG: this news came AFTER the anomaly
  confidence: 0.6,
  candidate_news_count: 1,
};
store.append(badExplanation);

const verdictBad = verifier.verifyStructural(badExplanation);
store.append(verdictBad);
console.log("Verdict for causality-violating explanation:", verdictBad);

console.log("\n=== Phase 6: agent cites a nonexistent event_id (fabrication) ===");
const fabricatedExplanation: ExplanationGenerated = {
  type: "ExplanationGenerated",
  event_id: uuidv4(),
  ticker: TICKER,
  timestamp: anomaly.timestamp + 100,
  anomaly_event_id: anomaly.event_id,
  claim: "whale_sell_off",
  human_summary: "A large holder sold a significant position.",
  cited_event_ids: ["event-does-not-exist-12345"],
  confidence: 0.55,
  candidate_news_count: 1,
};
store.append(fabricatedExplanation);

const verdictFabricated = verifier.verifyStructural(fabricatedExplanation);
store.append(verdictFabricated);
console.log("Verdict for fabricated citation:", verdictFabricated);

console.log("\n=== Summary ===");
console.log(`Total events in store: ${store.all().length}`);
console.log(
  `Grounded explanations verified: ${
    store.ofType("GroundingVerified").filter((v) => v.structurally_grounded).length
  } / ${store.ofType("GroundingVerified").length}`
);
