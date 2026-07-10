/**
 * grounding-svc: receives ExplanationGenerated events via a Pub/Sub PUSH
 * subscription on the "explanations" topic. For each one:
 *   1. runs structural grounding verification (real id? causally prior?)
 *      against durable Firestore storage
 *   2. gathers the independently-computed confidence signals (news
 *      volume spike, sentiment coherence, source diversity, temporal
 *      proximity, narrow semantic check)
 *   3. computes the composite confidence score
 *   4. persists the final GroundingVerified verdict to Firestore
 *
 * This is the end of the pipeline - the durable event log in Firestore
 * at this point contains the full auditable trail: anomaly -> candidate
 * news -> explanation -> verdict, all cross-referenced by event_id.
 */
import express from "express";
import { v4 as uuidv4 } from "uuid";
import { FirestoreEventStore } from "../../../src/events/firestoreStore";
import { AsyncGroundingVerifier } from "../../../src/agent/groundingVerifierAsync";
import { NewsVolumeTracker } from "../../../src/signals/newsVolumeTracker";
import { checkSentimentCoherence } from "../../../src/signals/sentimentCoherence";
import { verifyClaimSupportedByContent } from "../../../src/signals/semanticVerifier";
import {
  computeConfidence,
  temporalProximityScore,
} from "../../../src/signals/confidenceScorer";
import {
  ExplanationGenerated,
  NewsArticleIngested,
  PriceAnomalyDetected,
  SentimentSnapshotIngested,
} from "../../../src/events/types";
import { publishEvent, parsePushMessage } from "../../../shared/pubsub";

const ALERTS_TOPIC = "alerts";

const store = new FirestoreEventStore();
const verifier = new AsyncGroundingVerifier(store);
// NOTE: news volume baseline resets on cold start/redeploy since it's
// in-memory - acceptable for now (it re-warms after a few anomalies),
// but worth persisting to Firestore in a later pass if this matters.
const newsVolumeTracker = new NewsVolumeTracker();

const app = express();
app.use(express.json());

let processedCount = 0;

app.post("/pubsub/push", async (req, res) => {
  let explanation: ExplanationGenerated;
  try {
    explanation = parsePushMessage(req.body) as ExplanationGenerated;
  } catch (err) {
    console.error("[grounding-svc] failed to parse push message:", err);
    res.status(200).send();
    return;
  }

  try {
    console.log(
      `[grounding-svc] verifying explanation for ${explanation.ticker}, claim="${explanation.claim}"`
    );

    const verdict = await verifier.verifyStructural(explanation);
    await store.append(verdict);

    if (!verdict.structurally_grounded) {
      console.log(
        `[grounding-svc] REJECTED: ${verdict.failure_reason}`
      );
      processedCount++;
      res.status(200).send();
      return;
    }

    // Structural check passed - now gather the confidence signals.
    const anomaly = (await store.getById(
      explanation.anomaly_event_id
    )) as PriceAnomalyDetected | undefined;

    const citedArticles: NewsArticleIngested[] = [];
    let citedSentiment: SentimentSnapshotIngested | null = null;
    for (const id of explanation.cited_event_ids) {
      const event = await store.getById(id);
      if (event?.type === "NewsArticleIngested") {
        citedArticles.push(event);
      } else if (event?.type === "SentimentSnapshotIngested") {
        citedSentiment = event;
      }
    }

    const sourceCount =
      new Set(citedArticles.map((a) => a.source)).size +
      (citedSentiment ? 1 : 0); // sentiment counts as its own independent source

    const articleSentimentResults = anomaly
      ? citedArticles.map((a) => checkSentimentCoherence(a, anomaly.price_direction))
      : [];

    // Direct numeric coherence check for a cited sentiment snapshot -
    // more precise than the lexicon-based article check since we have
    // an actual -1..+1 score, not just keyword matching.
    let sentimentSnapshotCoherent: boolean | null = null;
    if (citedSentiment && anomaly) {
      const isBullish = citedSentiment.sentiment_score > 0.15;
      const isBearish = citedSentiment.sentiment_score < -0.15;
      sentimentSnapshotCoherent =
        (!isBullish && !isBearish) || // neutral can't contradict
        (isBullish && anomaly.price_direction === "up") ||
        (isBearish && anomaly.price_direction === "down");
    }

    const allCoherenceSignals = [
      ...articleSentimentResults.map((r) => r.isCoherent),
      ...(sentimentSnapshotCoherent !== null ? [sentimentSnapshotCoherent] : []),
    ];
    const sentimentCoherent =
      allCoherenceSignals.length === 0
        ? null
        : allCoherenceSignals.every((c) => c);

    const avgProximity =
      citedArticles.length === 0 || !anomaly
        ? 0
        : citedArticles.reduce(
            (sum, a) => sum + temporalProximityScore(a.timestamp, anomaly.timestamp),
            0
          ) / citedArticles.length;

    const tickerSpecificFraction =
      citedArticles.length === 0
        ? 0
        : citedArticles.filter((a) => a.scope === "ticker_specific").length /
          citedArticles.length;

    // News volume signal - uses the REAL count of news fetched by
    // agent-svc at the time (passed through the event), not an
    // approximation from how many the model chose to cite. This keeps
    // "how much news exists" and "how much the model cited" as
    // properly separate signals.
    const volumeResult = newsVolumeTracker.record(
      explanation.ticker,
      explanation.candidate_news_count
    );

    const semanticCheckContent = [
      ...citedArticles.map((a) => `${a.headline}: ${a.summary}`),
      ...(citedSentiment
        ? [
            `Reddit sentiment: score=${citedSentiment.sentiment_score.toFixed(2)} (-1 bearish to +1 bullish), trend=${citedSentiment.trend}, buzz=${citedSentiment.buzz_score}/100`,
          ]
        : []),
    ];
    const semanticSupport =
      semanticCheckContent.length > 0
        ? await verifyClaimSupportedByContent(explanation.claim, semanticCheckContent)
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

    console.log(
      `[grounding-svc] VERIFIED: claim="${explanation.claim}" composite_confidence=${confidence.score.toFixed(2)}`,
      confidence.breakdown
    );

    if (anomaly) {
      const alert = {
        type: "AlertReady" as const,
        event_id: uuidv4(),
        ticker: explanation.ticker,
        timestamp: Date.now(),
        anomaly_event_id: explanation.anomaly_event_id,
        explanation_event_id: explanation.event_id,
        claim: explanation.claim,
        human_summary: explanation.human_summary,
        structurally_grounded: verdict.structurally_grounded,
        composite_confidence: confidence.score,
        price_z_score: anomaly.price_z_score,
        volume_z_score: anomaly.volume_z_score,
      };
      await store.append(alert);
      await publishEvent(ALERTS_TOPIC, alert);
    } else {
      console.warn(
        `[grounding-svc] anomaly ${explanation.anomaly_event_id} not found - skipping alert fan-out`
      );
    }

    processedCount++;
    res.status(200).send();
  } catch (err) {
    console.error("[grounding-svc] processing error:", err);
    res.status(500).send(); // nack - retry on transient failure
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", processedCount });
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`[grounding-svc] listening on :${port}`);
});
