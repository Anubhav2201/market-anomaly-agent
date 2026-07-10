import { DomainEvent, EventId } from "./types";

/**
 * Append-only event store. In production this is Pub/Sub (for delivery) +
 * Firestore/Postgres (for the durable log). For this local slice, an
 * in-memory array is enough to prove out the detector + grounding logic
 * before wiring real infra.
 */
export class EventStore {
  private events: DomainEvent[] = [];
  private byId: Map<EventId, DomainEvent> = new Map();

  append(event: DomainEvent): void {
    this.events.push(event);
    this.byId.set(event.event_id, event);
  }

  getById(id: EventId): DomainEvent | undefined {
    return this.byId.get(id);
  }

  all(): DomainEvent[] {
    return this.events;
  }

  ofType<T extends DomainEvent["type"]>(
    type: T
  ): Extract<DomainEvent, { type: T }>[] {
    return this.events.filter((e) => e.type === type) as Extract<
      DomainEvent,
      { type: T }
    >[];
  }

  forTicker(ticker: string): DomainEvent[] {
    return this.events.filter((e) => e.ticker === ticker);
  }
}
