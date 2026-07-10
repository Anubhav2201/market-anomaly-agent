/**
 * fanout-svc: receives AlertReady events via a Pub/Sub PUSH subscription
 * on the "alerts" topic - the single, already-detected anomaly for a
 * ticker (detected once, at the most sensitive threshold across all
 * subscribers). For each alert, looks up every subscriber for that
 * ticker and filters: does THIS subscriber's own (possibly less
 * sensitive) threshold actually get crossed by this specific anomaly's
 * z-scores? Only subscribers whose own bar is met receive the alert.
 *
 * DELIVERY IS STUBBED: this logs who WOULD receive the alert rather
 * than actually sending email/push/SMS - wiring a real delivery channel
 * (e.g. SendGrid, FCM) is a clean next step that plugs in right here
 * without touching anything upstream.
 *
 * Also enforces PER-SUBSCRIBER debounce (separate from detector-svc's
 * ticker-level debounce) - a subscriber with a longer debounce window
 * than the most-sensitive one shouldn't get spammed just because a more
 * sensitive subscriber's threshold allows frequent triggers.
 */
import express from "express";
import { SubscriptionsStore } from "../../../src/subscriptions/subscriptionsStore";
import { AlertReady } from "../../../src/events/types";
import { parsePushMessage } from "../../../shared/pubsub";

const subscriptionsStore = new SubscriptionsStore();

// Per-subscriber last-delivered timestamp, in memory. NOTE: resets on
// cold start/redeploy, same acceptable tradeoff as grounding-svc's
// news-volume tracker - worth persisting to Firestore in a later pass
// if under-delivery on redeploy becomes a real problem at higher volume.
const lastDeliveredAt: Map<string, number> = new Map();

const app = express();
app.use(express.json());

let processedCount = 0;
let deliveredCount = 0;

app.post("/pubsub/push", async (req, res) => {
  let alert: AlertReady;
  try {
    alert = parsePushMessage(req.body) as AlertReady;
  } catch (err) {
    console.error("[fanout-svc] failed to parse push message:", err);
    res.status(200).send();
    return;
  }

  try {
    processedCount++;

    if (!alert.structurally_grounded) {
      console.log(
        `[fanout-svc] skipping fan-out for ungrounded alert on ${alert.ticker}`
      );
      res.status(200).send();
      return;
    }

    const subscribers = await subscriptionsStore.getForTicker(alert.ticker);
    if (subscribers.length === 0) {
      console.log(`[fanout-svc] no subscribers for ${alert.ticker}, nothing to fan out`);
      res.status(200).send();
      return;
    }

    const recipients: string[] = [];
    for (const sub of subscribers) {
      const meetsThreshold =
        alert.price_z_score >= sub.price_z_threshold &&
        alert.volume_z_score >= sub.volume_z_threshold;
      if (!meetsThreshold) continue;

      const last = lastDeliveredAt.get(sub.subscription_id) ?? 0;
      if (alert.timestamp - last < sub.debounce_ms) continue;

      lastDeliveredAt.set(sub.subscription_id, alert.timestamp);
      recipients.push(sub.user_id);
    }

    if (recipients.length > 0) {
      deliveredCount += recipients.length;
      // STUB: replace with real delivery (email/push/SMS) here.
      console.log(
        `[fanout-svc] DELIVER to ${recipients.length} subscriber(s) for ${alert.ticker}: ` +
          `"${alert.human_summary}" (confidence=${alert.composite_confidence.toFixed(2)}) -> users: ${recipients.join(", ")}`
      );
    } else {
      console.log(
        `[fanout-svc] alert on ${alert.ticker} didn't meet any subscriber's own threshold or debounce`
      );
    }

    res.status(200).send();
  } catch (err) {
    console.error("[fanout-svc] processing error:", err);
    res.status(500).send();
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", processedCount, deliveredCount });
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`[fanout-svc] listening on :${port}`);
});
