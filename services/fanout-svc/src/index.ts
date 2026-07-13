/**
 * fanout-svc: receives AlertReady events via a Pub/Sub PUSH subscription
 * on the "alerts" topic - the single, already-detected anomaly for a
 * ticker (detected once, at the most sensitive threshold across all
 * subscribers). For each alert, looks up every subscriber for that
 * ticker and filters: does THIS subscriber's own (possibly less
 * sensitive) threshold actually get crossed by this specific anomaly's
 * z-scores? Only subscribers whose own bar is met receive the alert.
 *
 * TWO-STAGE FAN-OUT: an anomaly now produces up to two AlertReady events
 * sharing the same anomaly_event_id - "investigating" (published by
 * agent-svc the instant an anomaly is tiered, before any news/sentiment
 * fetch or Claude call) and "final" (published once the real
 * explanation + grounding complete). This service delivers BOTH as
 * separate notifications to a matching subscriber: a fast "we're
 * looking into it" the moment the anomaly is detected, followed by the
 * real explanation once it's ready - so subscribers see something
 * immediately instead of waiting out however long the retry loop takes
 * for a large-tier anomaly (can be 10+ seconds).
 *
 * REAL EMAIL DELIVERY: sends via src/delivery/emailDelivery.ts (SMTP,
 * defaults to Gmail App Password - zero new signup, see that file for
 * the full reasoning and its explicit scale limitation). Degrades to
 * logging if SMTP isn't configured, same graceful-degradation pattern
 * as every other optional external dependency in this project.
 *
 * Also enforces PER-SUBSCRIBER debounce (separate from detector-svc's
 * ticker-level debounce) - a subscriber with a longer debounce window
 * than the most-sensitive one shouldn't get spammed just because a more
 * sensitive subscriber's threshold allows frequent triggers. Debounce
 * is keyed by TIME, but a "final" alert that's a follow-up to an
 * "investigating" alert for the SAME anomaly always bypasses it - the
 * debounce is meant to space out genuinely different anomalies, not
 * suppress the natural two-stage delivery of one.
 */
import express from "express";
import { SubscriptionsStore } from "../../../src/subscriptions/subscriptionsStore";
import { EmailDelivery } from "../../../src/delivery/emailDelivery";
import { AlertReady } from "../../../src/events/types";
import { parsePushMessage } from "../../../shared/pubsub";

const subscriptionsStore = new SubscriptionsStore();
const emailDelivery = new EmailDelivery();

interface DeliveryRecord {
  timestamp: number;
  anomalyEventId: string;
}

// Per-subscriber last-delivered record, in memory. NOTE: resets on
// cold start/redeploy, same acceptable tradeoff as grounding-svc's
// news-volume tracker - worth persisting to Firestore in a later pass
// if under-delivery on redeploy becomes a real problem at higher volume.
const lastDelivered: Map<string, DeliveryRecord> = new Map();

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

    // The structural-grounding gate only makes sense for "final" alerts -
    // an "investigating" alert is ALWAYS structurally_grounded: false by
    // construction (nothing has been grounded yet, there's no
    // explanation to ground), and that's expected, not a reason to skip
    // fan-out for it.
    if (alert.stage === "final" && !alert.structurally_grounded) {
      console.log(
        `[fanout-svc] skipping fan-out for ungrounded final alert on ${alert.ticker}`
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

    const recipients: { email: string; subscriptionId: string }[] = [];
    for (const sub of subscribers) {
      const meetsThreshold =
        alert.price_z_score >= sub.price_z_threshold &&
        alert.volume_z_score >= sub.volume_z_threshold;
      if (!meetsThreshold) continue;

      const last = lastDelivered.get(sub.subscription_id);
      const isFollowUpForSameAnomaly = last?.anomalyEventId === alert.anomaly_event_id;

      // Debounce applies only when this is a genuinely different anomaly
      // from the last one delivered to this subscriber - a "final" alert
      // following up on an "investigating" alert for the SAME anomaly
      // always gets through, regardless of how little time has passed.
      if (!isFollowUpForSameAnomaly && last && alert.timestamp - last.timestamp < sub.debounce_ms) {
        continue;
      }

      lastDelivered.set(sub.subscription_id, {
        timestamp: alert.timestamp,
        anomalyEventId: alert.anomaly_event_id,
      });
      recipients.push({ email: sub.email, subscriptionId: sub.subscription_id });
    }

    if (recipients.length > 0) {
      const stageLabel = alert.stage === "investigating" ? "INVESTIGATING" : "FINAL";
      const subject = `[${stageLabel}] ${alert.ticker} anomaly - ${alert.claim}`;
      const body =
        `${alert.human_summary}\n\n` +
        `Ticker: ${alert.ticker}\n` +
        `Stage: ${alert.stage}\n` +
        `Claim: ${alert.claim}\n` +
        `Confidence: ${alert.composite_confidence.toFixed(2)}\n` +
        `price_z_score: ${alert.price_z_score.toFixed(2)}\n` +
        `volume_z_score: ${alert.volume_z_score.toFixed(2)}\n`;

      // Send concurrently, not sequentially - independent deliveries,
      // one slow/failed send shouldn't hold up the others.
      const results = await Promise.all(
        recipients.map((r) => emailDelivery.send(r.email, subject, body))
      );
      const actuallySent = results.filter(Boolean).length;
      deliveredCount += actuallySent;

      if (actuallySent > 0) {
        console.log(
          `[fanout-svc] EMAILED (${stageLabel}) ${actuallySent}/${recipients.length} subscriber(s) for ${alert.ticker}: "${alert.human_summary}"`
        );
      }
      if (actuallySent < recipients.length) {
        // Some (or all, if SMTP is unconfigured) didn't actually send -
        // log what WOULD have gone out, same visibility the old stub
        // gave, so this is never silently invisible either way.
        console.log(
          `[fanout-svc] (${recipients.length - actuallySent} not delivered - SMTP unconfigured or send failed) ` +
            `would-be recipients: ${recipients.map((r) => r.email).join(", ")}`
        );
      }
    } else {
      console.log(
        `[fanout-svc] alert (${alert.stage}) on ${alert.ticker} didn't meet any subscriber's own threshold or debounce`
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
