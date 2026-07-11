/**
 * Live smoke test for the external integrations (Adanos sentiment,
 * cryptocurrency.cv news, Claude, optionally Groq) - deliberately
 * separate from runEvals.ts, which replays hand-authored scenarios and
 * never touches the real Adanos/news APIs at all.
 *
 * GUARANTEES:
 *   - Adanos:   exactly 1 HTTP call (no caching class involved - this
 *               bypasses SentimentIngestion's Firestore cache entirely,
 *               since the point here is a one-shot API check, not
 *               exercising the cache).
 *   - news:     exactly 1 call to fetchRecentNews() for ONE ticker. Note
 *               fetchRecentNews itself fires 2 HTTP requests internally
 *               (ticker-scoped + breaking feed) - that's inherent to how
 *               newsIngestion.ts is written, not something this script
 *               adds on top of.
 *   - Claude:   exactly 1 call. Explanation is generated directly via
 *               generateExplanation() with NO retry loop - this
 *               deliberately bypasses explainWithRetries() in agent-svc,
 *               which could call Claude up to 4 times for a "large" tier
 *               anomaly. If you want to test the retry loop itself,
 *               that's a separate, explicit decision - see the comment
 *               at the bottom of this file.
 *   - Groq:     at most 1 call, and ONLY if GROQ_API_KEY is set AND the
 *               explanation actually cited something. Set
 *               SKIP_SEMANTIC_CHECK=1 to force-skip even then.
 *
 * NOTHING is written to Firestore or published to Pub/Sub - this is a
 * pure dry run, safe to re-run without polluting your real event log.
 *
 * Usage:
 *   export ANTHROPIC_API_KEY=sk-ant-...
 *   export ADANOS_API_KEY=...        # optional - skips sentiment if unset
 *   export GROQ_API_KEY=...          # optional - skips semantic check if unset
 *   npx tsx src/eval/testLiveExternalApis.ts BTC-USD
 */
import "dotenv/config";
import { v4 as uuidv4 } from "uuid";
import { fetchRecentNews } from "../news/newsIngestion";
import { generateExplanation } from "../agent/explanationAgent";
import { EventStore } from "../events/store";
import { GroundingVerifier } from "../agent/groundingVerifier";
import { verifyClaimSupportedByContent } from "../signals/semanticVerifier";
import {
  computeConfidence,
  temporalProximityScore,
} from "../signals/confidenceScorer";
import { checkSentimentCoherence } from "../signals/sentimentCoherence";
import {
  NewsArticleIngested,
  PriceAnomalyDetected,
  SentimentSnapshotIngested,
} from "../events/types";

const ADANOS_BASE_URL = "https://api.adanos.org";

/**
 * One-shot Adanos fetch, deliberately independent of
 * src/sentiment/sentimentIngestion.ts's Firestore-backed cache class -
 * this script has no Firestore dependency at all. Returns null (not a
 * thrown error) on any failure, same "confidence booster, not a hard
 * requirement" philosophy as the rest of the pipeline.
 */
async function fetchSentimentOnce(
  ticker: string,
): Promise<SentimentSnapshotIngested | null> {
  const apiKey = process.env.ADANOS_API_KEY;
  if (!apiKey) {
    console.log(
      "[sentiment] ADANOS_API_KEY not set - skipping (0 Adanos calls made)",
    );
    return null;
  }

  const symbol = ticker.split("-")[0];
  const url = `${ADANOS_BASE_URL}/v1/reddit-crypto/token?ticker=${encodeURIComponent(symbol)}`;

  console.log(`[sentiment] making the ONE Adanos call: GET ${url}`);
  try {
    const res = await fetch(url, { headers: { "X-API-Key": apiKey } });
    if (!res.ok) {
      console.error(
        `[sentiment] HTTP ${res.status} - treating as no sentiment data`,
      );
      return null;
    }
    const data = await res.json();
    console.log("[sentiment] raw response:", JSON.stringify(data, null, 2));

    return {
      type: "SentimentSnapshotIngested",
      event_id: uuidv4(),
      ticker,
      timestamp: Date.now(),
      source: "adanos-reddit-crypto",
      buzz_score: data.buzz_score ?? 0,
      sentiment_score: data.sentiment_score ?? 0,
      trend:
        data.trend === "rising" || data.trend === "falling"
          ? data.trend
          : "stable",
      mention_count: data.mention_count ?? data.mentions ?? 0,
    };
  } catch (err) {
    console.error("[sentiment] request failed:", err);
    return null;
  }
}

async function main() {
  const ticker = process.argv[2] ?? "BTC-USD";
  const skipSemantic = process.env.SKIP_SEMANTIC_CHECK === "1";

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "ANTHROPIC_API_KEY is required (this test makes exactly 1 real Claude call).",
    );
    process.exit(1);
  }

  console.log(`=== Live external API smoke test for ${ticker} ===\n`);
  console.log(
    "This makes AT MOST: 1 Adanos call, 2 news HTTP requests (1 fetchRecentNews call),",
  );
  console.log(
    "1 Claude call, and 0-1 Groq calls. No Firestore/Pub-Sub writes.\n",
  );

  // --- Step 1: news (1 fetchRecentNews call = 2 HTTP requests internally) ---
  console.log(`[news] making the ONE fetchRecentNews call for ${ticker}...`);
  const allNews = await fetchRecentNews(ticker, 10);
  console.log(
    `[news] got ${allNews.length} article(s): ` +
      `${allNews.filter((n) => n.scope === "ticker_specific").length} ticker_specific, ` +
      `${allNews.filter((n) => n.scope === "market_wide").length} market_wide`,
  );
  allNews
    .slice(0, 5)
    .forEach((n) =>
      console.log(`  [${n.scope}] "${n.headline}" (${n.source})`),
    );

  // --- Step 2: sentiment (0 or 1 Adanos call) ---
  console.log("");
  const sentimentSnapshot = await fetchSentimentOnce(ticker);
  if (sentimentSnapshot) {
    console.log(
      `[sentiment] parsed: buzz=${sentimentSnapshot.buzz_score}, ` +
        `sentiment=${sentimentSnapshot.sentiment_score.toFixed(2)}, trend=${sentimentSnapshot.trend}, ` +
        `mentions=${sentimentSnapshot.mention_count}`,
    );
  }

  // --- Step 3: build ONE synthetic anomaly using the real fetched data ---
  const anomalyTimestamp = Date.now();
  const candidateNews: NewsArticleIngested[] = allNews
    .filter((n) => n.timestamp <= anomalyTimestamp)
    .slice(0, 10);

  const anomaly: PriceAnomalyDetected = {
    type: "PriceAnomalyDetected",
    event_id: uuidv4(),
    ticker,
    timestamp: anomalyTimestamp,
    price: 0, // synthetic - this script tests the news/sentiment/explanation
    price_direction: "up", // wiring, not a real price feed
    price_z_score: 5.0, // deliberately in the "medium" tier band, well
    volume_z_score: 4.0, // below the retry-loop threshold - see file header
    rolling_mean: 0,
    rolling_mad: 0.001,
    recent_price_context: [],
  };

  // --- Step 4: exactly ONE Claude call, no retry loop ---
  console.log("\n[claude] making the ONE explanation call...");
  const explanation = await generateExplanation({
    anomaly,
    recentTicks: [],
    candidateNews,
    sentimentSnapshot,
  });
  console.log(`[claude] claim: "${explanation.claim}"`);
  console.log(`[claude] human_summary: ${explanation.human_summary}`);
  console.log(
    `[claude] cited_event_ids: [${explanation.cited_event_ids.join(", ")}]`,
  );
  console.log(`[claude] self-reported confidence: ${explanation.confidence}`);

  // --- Step 5: structural grounding check (free, no external call) ---
  const store = new EventStore();
  candidateNews.forEach((n) => store.append(n));
  if (sentimentSnapshot) store.append(sentimentSnapshot);
  store.append(anomaly);
  store.append(explanation);

  const verifier = new GroundingVerifier(store);
  const verdict = verifier.verifyStructural(explanation);
  console.log(
    `\n[grounding] structurally_grounded: ${verdict.structurally_grounded}` +
      (verdict.failure_reason ? ` (${verdict.failure_reason})` : ""),
  );

  // --- Step 6: semantic check - at most 1 Groq call ---
  let semanticSupport: boolean | null = null;
  if (skipSemantic) {
    console.log(
      "[semantic] SKIP_SEMANTIC_CHECK=1 - skipping (0 Groq calls made)",
    );
  } else if (explanation.cited_event_ids.length === 0) {
    console.log("[semantic] nothing cited - skipping (0 Groq calls made)");
  } else if (!process.env.GROQ_API_KEY) {
    console.log(
      "[semantic] GROQ_API_KEY not set - skipping (0 Groq calls made)",
    );
  } else {
    const citedContent = explanation.cited_event_ids
      .map((id) => store.getById(id))
      .filter((e): e is NonNullable<typeof e> => !!e)
      .map((e) =>
        e.type === "NewsArticleIngested"
          ? `${e.headline}: ${e.summary}`
          : e.type === "SentimentSnapshotIngested"
            ? `Reddit sentiment score=${e.sentiment_score}`
            : "",
      );
    console.log("[semantic] making the ONE Groq call...");
    semanticSupport = await verifyClaimSupportedByContent(
      explanation.claim,
      citedContent,
    );
    console.log(`[semantic] supported: ${semanticSupport}`);
  }

  // --- Step 7: composite confidence, same formula as grounding-svc ---
  const citedArticles = candidateNews.filter((n) =>
    explanation.cited_event_ids.includes(n.event_id),
  );
  const sentimentResults = citedArticles.map((a) =>
    checkSentimentCoherence(a, anomaly.price_direction),
  );
  const confidence = computeConfidence({
    structurallyGrounded: verdict.structurally_grounded,
    newsVolumeSpike: false, // no baseline history in a one-off script
    sentimentCoherent:
      sentimentResults.length === 0
        ? null
        : sentimentResults.every((r) => r.isCoherent),
    sourceCount:
      new Set(citedArticles.map((a) => a.source)).size +
      (sentimentSnapshot ? 1 : 0),
    proximityScore:
      citedArticles.length === 0
        ? 0
        : citedArticles.reduce(
            (s, a) =>
              s + temporalProximityScore(a.timestamp, anomaly.timestamp),
            0,
          ) / citedArticles.length,
    semanticSupport,
    tickerSpecificFraction:
      citedArticles.length === 0
        ? 0
        : citedArticles.filter((a) => a.scope === "ticker_specific").length /
          citedArticles.length,
  });

  console.log(
    `\n[confidence] composite: ${confidence.score.toFixed(2)}`,
    confidence.breakdown,
  );
  console.log("\n=== Done. No Firestore/Pub-Sub writes were made. ===");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

/**
 * If/when you separately want to test the RETRY LOOP specifically
 * (explainWithRetries in agent-svc), that's a deliberate additional
 * Claude-call-budget decision - force a "large" tier anomaly
 * (price_z_score/volume_z_score >= 6) with a candidate pool likely to
 * get rejected on the first attempt (e.g. only a market_wide article,
 * no ticker_specific one), and expect up to 3 Claude calls for that
 * single test run, not 1.
 */
