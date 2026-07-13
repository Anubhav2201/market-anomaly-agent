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
import { FeatureFlags } from "../../../src/config/featureFlags";

const ALERTS_TOPIC = "alerts";

const store = new FirestoreEventStore();
const verifier = new AsyncGroundingVerifier(store);
const featureFlags = new FeatureFlags();
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
      `[grounding-svc] verifying explanation for ${explanation.ticker}, claim="${explanation.claim}"`,
    );

    const verdict = await verifier.verifyStructural(explanation);
    await store.append(verdict);

    // An honest "no_clear_cause" now passes structural grounding (see
    // groundingVerifierAsync.ts / DECISIONS.md ADR-015) - correctly, since
    // there's nothing to fabricate when nothing was cited. But it should
    // NOT flow through computeConfidence(): with zero citations, every
    // signal defaults to its "unknown/neutral" credit, producing a
    // nonsensical nonzero "confidence" (~0.1-0.2) for an explanation that
    // explicitly says there IS no explanation. Confidence is a measure of
    // how well-supported a CAUSAL claim is - it doesn't apply to the
    // absence of one. Short-circuit here the same way agent-svc already
    // does for small-tier skips: report the anomaly honestly (per
    // ADR-006), composite_confidence: 0, without running the scoring math.
    //
    // NOTE this check is a SEPARATE, SEQUENTIAL check - NOT nested inside
    // a structural-failure branch. A genuine structural failure (a claim
    // that asserted a cause but cited something fabricated/non-causal)
    // is handled below by computeConfidence()'s own structural gate,
    // which forces the score to 0 automatically - no separate early
    // return is needed for that case.
    if (explanation.claim === "no_clear_cause" || explanation.claim === "claude_disabled") {
      const anomaly = (await store.getById(explanation.anomaly_event_id)) as
        | PriceAnomalyDetected
        | undefined;
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
          structurally_grounded: true,
          composite_confidence: 0,
          price_z_score: anomaly.price_z_score,
          volume_z_score: anomaly.volume_z_score,
          stage: "final" as const,
        };
        await store.append(alert);
        await publishEvent(ALERTS_TOPIC, alert);
        console.log(
          `[grounding-svc] VERIFIED (${explanation.claim}, reported honestly, no confidence scoring): ${explanation.ticker}`,
        );
      } else {
        console.warn(
          `[grounding-svc] anomaly ${explanation.anomaly_event_id} not found - skipping alert fan-out`,
        );
      }
      processedCount++;
      res.status(200).send();
      return;
    }

    // Everything else - whether structurally grounded or not - flows
    // through the full confidence pipeline. If verdict.structurally_grounded
    // is false here (a genuine failure: the explanation asserted a cause
    // but cited something fabricated or non-causal), computeConfidence's
    // own structural gate forces composite_confidence to 0 automatically -
    // see the "structural_gate: 0" breakdown key when that happens.
    const anomaly = (await store.getById(explanation.anomaly_event_id)) as
      | PriceAnomalyDetected
      | undefined;

    const citedArticles: NewsArticleIngested[] = [];
    const citedSentiments: SentimentSnapshotIngested[] = [];
    for (const id of explanation.cited_event_ids) {
      const event = await store.getById(id);
      if (event?.type === "NewsArticleIngested") {
        citedArticles.push(event);
      } else if (event?.type === "SentimentSnapshotIngested") {
        citedSentiments.push(event);
      }
    }

    const sourceCount =
      new Set(citedArticles.map((a) => a.source)).size + citedSentiments.length; // each cited sentiment snapshot counts as its own independent source

    const articleSentimentResults = anomaly
      ? citedArticles.map((a) =>
          checkSentimentCoherence(a, anomaly.price_direction),
        )
      : [];

    // Direct numeric coherence check for each cited sentiment snapshot -
    // more precise than the lexicon-based article check since we have
    // an actual -1..+1 score, not just keyword matching. A snapshot
    // cited alongside a contradictory one (e.g. bullish ticker-specific
    // + bearish market-wide) correctly makes the overall signal
    // incoherent - that disagreement is itself informative, not
    // something to average away.
    const sentimentSnapshotCoherenceResults: boolean[] = [];
    if (anomaly) {
      for (const s of citedSentiments) {
        const isBullish = s.sentiment_score > 0.15;
        const isBearish = s.sentiment_score < -0.15;
        const coherent =
          (!isBullish && !isBearish) || // neutral can't contradict
          (isBullish && anomaly.price_direction === "up") ||
          (isBearish && anomaly.price_direction === "down");
        sentimentSnapshotCoherenceResults.push(coherent);
      }
    }

    const allCoherenceSignals = [
      ...articleSentimentResults.map((r) => r.isCoherent),
      ...sentimentSnapshotCoherenceResults,
    ];
    const sentimentCoherent =
      allCoherenceSignals.length === 0
        ? null
        : allCoherenceSignals.every((c) => c);

    const avgProximity =
      citedArticles.length === 0 || !anomaly
        ? 0
        : citedArticles.reduce(
            (sum, a) =>
              sum + temporalProximityScore(a.timestamp, anomaly.timestamp),
            0,
          ) / citedArticles.length;

    // Scope specificity now spans BOTH citable evidence types (news and
    // sentiment), consistent with the same ticker_specific/market_wide
    // concept applying uniformly across whatever was actually cited -
    // see DECISIONS.md ADR-005 and ADR-014.
    const allCitedScoped = [...citedArticles, ...citedSentiments];
    const tickerSpecificFraction =
      allCitedScoped.length === 0
        ? 0
        : allCitedScoped.filter((e) => e.scope === "ticker_specific").length /
          allCitedScoped.length;

    // News volume signal - uses the REAL count of news fetched by
    // agent-svc at the time (passed through the event), not an
    // approximation from how many the model chose to cite. This keeps
    // "how much news exists" and "how much the model cited" as
    // properly separate signals.
    const volumeResult = newsVolumeTracker.record(
      explanation.ticker,
      explanation.candidate_news_count,
    );

    const semanticCheckContent = [
      ...citedArticles.map((a) => `${a.headline}: ${a.summary}`),
      ...citedSentiments.map(
        (s) =>
          `Reddit sentiment (${s.scope}): score=${s.sentiment_score.toFixed(2)} (-1 bearish to +1 bullish), trend=${s.trend}, buzz=${s.buzz_score}/100`,
      ),
    ];
    // groq_enabled gates this the same way a missing GROQ_API_KEY
    // already does - semanticSupport stays null, which
    // confidenceScorer.ts already treats as "unknown, neutral credit,"
    // not a failure. This is the cheapest of the four gated calls
    // (Groq's own free tier), but still worth being able to pause.
    const groqEnabled = await featureFlags.isEnabled("groq_enabled");
    const semanticSupport =
      groqEnabled && semanticCheckContent.length > 0
        ? await verifyClaimSupportedByContent(
            explanation.claim,
            semanticCheckContent,
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

    console.log(
      `[grounding-svc] VERIFIED: claim="${explanation.claim}" composite_confidence=${confidence.score.toFixed(2)}`,
      confidence.breakdown,
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
        stage: "final" as const,
      };
      await store.append(alert);
      await publishEvent(ALERTS_TOPIC, alert);
    } else {
      console.warn(
        `[grounding-svc] anomaly ${explanation.anomaly_event_id} not found - skipping alert fan-out`,
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
