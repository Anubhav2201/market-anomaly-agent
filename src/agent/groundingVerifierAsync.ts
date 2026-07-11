import {
  ExplanationGenerated,
  GroundingVerified,
  DomainEvent,
  EventId,
} from "../events/types";
import { v4 as uuidv4 } from "uuid";

/**
 * Same verification logic as groundingVerifier.ts, adapted for an async
 * store (Firestore) instead of the synchronous in-memory EventStore used
 * in the local dev slices. Duck-typed against just the one method it
 * needs, so it works with FirestoreEventStore without a hard import
 * dependency in either direction.
 */
interface AsyncEventLookup {
  getById(id: EventId): Promise<DomainEvent | undefined>;
}

export class AsyncGroundingVerifier {
  constructor(private store: AsyncEventLookup) {}

  async verifyStructural(
    explanation: ExplanationGenerated,
  ): Promise<GroundingVerified> {
    const anomaly = await this.store.getById(explanation.anomaly_event_id);

    if (!anomaly) {
      return this.fail(explanation, "anomaly_event_id does not exist in store");
    }

    if (explanation.cited_event_ids.length === 0) {
      // Same fix as groundingVerifier.ts (sync version) - see the comment
      // there and DECISIONS.md ADR-015. An honest no_clear_cause is
      // vacuously grounded, not a structural failure.
      if (explanation.claim === "no_clear_cause") {
        return {
          type: "GroundingVerified",
          event_id: uuidv4(),
          ticker: explanation.ticker,
          timestamp: Date.now(),
          explanation_event_id: explanation.event_id,
          structurally_grounded: true,
          semantically_grounded: null,
        };
      }
      return this.fail(explanation, "no cited events - unsupported claim");
    }

    for (const citedId of explanation.cited_event_ids) {
      const cited = await this.store.getById(citedId);
      if (!cited) {
        return this.fail(
          explanation,
          `cited event_id ${citedId} does not exist in store`,
        );
      }
      if (cited.timestamp > anomaly.timestamp) {
        return this.fail(
          explanation,
          `cited event ${citedId} (t=${cited.timestamp}) occurs AFTER the anomaly it explains (t=${anomaly.timestamp}) - causality violation`,
        );
      }
    }

    return {
      type: "GroundingVerified",
      event_id: uuidv4(),
      ticker: explanation.ticker,
      timestamp: Date.now(),
      explanation_event_id: explanation.event_id,
      structurally_grounded: true,
      semantically_grounded: null,
    };
  }

  private fail(
    explanation: ExplanationGenerated,
    reason: string,
  ): GroundingVerified {
    return {
      type: "GroundingVerified",
      event_id: uuidv4(),
      ticker: explanation.ticker,
      timestamp: Date.now(),
      explanation_event_id: explanation.event_id,
      structurally_grounded: false,
      semantically_grounded: null,
      failure_reason: reason,
    };
  }
}
