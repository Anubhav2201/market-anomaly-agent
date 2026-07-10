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
import { fetchRecentNews } from "../../../src/news/newsIngestion";
import { generateExplanation } from "../../../src/agent/explanationAgent";
import { FirestoreEventStore } from "../../../src/events/firestoreStore";
import { SentimentIngestion } from "../../../src/sentiment/sentimentIngestion";
import {
  PriceAnomalyDetected,
  NewsArticleIngested,
} from "../../../src/events/types";
import { publishEvent, parsePushMessage } from "../../../shared/pubsub";

const EXPLANATIONS_TOPIC = "explanations";

const store = new FirestoreEventStore();
const sentimentIngestion = new SentimentIngestion(store);
const app = express();
app.use(express.json());

let processedCount = 0;

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
      `[agent-svc] processing anomaly: ${anomaly.ticker} priceZ=${anomaly.price_z_score.toFixed(2)}`
    );

    const allNews = await fetchRecentNews(anomaly.ticker, 10);
    const candidateNews: NewsArticleIngested[] = allNews.filter(
      (n) => n.timestamp <= anomaly.timestamp
    );
    // Persist candidate news to Firestore so grounding-svc can look up
    // cited event_ids later - the whole point of the grounding check is
    // that citations resolve against DURABLE storage, not this
    // request's local memory.
    for (const n of candidateNews) {
      await store.append(n);
    }

    const explanation = await generateExplanation({
      anomaly,
      recentTicks: anomaly.recent_price_context.map((p) => ({
        type: "PriceTick" as const,
        event_id: `embedded-${p.timestamp}`, // not a real stored event - context only
        ticker: anomaly.ticker,
        timestamp: p.timestamp,
        price: p.price,
        volume: 0, // not tracked in the embedded context snapshot
      })),
      candidateNews,
      sentimentSnapshot: await sentimentIngestion.getSnapshot(anomaly.ticker),
    });

    await store.append(explanation);
    await publishEvent(EXPLANATIONS_TOPIC, explanation);

    processedCount++;
    console.log(
      `[agent-svc] explanation generated: claim="${explanation.claim}" cited=${explanation.cited_event_ids.length}`
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
  res.json({ status: "ok", processedCount });
});

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("[agent-svc] ANTHROPIC_API_KEY is not set - explanations will fail.");
}

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`[agent-svc] listening on :${port}`);
});
