/**
 * Live smoke test for the external integrations (Adanos sentiment,
 * Tiingo news, Claude, optionally Groq) - deliberately
 * separate from runEvals.ts, which replays hand-authored scenarios and
 * never touches the real Adanos/news APIs at all.
 *
 * GUARANTEES:
 *   - Adanos:   exactly 1 HTTP call by default (ticker_specific
 *               sentiment only, no caching class involved - this
 *               bypasses SentimentIngestion's Firestore cache entirely,
 *               since the point here is a one-shot API check, not
 *               exercising the cache). Set FETCH_MARKET_SENTIMENT=1 to
 *               ALSO fetch the aggregate market-wide reading - this
 *               makes it 2 Adanos calls total, a deliberate opt-in, not
 *               the default.
 *   - news:     exactly 1 call to fetchRecentNews() for ONE ticker. Note
 *               fetchRecentNews itself fires 2 HTTP requests internally
 *               (ticker-scoped + latest/crawlDate feed) - that's inherent
 *               to how newsIngestion.ts is written (Tiingo News API, see
 *               DECISIONS.md ADR-016/017), not something this script adds
 *               on top of. Requires TIINGO_API_KEY - see .env.example.
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
  const url = `${ADANOS_BASE_URL}/reddit/crypto/v1/token/${encodeURIComponent(symbol)}`;

  console.log(`[sentiment] making the ONE Adanos call: GET ${url}`);
  try {
    const res = await fetch(url, { headers: { "X-API-Key": apiKey } });

    if (res.status === 404) {
      console.log(
        `[sentiment] 404 - "${symbol}" is not a supported crypto symbol on Adanos`,
      );
      return null;
    }
    if (!res.ok) {
      console.error(
        `[sentiment] HTTP ${res.status} - treating as no sentiment data`,
      );
      return null;
    }
    const data = await res.json();
    console.log("[sentiment] raw response:", JSON.stringify(data, null, 2));

    if (data.found === false) {
      console.log(
        `[sentiment] "${symbol}" supported but no data this window (found:false) - not an error`,
      );
      return null;
    }

    return {
      type: "SentimentSnapshotIngested",
      event_id: uuidv4(),
      ticker,
      timestamp: Date.now(),
      source: "adanos-reddit-crypto",
      scope: "ticker_specific",
      buzz_score: data.buzz_score ?? 0,
      sentiment_score: data.sentiment_score ?? 0,
      trend:
        data.trend === "rising" || data.trend === "falling"
          ? data.trend
          : "stable",
      mention_count: data.mentions ?? 0,
    };
  } catch (err) {
    console.error("[sentiment] request failed:", err);
    return null;
  }
}

/**
 * Optional second Adanos call (opt-in via FETCH_MARKET_SENTIMENT=1) -
 * the aggregate crypto-wide reading, not specific to any ticker. See
 * DECISIONS.md ADR-014.
 */
async function fetchMarketSentimentOnce(): Promise<SentimentSnapshotIngested | null> {
  const apiKey = process.env.ADANOS_API_KEY;
  if (!apiKey) return null;
  if (process.env.FETCH_MARKET_SENTIMENT !== "1") {
    console.log(
      "[market-sentiment] FETCH_MARKET_SENTIMENT not set to 1 - skipping (0 extra Adanos calls made)",
    );
    return null;
  }

  const url = `${ADANOS_BASE_URL}/reddit/crypto/v1/market-sentiment`;
  console.log(
    `[market-sentiment] making the OPT-IN second Adanos call: GET ${url}`,
  );
  try {
    const res = await fetch(url, { headers: { "X-API-Key": apiKey } });
    if (!res.ok) {
      console.error(
        `[market-sentiment] HTTP ${res.status} - treating as no data`,
      );
      return null;
    }
    const data = await res.json();
    console.log(
      "[market-sentiment] raw response:",
      JSON.stringify(data, null, 2),
    );

    return {
      type: "SentimentSnapshotIngested",
      event_id: uuidv4(),
      ticker: "__MARKET_WIDE__",
      timestamp: Date.now(),
      source: "adanos-reddit-crypto",
      scope: "market_wide",
      buzz_score: data.buzz_score ?? 0,
      sentiment_score: data.sentiment_score ?? 0,
      trend:
        data.trend === "rising" || data.trend === "falling"
          ? data.trend
          : "stable",
      mention_count: data.mentions ?? 0,
      drivers: data.drivers ?? [],
    };
  } catch (err) {
    console.error("[market-sentiment] request failed:", err);
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
  // Full detail for EVERY fetched article, not just a truncated preview -
  // this is what you actually want to eyeball to sanity-check the real
  // Tiingo response against what scopeClassifier.ts assigned.
  allNews.forEach((n, i) => {
    console.log(
      `  [${i + 1}] event_id=${n.event_id} scope=${n.scope} t=${new Date(n.timestamp).toISOString()}`,
    );
    console.log(`      headline: "${n.headline}"`);
    console.log(`      source: ${n.source}`);
    console.log(`      summary: ${n.summary}`);
  });
  if (allNews.length === 0) {
    console.log(
      "  (no articles returned - check TIINGO_API_KEY is set and the ticker symbol)",
    );
  }

  // --- Step 2: sentiment (0-2 Adanos calls: 1 ticker-specific always attempted, 1 market-wide opt-in) ---
  console.log("");
  const [tickerSentiment, marketSentiment] = await Promise.all([
    fetchSentimentOnce(ticker),
    fetchMarketSentimentOnce(),
  ]);
  const sentimentSnapshots = [tickerSentiment, marketSentiment].filter(
    (s): s is SentimentSnapshotIngested => s !== null,
  );
  if (tickerSentiment) {
    console.log(
      `[sentiment] event_id=${tickerSentiment.event_id} scope=${tickerSentiment.scope} ` +
        `buzz=${tickerSentiment.buzz_score}, sentiment=${tickerSentiment.sentiment_score.toFixed(2)}, ` +
        `trend=${tickerSentiment.trend}, mentions=${tickerSentiment.mention_count}`,
    );
  } else {
    console.log(
      "[sentiment] no ticker-specific sentiment data (see reason logged above)",
    );
  }
  if (marketSentiment) {
    console.log(
      `[market-sentiment] event_id=${marketSentiment.event_id} scope=${marketSentiment.scope} ` +
        `buzz=${marketSentiment.buzz_score}, sentiment=${marketSentiment.sentiment_score.toFixed(2)}, ` +
        `trend=${marketSentiment.trend}, mentions=${marketSentiment.mention_count}`,
    );
    if (marketSentiment.drivers && marketSentiment.drivers.length > 0) {
      console.log("      top drivers:");
      marketSentiment.drivers.forEach((d) =>
        console.log(
          `        ${d.symbol}: mentions=${d.mentions}, buzz=${d.buzz_score}, sentiment=${d.sentiment_score.toFixed(2)}`,
        ),
      );
    }
  }

  // --- Step 3: build ONE synthetic anomaly using the real fetched data ---
  const anomalyTimestamp = Date.now();
  const candidateNews: NewsArticleIngested[] = allNews
    .filter((n) => n.timestamp <= anomalyTimestamp)
    .slice(0, 10);

  console.log(
    `\n[candidates] ${candidateNews.length}/${allNews.length} news article(s) pass the causality filter ` +
      `(timestamp <= anomaly) and are handed to Claude as citable candidates:`,
  );
  candidateNews.forEach((n) =>
    console.log(`  - [${n.event_id}] [${n.scope}] "${n.headline}"`),
  );
  sentimentSnapshots.forEach((s) =>
    console.log(`  - [${s.event_id}] [${s.scope}] Reddit sentiment snapshot`),
  );

  // Synthetic but internally consistent placeholder values - NOT price=0,
  // which real-world testing showed Claude (correctly) interpreting as a
  // "price crashed to zero" data/exchange glitch and citing THAT as the
  // likely cause. A generic mean=100 placeholder turned out to have the
  // SAME problem once real news with real prices entered the picture:
  // testing BTC-USD produced a synthetic anomaly price of $105, which
  // Claude (correctly, but unhelpfully for this test) flagged as
  // inconsistent with the ~$64,000 BTC price mentioned in the real news
  // it had just read - concluding "data glitch" again instead of
  // attempting a real explanation. Fixed by using a rough, real-ballpark
  // baseline price per ticker, so the synthetic anomaly is at least
  // plausible alongside genuine news/sentiment content.
  const ROUGH_PRICE_ESTIMATES: Record<string, number> = {
    BTC: 64000,
    ETH: 1800,
    SOL: 77,
    XRP: 1.1,
    DOT: 4,
    ADA: 0.4,
    AVAX: 18,
    LINK: 13,
    DOGE: 0.15,
    MATIC: 0.35,
    ARB: 0.09, // verified live (CoinMarketCap/Coinbase, 2026-07-11) - not a guess
  };
  const baseSymbol = ticker.split("-")[0].toUpperCase();
  const syntheticRollingMean = ROUGH_PRICE_ESTIMATES[baseSymbol] ?? 50; // generic fallback for an unlisted ticker
  const syntheticRollingMad = syntheticRollingMean * 0.01; // ~1% of price, a plausible-looking deviation scale
  const syntheticPriceZ = 5.0; // deliberately in the "medium" tier band, well
  const syntheticVolumeZ = 4.0; // below the retry-loop threshold - see file header

  const anomaly: PriceAnomalyDetected = {
    type: "PriceAnomalyDetected",
    event_id: uuidv4(),
    ticker,
    timestamp: anomalyTimestamp,
    price: syntheticRollingMean + syntheticPriceZ * syntheticRollingMad,
    price_direction: "up", // wiring, not a real price feed
    price_z_score: syntheticPriceZ,
    volume_z_score: syntheticVolumeZ,
    rolling_mean: syntheticRollingMean,
    rolling_mad: syntheticRollingMad,
    recent_price_context: [],
  };

  // --- Step 4: exactly ONE Claude call, no retry loop ---
  console.log("\n[claude] making the ONE explanation call...");
  const explanation = await generateExplanation({
    anomaly,
    recentTicks: [],
    candidateNews,
    sentimentSnapshots,
  });
  console.log(`[claude] claim: "${explanation.claim}"`);
  console.log(`[claude] human_summary: ${explanation.human_summary}`);
  console.log(
    `[claude] cited_event_ids: [${explanation.cited_event_ids.join(", ")}]`,
  );
  console.log(`[claude] self-reported confidence: ${explanation.confidence}`);

  // Resolve each cited id back to what it actually is, so you can eyeball
  // whether Claude cited something sensible without cross-referencing ids
  // by hand against the candidate list printed above.
  if (explanation.cited_event_ids.length > 0) {
    console.log("[claude] resolved citations:");
    for (const id of explanation.cited_event_ids) {
      const article = candidateNews.find((n) => n.event_id === id);
      const sentiment = sentimentSnapshots.find((s) => s.event_id === id);
      if (article) {
        console.log(
          `    [${id}] news (${article.scope}): "${article.headline}"`,
        );
      } else if (sentiment) {
        console.log(
          `    [${id}] sentiment (${sentiment.scope}): score=${sentiment.sentiment_score.toFixed(2)}`,
        );
      } else {
        console.log(
          `    [${id}] *** DOES NOT MATCH ANY CANDIDATE - would fail grounding ***`,
        );
      }
    }
  }

  // --- Step 5: structural grounding check (free, no external call) ---
  const store = new EventStore();
  candidateNews.forEach((n) => store.append(n));
  sentimentSnapshots.forEach((s) => store.append(s));
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
  // Matches the grounding-svc fix (DECISIONS.md ADR-015): an honest
  // no_clear_cause has nothing to score confidence on - running it
  // through computeConfidence would produce a misleading nonzero number
  // from "unknown/neutral" defaults, for an explanation that explicitly
  // says there IS no explanation.
  if (explanation.claim === "no_clear_cause") {
    console.log(
      "\n[confidence] skipped - no_clear_cause has no causal claim to score confidence on",
    );
  } else {
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
        sentimentSnapshots.length,
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
  }
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
