/**
 * Full live pipeline: Coinbase websocket -> anomaly detector -> news
 * fetch -> Claude tool-use explanation -> event-sourced grounding
 * verification -> multi-signal confidence scoring.
 *
 * Requires ANTHROPIC_API_KEY set in your environment. GROQ_API_KEY is
 * optional (enables the free-model semantic check; without it, that
 * signal is skipped gracefully, not treated as a failure).
 *
 * This is NOT runnable end-to-end in this sandboxed dev environment (no
 * network access to advanced-trade-ws.coinbase.com or
 * cryptocurrency.cv here) - run it locally with:
 *
 *   export ANTHROPIC_API_KEY=sk-ant-...
 *   export GROQ_API_KEY=gsk-...   # optional
 *   npm install
 *   npx tsc --outDir dist
 *   node dist/live.js
 */
import { EventStore } from "./events/store";
import { AnomalyDetector } from "./detector/anomalyDetector";
import { CoinbaseIngestion } from "./ingestion/coinbaseIngestion";
import { fetchRecentNews } from "./news/newsIngestion";
import { generateExplanation } from "./agent/explanationAgent";
import { GroundingVerifier } from "./agent/groundingVerifier";
import { NewsVolumeTracker } from "./signals/newsVolumeTracker";
import { checkSentimentCoherence } from "./signals/sentimentCoherence";
import { verifyClaimSupportedByContent } from "./signals/semanticVerifier";
import {
  computeConfidence,
  temporalProximityScore,
} from "./signals/confidenceScorer";
import {
  PriceTick,
  NewsArticleIngested,
  PriceAnomalyDetected,
} from "./events/types";

const store = new EventStore();
const detector = new AnomalyDetector({
  priceZThreshold: 3.0,
  volumeZThreshold: 2.0,
  debounceMs: 5 * 60 * 1000,
  warmupTicks: 30,
});
const verifier = new GroundingVerifier(store);
const newsVolumeTracker = new NewsVolumeTracker();

let tickCount = 0;
const startedAt = Date.now();
const explanationInFlight = new Set<string>();

async function handleAnomaly(anomaly: PriceAnomalyDetected) {
  if (explanationInFlight.has(anomaly.ticker)) return;
  explanationInFlight.add(anomaly.ticker);

  try {
    console.log(
      `\nANOMALY: ${anomaly.ticker} price=${anomaly.price} direction=${anomaly.price_direction} ` +
        `priceZ=${anomaly.price_z_score.toFixed(2)} volumeZ=${anomaly.volume_z_score.toFixed(2)}`
    );

    const allNews = await fetchRecentNews(anomaly.ticker, 10);

    // Signal: news-volume spike, independent of any single article's content.
    const volumeResult = newsVolumeTracker.record(anomaly.ticker, allNews.length);

    const candidateNews: NewsArticleIngested[] = allNews.filter(
      (n) => n.timestamp <= anomaly.timestamp
    );
    candidateNews.forEach((n) => store.append(n));

    const recentTicks = store
      .ofType("PriceTick")
      .filter((t) => t.ticker === anomaly.ticker)
      .slice(-10);

    const explanation = await generateExplanation({
      anomaly,
      recentTicks,
      candidateNews,
    });
    store.append(explanation);

    const verdict = verifier.verifyStructural(explanation);
    store.append(verdict);

    // Gather signals only for the citations the model actually used.
    const citedArticles = explanation.cited_event_ids
      .map((id) => candidateNews.find((n) => n.event_id === id))
      .filter((a): a is NewsArticleIngested => !!a);

    const sourceCount = new Set(citedArticles.map((a) => a.source)).size;

    const sentimentResults = citedArticles.map((a) =>
      checkSentimentCoherence(a, anomaly.price_direction)
    );
    const sentimentCoherent =
      sentimentResults.length === 0
        ? null
        : sentimentResults.every((r) => r.isCoherent);

    const avgProximity =
      citedArticles.length === 0
        ? 0
        : citedArticles.reduce(
            (sum, a) =>
              sum + temporalProximityScore(a.timestamp, anomaly.timestamp),
            0
          ) / citedArticles.length;

    const tickerSpecificFraction =
      citedArticles.length === 0
        ? 0
        : citedArticles.filter((a) => a.scope === "ticker_specific").length /
          citedArticles.length;

    // Narrow, cheap free-model semantic check - only runs if GROQ_API_KEY
    // is set; otherwise gracefully returns null (skipped, not failed).
    const semanticSupport =
      citedArticles.length > 0
        ? await verifyClaimSupportedByContent(
            explanation.claim,
            citedArticles.map((a) => `${a.headline}: ${a.summary}`)
          )
        : null;

    const confidence = computeConfidence({
      structurallyGrounded: verdict.structurally_grounded,
      newsVolumeSpike: volumeResult.isSpike,
      sentimentCoherent,
      sourceCount,
      proximityScore: avgProximity,
      semanticSupport,
      tickerSpecificFraction,
    });

    console.log(`   claim: ${explanation.claim}`);
    console.log(`   summary: ${explanation.human_summary}`);
    console.log(
      `   structural grounding: ${verdict.structurally_grounded ? "PASSED" : "FAILED"}` +
        (verdict.failure_reason ? ` - ${verdict.failure_reason}` : "")
    );
    console.log(
      `   news volume: ${volumeResult.currentCount} articles (baseline ~${volumeResult.baselineRate.toFixed(1)}, spike=${volumeResult.isSpike})`
    );
    console.log(
      `   sentiment coherent: ${sentimentCoherent === null ? "n/a" : sentimentCoherent}`
    );
    console.log(`   source count: ${sourceCount}`);
    console.log(`   temporal proximity: ${avgProximity.toFixed(2)}`);
    console.log(
      `   semantic support: ${semanticSupport === null ? "skipped" : semanticSupport}`
    );
    console.log(
      `   COMPOSITE CONFIDENCE: ${confidence.score.toFixed(2)} (model self-reported: ${explanation.confidence})`
    );
    console.log(`   breakdown: ${JSON.stringify(confidence.breakdown)}`);
    console.log("");
  } catch (err) {
    console.error(`[explanation] error for ${anomaly.ticker}:`, err);
  } finally {
    explanationInFlight.delete(anomaly.ticker);
  }
}

const ingestion = new CoinbaseIngestion({
  productIds: ["BTC-USD", "ETH-USD", "SOL-USD"],
  onTick: (tick: PriceTick) => {
    store.append(tick);
    tickCount++;

    const anomaly = detector.process(tick);
    if (anomaly) {
      store.append(anomaly);
      handleAnomaly(anomaly);
    }

    if (tickCount % 100 === 0) {
      const elapsedSec = (Date.now() - startedAt) / 1000;
      console.log(
        `[heartbeat] ${tickCount} ticks processed in ${elapsedSec.toFixed(0)}s ` +
          `(${(tickCount / elapsedSec).toFixed(1)} ticks/sec) - store size: ${store.all().length}`
      );
    }
  },
  onError: (err: Error) => {
    console.error("[CoinbaseIngestion] error:", err.message);
  },
});

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    "ANTHROPIC_API_KEY is not set. Export it before running: export ANTHROPIC_API_KEY=sk-ant-..."
  );
  process.exit(1);
}
if (!process.env.GROQ_API_KEY) {
  console.log(
    "[info] GROQ_API_KEY not set - semantic support check will be skipped (confidence scoring still works without it)."
  );
}

console.log("Starting live ingestion... (Ctrl+C to stop)");
ingestion.start();

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  ingestion.stop();
  process.exit(0);
});
