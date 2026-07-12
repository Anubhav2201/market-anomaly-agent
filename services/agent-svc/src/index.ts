/**
 * agent-svc: receives PriceAnomalyDetected events via a Pub/Sub PUSH
 * subscription on the "anomalies" topic. For each one:
 *   1. fetches candidate news (filtered to before the anomaly - causality
 *      enforced here, before the model even sees anything)
 *   2. calls the real Claude API with a forced tool call to generate a
 *      structured, event-cited ExplanationGenerated
 *   3. persists the explanation to Firestore
 *   4. publishes it to the "explanations" topic for grounding-svc
 *
 * Stateless between requests - unlike detector-svc, this can safely
 * scale to multiple instances (no in-memory baseline to worry about),
 * since each anomaly is handled independently.
 */
import express from "express";
import { NewsCache } from "../../../src/news/newsCache";
import { generateExplanation } from "../../../src/agent/explanationAgent";
import { ExplanationCache } from "../../../src/agent/explanationCache";
import { FirestoreEventStore } from "../../../src/events/firestoreStore";
import { AsyncGroundingVerifier } from "../../../src/agent/groundingVerifierAsync";
import {
  classifyAnomalyTier,
  selectModelForTier,
} from "../../../src/detector/anomalyTiering";
import { AnomalyCooldownTracker } from "../../../src/detector/anomalyCooldown";
import { SentimentIngestion } from "../../../src/sentiment/sentimentIngestion";
import {
  PriceAnomalyDetected,
  NewsArticleIngested,
  ExplanationGenerated,
  AlertReady,
} from "../../../src/events/types";
import { publishEvent, parsePushMessage } from "../../../shared/pubsub";
import { v4 as uuidv4 } from "uuid";

const EXPLANATIONS_TOPIC = "explanations";
const ALERTS_TOPIC = "alerts";

const store = new FirestoreEventStore();
const groundingVerifier = new AsyncGroundingVerifier(store);
const sentimentIngestion = new SentimentIngestion(store);
const newsCache = new NewsCache(store);
const explanationCache = new ExplanationCache(store);
const cooldownTracker = new AnomalyCooldownTracker();
const app = express();
app.use(express.json());

let processedCount = 0;
let skippedSmallCount = 0;
let skippedCooldownCount = 0;
let reusedExplanationCount = 0;
let retriedCount = 0;

/**
 * Publish a "not attempted" alert directly for small-tier anomalies,
 * bypassing the explanation agent and grounding-svc entirely. This is the
 * cost-control half of the tiering design: a low subscriber sensitivity
 * threshold no longer means an explosion of Claude API calls for
 * statistical noise, and we're not asking a model to invent a cause for
 * a move that's too small to reliably have one.
 */
async function publishSkippedAlert(
  anomaly: PriceAnomalyDetected,
): Promise<void> {
  const alert: AlertReady = {
    type: "AlertReady",
    event_id: uuidv4(),
    ticker: anomaly.ticker,
    timestamp: Date.now(),
    anomaly_event_id: anomaly.event_id,
    explanation_event_id: "", // none generated - explanation agent was never called
    claim: "not_attempted_small_magnitude",
    human_summary: `${anomaly.ticker} moved (price_z=${anomaly.price_z_score.toFixed(
      2,
    )}, volume_z=${anomaly.volume_z_score.toFixed(
      2,
    )}). Magnitude is below the explanation threshold, so no cause was investigated.`,
    structurally_grounded: false,
    composite_confidence: 0,
    price_z_score: anomaly.price_z_score,
    volume_z_score: anomaly.volume_z_score,
  };
  await store.append(alert);
  await publishEvent(ALERTS_TOPIC, alert);
}

/**
 * Bounded Plan -> Act -> Observe -> Decide loop for "large" tier
 * anomalies. On each attempt: generate an explanation (Act), run the
 * structural grounding check against durable storage (Observe), and
 * either accept it, retry with the rejection reasons fed back to the
 * model as feedback (Decide -> retry), or fall back to an honest
 * no_clear_cause once the retry budget is exhausted (Decide -> give up).
 *
 * "medium" tier anomalies pass through with maxRetries=0, which collapses
 * this to exactly one attempt and no structural retry - identical to the
 * pre-tiering one-shot behavior.
 */
async function explainWithRetries(
  anomaly: PriceAnomalyDetected,
  candidateNews: NewsArticleIngested[],
  sentimentSnapshots: Awaited<
    ReturnType<typeof sentimentIngestion.getSnapshot>
  >[],
  maxRetries: number,
  model: string,
): Promise<{
  explanation: ExplanationGenerated;
  attempts: number;
  rejections: string[][];
}> {
  const priorRejections: string[][] = [];
  const totalAttempts = maxRetries + 1;
  // NOTE: sentimentSnapshots is now fetched ONCE by the caller and passed
  // in, not re-fetched on every retry attempt - it doesn't change between
  // attempts (only the rejection feedback does), so re-fetching it per
  // attempt was pure waste (extra Firestore reads for identical data).
  const resolvedSentiment = sentimentSnapshots.filter(
    (s): s is NonNullable<typeof s> => s !== null,
  );

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    const explanation = await generateExplanation(
      {
        anomaly,
        recentTicks: anomaly.recent_price_context.map((p) => ({
          type: "PriceTick" as const,
          event_id: `embedded-${p.timestamp}`,
          ticker: anomaly.ticker,
          timestamp: p.timestamp,
          price: p.price,
          volume: 0,
        })),
        candidateNews,
        sentimentSnapshots: resolvedSentiment,
        priorRejections,
      },
      model,
    );

    // An honest "no explanation found" is always accepted immediately -
    // nothing to retry against. Still persisted for the audit trail, same
    // as every other explanation.
    if (
      explanation.claim === "no_clear_cause" ||
      explanation.cited_event_ids.length === 0
    ) {
      await store.append(explanation);
      return { explanation, attempts: attempt, rejections: priorRejections };
    }

    // Persist BEFORE verifying, so the structural check (and grounding-svc
    // downstream) can resolve anomaly_event_id / cited_event_ids against
    // durable storage regardless of which attempt this is.
    await store.append(explanation);

    if (attempt === totalAttempts) {
      // Out of retry budget - accept whatever this last attempt produced.
      // grounding-svc will still run its own structural + confidence
      // pipeline downstream; if this attempt happens to fail structural
      // verification too, it'll surface as a rejected alert there rather
      // than looping forever here.
      return { explanation, attempts: attempt, rejections: priorRejections };
    }

    const verdict = await groundingVerifier.verifyStructural(explanation);
    if (verdict.structurally_grounded) {
      return { explanation, attempts: attempt, rejections: priorRejections };
    }

    // Decide -> retry: feed the specific rejection reason back to the
    // model for the next attempt.
    priorRejections.push([
      verdict.failure_reason ?? "structural grounding check failed",
    ]);
    retriedCount++;
    console.log(
      `[agent-svc] attempt ${attempt} REJECTED for ${anomaly.ticker}: ${verdict.failure_reason} - retrying`,
    );
  }

  // Unreachable given the loop bounds above, but keeps TypeScript satisfied.
  throw new Error("explainWithRetries: exhausted loop without returning");
}

app.post("/pubsub/push", async (req, res) => {
  let anomaly: PriceAnomalyDetected;
  try {
    anomaly = parsePushMessage(req.body) as PriceAnomalyDetected;
  } catch (err) {
    console.error("[agent-svc] failed to parse push message:", err);
    res.status(200).send(); // ack - malformed message will never parse on retry
    return;
  }

  try {
    console.log(
      `[agent-svc] processing anomaly: ${anomaly.ticker} priceZ=${anomaly.price_z_score.toFixed(2)}`,
    );

    const { tier, maxRetries } = classifyAnomalyTier(
      anomaly.price_z_score,
      anomaly.volume_z_score,
    );
    // Medium tier -> Haiku 4.5 (cheap, sufficient for a bounded citation
    // task); large tier -> the more capable model, since that's where
    // the retry loop's fabrication-risk stakes are highest. See
    // selectModelForTier() in anomalyTiering.ts for the full reasoning.
    const model = selectModelForTier(tier);

    if (tier === "small") {
      // Skip the explanation agent entirely - cheap statistical noise
      // isn't worth an LLM call, and forcing an explanation for it risks
      // a false-positive causal link the grounding checks would then
      // have to catch anyway. Small tier is already cheap enough that
      // cooldown suppression isn't worth applying here too - see below
      // for where cooldown actually matters (medium/large).
      await publishSkippedAlert(anomaly);
      skippedSmallCount++;
      console.log(
        `[agent-svc] SKIPPED (tier=small): ${anomaly.ticker} - stat reported, no LLM call`,
      );
      res.status(200).send();
      return;
    }

    // Cooldown check - the highest-impact cost lever in this pipeline.
    // A sustained price move doesn't fire the detector once; EWMA/MAD
    // can stay past threshold across many consecutive ticks, and
    // without this check EACH of those ticks would independently fetch
    // news, fetch sentiment, and call Claude for what is, causally, ONE
    // event. Tier escalation still breaks through - see
    // anomalyCooldown.ts for the full reasoning.
    const shouldProcess = await cooldownTracker.shouldProcess(
      anomaly.ticker,
      tier,
    );
    if (!shouldProcess) {
      skippedCooldownCount++;
      console.log(
        `[agent-svc] SKIPPED (cooldown): ${anomaly.ticker} tier=${tier} - recently processed at this tier or higher`,
      );
      res.status(200).send();
      return;
    }

    const allNews = await newsCache.getRecentNews(anomaly.ticker, 10);
    const candidateNews: NewsArticleIngested[] = allNews.filter(
      (n) => n.timestamp <= anomaly.timestamp,
    );
    // NOTE: no manual persistence loop here anymore - NewsCache already
    // persists every fetched article (and dedups by URL) internally,
    // so re-appending here would just be redundant Firestore writes.
    // See src/news/newsCache.ts.

    // Fetch sentiment ONCE here (not per-retry-attempt, see
    // explainWithRetries) - also lets us check below whether there's
    // ANYTHING at all to reason about before paying for a Claude call.
    const sentimentSnapshots = await Promise.all([
      sentimentIngestion.getSnapshot(anomaly.ticker),
      sentimentIngestion.getMarketSnapshot(),
    ]);
    const resolvedSentiment = sentimentSnapshots.filter(
      (s): s is NonNullable<typeof s> => s !== null,
    );

    if (candidateNews.length === 0 && resolvedSentiment.length === 0) {
      // Deterministic skip: with ZERO candidate news and ZERO sentiment
      // data, the only valid outcome Claude could produce is an honest
      // no_clear_cause with empty citations - there is nothing else it
      // could validly cite. Synthesizing that directly costs nothing
      // and produces the identical result a real Claude call would
      // have, every time. This is exactly the DOT-USD test case from
      // earlier live testing - a quiet ticker with no news and no
      // sentiment always ends here anyway; skipping saves the call.
      const explanation: ExplanationGenerated = {
        type: "ExplanationGenerated",
        event_id: uuidv4(),
        ticker: anomaly.ticker,
        timestamp: Date.now(),
        anomaly_event_id: anomaly.event_id,
        claim: "no_clear_cause",
        human_summary: `${anomaly.ticker} moved (price_z=${anomaly.price_z_score.toFixed(
          2,
        )}, volume_z=${anomaly.volume_z_score.toFixed(
          2,
        )}) but no news articles or sentiment data were available to explain it.`,
        cited_event_ids: [],
        confidence: 0,
        candidate_news_count: 0,
      };
      await store.append(explanation);
      await publishEvent(EXPLANATIONS_TOPIC, explanation);
      await cooldownTracker.recordProcessed(anomaly.ticker, tier);
      processedCount++;
      console.log(
        `[agent-svc] SKIPPED (no candidates): ${anomaly.ticker} tier=${tier} - deterministic no_clear_cause, no Claude call made`,
      );
      res.status(200).send();
      return;
    }

    const candidateIds = [
      ...candidateNews.map((n) => n.event_id),
      ...resolvedSentiment.map((s) => s.event_id),
    ];

    // Explanation reuse: if a different anomaly (e.g. after a cooldown
    // window lapsed) was recently explained from this EXACT same set
    // of candidate news/sentiment, reuse that reasoning instead of
    // paying for another Claude call - see explanationCache.ts for why
    // this is narrower than (and complements, not replaces) the
    // cooldown tracker.
    const reused = await explanationCache.lookup(anomaly, tier, candidateIds);
    if (reused) {
      await store.append(reused);
      await publishEvent(EXPLANATIONS_TOPIC, reused);
      await cooldownTracker.recordProcessed(anomaly.ticker, tier);
      reusedExplanationCount++;
      processedCount++;
      console.log(
        `[agent-svc] REUSED (explanation cache): ${anomaly.ticker} tier=${tier} - identical candidate set, no Claude call made`,
      );
      res.status(200).send();
      return;
    }

    const { explanation, attempts, rejections } = await explainWithRetries(
      anomaly,
      candidateNews,
      sentimentSnapshots,
      maxRetries,
      model,
    );

    // Cache this reasoning against its candidate-set fingerprint for
    // potential reuse by a future anomaly with the identical set -
    // only worth caching non-trivial outcomes (an explanation that
    // actually cited something), since a fresh no_clear_cause is
    // already free to produce again via the zero-candidate skip above
    // if the candidate set is later genuinely empty.
    if (explanation.cited_event_ids.length > 0) {
      await explanationCache.store(
        anomaly.ticker,
        anomaly.price_direction,
        tier,
        candidateIds,
        explanation,
      );
    }

    await publishEvent(EXPLANATIONS_TOPIC, explanation);
    await cooldownTracker.recordProcessed(anomaly.ticker, tier);

    processedCount++;
    console.log(
      `[agent-svc] explanation generated (tier=${tier}, model=${model}, attempts=${attempts}/${maxRetries + 1}): ` +
        `claim="${explanation.claim}" cited=${explanation.cited_event_ids.length}` +
        (rejections.length > 0
          ? ` [self-corrected after ${rejections.length} rejection(s)]`
          : ""),
    );
    res.status(200).send();
  } catch (err) {
    console.error("[agent-svc] processing error:", err);
    // Nack so Pub/Sub retries - likely a transient Claude API or
    // Firestore issue, not a malformed message.
    res.status(500).send();
  }
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    processedCount,
    skippedSmallCount,
    skippedCooldownCount,
    reusedExplanationCount,
    retriedCount,
  });
});

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    "[agent-svc] ANTHROPIC_API_KEY is not set - explanations will fail.",
  );
}

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`[agent-svc] listening on :${port}`);
});
