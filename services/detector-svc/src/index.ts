/**
 * detector-svc: receives PriceTick events via a Pub/Sub PUSH subscription
 * (Cloud Run HTTP endpoint), runs them through the same AnomalyDetector
 * from the original vertical slices, and on a detected anomaly:
 *   1. persists the PriceAnomalyDetected event to Firestore (durable,
 *      queryable audit trail)
 *   2. publishes it to the "anomalies" topic for agent-svc to pick up
 *
 * IMPORTANT STATEFULNESS NOTE: the AnomalyDetector holds rolling
 * baseline state (mean/MAD per ticker) IN MEMORY. Cloud Run can scale
 * this service to multiple instances, and Pub/Sub push doesn't
 * guarantee the same instance sees every tick for a given ticker. For
 * correctness, deploy this with max-instances=1 for now (single
 * instance, simple, correct) - properly sharding baseline state by
 * ticker across instances (e.g. consistent hashing so all BTC ticks
 * always land on the same instance) is a real scaling improvement to
 * make later, not something to solve prematurely.
 */
import express from "express";
import { AnomalyDetector } from "../../../src/detector/anomalyDetector";
import { FirestoreEventStore } from "../../../src/events/firestoreStore";
import { SubscriptionsStore } from "../../../src/subscriptions/subscriptionsStore";
import { PriceTick } from "../../../src/events/types";
import { publishEvent, parsePushMessage } from "../../../shared/pubsub";

const ANOMALIES_TOPIC = "anomalies";

const detector = new AnomalyDetector({
  priceZThreshold: 3.0,
  volumeZThreshold: 2.0,
  debounceMs: 5 * 60 * 1000,
  warmupTicks: 30,
});
const store = new FirestoreEventStore();
const subscriptionsStore = new SubscriptionsStore();

// Tickers we know about (seen at least one tick) - used to know which
// tickers to pull threshold overrides for, without guessing in advance.
const knownTickers = new Set<string>();

/**
 * Detect once per ticker at the MOST SENSITIVE threshold across all
 * subscribers - this is what lets one detector instance serve every
 * subscriber's sensitivity preference without running a detector per
 * subscriber. Refreshed on a timer (SubscriptionsStore caches this
 * internally too) rather than queried per tick, to stay well within
 * Firestore's free tier.
 */
async function refreshThresholds() {
  for (const ticker of knownTickers) {
    try {
      const thresholds = await subscriptionsStore.getMinThresholdsForTicker(ticker);
      detector.setTickerThresholds(ticker, {
        priceZThreshold: thresholds.price_z_threshold,
        volumeZThreshold: thresholds.volume_z_threshold,
        debounceMs: thresholds.debounce_ms,
        warmupTicks: 30,
      });
    } catch (err) {
      console.error(`[detector-svc] failed to refresh thresholds for ${ticker}:`, err);
    }
  }
}
setInterval(refreshThresholds, 60 * 1000); // check every minute (cache inside the store limits actual Firestore reads)

const app = express();
app.use(express.json());

let tickCount = 0;
const startedAt = Date.now();

app.post("/pubsub/push", async (req, res) => {
  let tick: PriceTick;
  try {
    tick = parsePushMessage(req.body) as PriceTick;
  } catch (err) {
    console.error("[detector-svc] failed to parse push message:", err);
    // Ack anyway - a malformed message will never parse successfully on
    // retry, so nacking it just causes an infinite redelivery loop.
    res.status(200).send();
    return;
  }

  tickCount++;
  knownTickers.add(tick.ticker);
  if (tickCount % 100 === 0) {
    const elapsedSec = (Date.now() - startedAt) / 1000;
    console.log(
      `[detector-svc] ${tickCount} ticks processed (${(tickCount / elapsedSec).toFixed(1)}/sec)`
    );
  }

  try {
    const anomaly = detector.process(tick);
    if (anomaly) {
      console.log(
        `[detector-svc] ANOMALY: ${anomaly.ticker} priceZ=${anomaly.price_z_score.toFixed(2)} volumeZ=${anomaly.volume_z_score.toFixed(2)}`
      );
      await store.append(anomaly);
      await publishEvent(ANOMALIES_TOPIC, anomaly);
    }
    res.status(200).send();
  } catch (err) {
    console.error("[detector-svc] processing error:", err);
    // Nack (500) so Pub/Sub retries - this failure is likely transient
    // (Firestore/Pub/Sub hiccup), unlike a parse error above.
    res.status(500).send();
  }
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    ticksProcessed: tickCount,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
  });
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`[detector-svc] listening on :${port}`);
});
