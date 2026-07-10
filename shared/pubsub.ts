import { PubSub } from "@google-cloud/pubsub";
import { DomainEvent } from "../src/events/types";

/**
 * Thin shared wrapper around Pub/Sub, used by every microservice so
 * publish/subscribe conventions stay consistent across the whole
 * pipeline (topic naming, JSON encoding, ack handling).
 *
 * Topic map (create these once per GCP project, e.g. via
 * `gcloud pubsub topics create price-ticks anomalies explanations`):
 *   price-ticks   - ingestion-svc -> detector-svc
 *   anomalies     - detector-svc -> agent-svc
 *   explanations  - agent-svc -> grounding-svc
 *
 * Cloud Run services receive Pub/Sub messages via PUSH subscriptions
 * (an HTTP endpoint Pub/Sub calls), not by polling - that's what
 * `parsePushMessage` below is for.
 */

const pubsub = new PubSub();

export async function publishEvent(
  topicName: string,
  event: DomainEvent
): Promise<string> {
  const dataBuffer = Buffer.from(JSON.stringify(event));
  return pubsub.topic(topicName).publishMessage({ data: dataBuffer });
}

/**
 * Parses the body of an incoming Pub/Sub PUSH request (Cloud Run HTTP
 * handler receives this as req.body). Pub/Sub wraps the actual message
 * in a base64-encoded envelope - this unwraps it back into the typed
 * DomainEvent.
 */
export function parsePushMessage(body: {
  message: { data: string; messageId: string };
}): DomainEvent {
  const json = Buffer.from(body.message.data, "base64").toString("utf-8");
  return JSON.parse(json) as DomainEvent;
}
