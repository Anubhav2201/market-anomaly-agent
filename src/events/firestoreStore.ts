import { Firestore } from "@google-cloud/firestore";
import { DomainEvent, EventId } from "./types";

/**
 * Persistent, Firestore-backed event store - same conceptual interface
 * as the in-memory EventStore used in earlier vertical slices, but
 * durable and shared across services. This is what makes the
 * microservice split possible: detector-svc, agent-svc, and
 * grounding-svc all read/write the SAME store instead of each holding
 * their own private in-memory copy.
 *
 * IMPORTANT COST NOTE: only persist "decision" events here -
 * PriceAnomalyDetected, NewsArticleIngested, ExplanationGenerated,
 * GroundingVerified. Do NOT call append() for every raw PriceTick -
 * at even modest tick rates that's hundreds of thousands of writes per
 * day for data with near-zero audit value. Raw ticks stay in
 * detector-svc's own in-memory rolling buffer (see
 * AnomalyDetector.recentTicksBuffer), and a small snapshot of relevant
 * price context gets embedded directly into the PriceAnomalyDetected
 * event instead.
 *
 * Collection layout: one Firestore collection "events", one document
 * per event, keyed by event_id. This keeps lookups (the core operation
 * grounding verification needs - "does this event_id exist") O(1) doc
 * reads regardless of collection size, which matters for cost as this
 * grows.
 *
 * Requires GOOGLE_APPLICATION_CREDENTIALS env var pointing at a service
 * account key, or running inside GCP (Cloud Run, etc.) where ambient
 * credentials are automatically available - standard Firestore auth,
 * nothing custom here.
 */
export class FirestoreEventStore {
  private db: Firestore;
  private collectionName: string;

  constructor(collectionName = "events", projectId?: string) {
    this.db = projectId ? new Firestore({ projectId }) : new Firestore();
    this.collectionName = collectionName;
  }

  async append(event: DomainEvent): Promise<void> {
    await this.db
      .collection(this.collectionName)
      .doc(event.event_id)
      .set(event);
  }

  async getById(id: EventId): Promise<DomainEvent | undefined> {
    const doc = await this.db.collection(this.collectionName).doc(id).get();
    return doc.exists ? (doc.data() as DomainEvent) : undefined;
  }

  async ofType<T extends DomainEvent["type"]>(
    type: T,
    limit = 500
  ): Promise<Extract<DomainEvent, { type: T }>[]> {
    const snapshot = await this.db
      .collection(this.collectionName)
      .where("type", "==", type)
      .orderBy("timestamp", "desc")
      .limit(limit)
      .get();
    return snapshot.docs.map(
      (d) => d.data() as Extract<DomainEvent, { type: T }>
    );
  }

  async forTicker(ticker: string, limit = 500): Promise<DomainEvent[]> {
    const snapshot = await this.db
      .collection(this.collectionName)
      .where("ticker", "==", ticker)
      .orderBy("timestamp", "desc")
      .limit(limit)
      .get();
    return snapshot.docs.map((d) => d.data() as DomainEvent);
  }
}
