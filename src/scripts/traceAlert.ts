/**
 * Traces a single AlertReady back through its ENTIRE causal chain -
 * the concrete demonstration of what an event-sourced architecture
 * actually buys you: not just "we log things," but "any decision this
 * system ever made can be fully reconstructed and audited after the
 * fact," because every event carries the id of the event(s) that led
 * to it (anomaly_event_id, explanation_event_id, cited_event_ids).
 *
 * This works precisely BECAUSE of how FirestoreEventStore is designed
 * (see firestoreStore.ts): one flat "events" collection, one document
 * per event, keyed by event_id. Every getById() call here is an O(1)
 * document read regardless of how large the event log grows - tracing
 * a chain of N events costs exactly N reads, not a full-collection
 * scan, whether the store holds a thousand events or ten million.
 * That's the actual scalability property worth naming: lookups don't
 * degrade as history accumulates.
 *
 * Usage:
 *   npx tsx src/scripts/traceAlert.ts <alert_event_id>
 *   npx tsx src/scripts/traceAlert.ts --ticker BTC-USD   (traces the
 *     most recent alert for that ticker instead of a known id)
 */
import "dotenv/config";
import { FirestoreEventStore } from "../events/firestoreStore";
import {
  AlertReady,
  ExplanationGenerated,
  PriceAnomalyDetected,
  NewsArticleIngested,
  SentimentSnapshotIngested,
} from "../events/types";

function line(label: string, value: string | number) {
  console.log(`  ${label.padEnd(22)} ${value}`);
}

async function main() {
  const store = new FirestoreEventStore();
  const arg = process.argv[2];
  const tickerFlag = process.argv[3];

  let alert: AlertReady | undefined;

  if (arg === "--ticker" && tickerFlag) {
    const alerts = await store.ofType("AlertReady", 50);
    alert = alerts.find((a) => a.ticker === tickerFlag);
    if (!alert) {
      console.error(`No AlertReady found for ticker ${tickerFlag}`);
      process.exit(1);
    }
  } else if (arg) {
    const event = await store.getById(arg);
    if (!event || event.type !== "AlertReady") {
      console.error(`${arg} is not an AlertReady event_id (or doesn't exist)`);
      process.exit(1);
    }
    alert = event;
  } else {
    console.error("Usage: traceAlert.ts <alert_event_id>  OR  traceAlert.ts --ticker BTC-USD");
    process.exit(1);
  }

  console.log("\n=== ALERT ===");
  line("event_id", alert.event_id);
  line("ticker", alert.ticker);
  line("stage", alert.stage);
  line("claim", alert.claim);
  line("structurally_grounded", String(alert.structurally_grounded));
  line("composite_confidence", alert.composite_confidence);
  line("price_z_score", alert.price_z_score);
  line("volume_z_score", alert.volume_z_score);
  console.log(`  human_summary: ${alert.human_summary}`);

  const anomaly = (await store.getById(alert.anomaly_event_id)) as
    | PriceAnomalyDetected
    | undefined;
  console.log("\n=== CAUSED BY: anomaly ===");
  if (anomaly) {
    line("event_id", anomaly.event_id);
    line("timestamp", new Date(anomaly.timestamp).toISOString());
    line("price", anomaly.price);
    line("price_z_score", anomaly.price_z_score.toFixed(2));
    line("volume_z_score", anomaly.volume_z_score.toFixed(2));
  } else {
    console.log("  (anomaly event not found - possibly expired or store was reset)");
  }

  if (!alert.explanation_event_id) {
    console.log("\n(no explanation - small-tier skip or claude_disabled)");
    return;
  }

  const explanation = (await store.getById(alert.explanation_event_id)) as
    | ExplanationGenerated
    | undefined;
  console.log("\n=== EXPLAINED BY ===");
  if (!explanation) {
    console.log("  (explanation event not found)");
    return;
  }
  line("event_id", explanation.event_id);
  line("claim", explanation.claim);
  line("confidence (self-reported)", explanation.confidence);
  line("candidate_news_count", explanation.candidate_news_count);
  console.log(`  human_summary: ${explanation.human_summary}`);

  if (explanation.cited_event_ids.length === 0) {
    console.log("\n(no citations - honest no_clear_cause / claude_disabled)");
    return;
  }

  console.log(`\n=== CITING ${explanation.cited_event_ids.length} EVENT(S) ===`);
  for (const id of explanation.cited_event_ids) {
    const event = await store.getById(id);
    if (!event) {
      console.log(`  [${id}] *** NOT FOUND - would fail grounding verification ***`);
      continue;
    }
    if (event.type === "NewsArticleIngested") {
      const n = event as NewsArticleIngested;
      console.log(`  [${n.event_id}] NEWS (${n.scope})`);
      console.log(`      "${n.headline}" - ${n.source}`);
      console.log(`      ${new Date(n.timestamp).toISOString()}`);
    } else if (event.type === "SentimentSnapshotIngested") {
      const s = event as SentimentSnapshotIngested;
      console.log(`  [${s.event_id}] SENTIMENT (${s.scope})`);
      console.log(`      score=${s.sentiment_score.toFixed(2)}, trend=${s.trend}, buzz=${s.buzz_score}/100`);
    } else {
      console.log(`  [${id}] unexpected event type: ${event.type}`);
    }
  }
  console.log("");
}

main().catch((err) => {
  console.error("Trace failed:", err);
  process.exit(1);
});
