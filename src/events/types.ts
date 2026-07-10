/**
 * Core event types for the market anomaly agent.
 *
 * Design principle: every piece of context the agent can use (price ticks,
 * news) AND every claim the agent makes are typed events with a stable id
 * and timestamp. This is what turns "grounding" from an LLM judgment call
 * into a deterministic lookup: does the cited event_id exist, and does its
 * timestamp precede the thing it's supposedly explaining.
 */

export type EventId = string;

export interface BaseEvent {
  event_id: EventId;
  ticker: string;
  timestamp: number; // unix ms
}

/** Raw price tick ingested from an exchange websocket (Binance/Coinbase). */
export interface PriceTick extends BaseEvent {
  type: "PriceTick";
  price: number;
  volume: number;
}

/** Emitted by the anomaly detector when a tick crosses the adaptive threshold. */
export interface PriceAnomalyDetected extends BaseEvent {
  type: "PriceAnomalyDetected";
  price_z_score: number;
  volume_z_score: number;
  price: number;
  price_direction: "up" | "down";
  rolling_mean: number;
  rolling_mad: number;
  /**
   * A small embedded window of recent prices leading up to this anomaly.
   * This is deliberately embedded here rather than requiring downstream
   * services to query raw PriceTick history from the durable store -
   * ticks are high-volume, low-audit-value data that detector-svc holds
   * in its own in-memory rolling state, not something worth persisting
   * per-tick to Firestore. This small snapshot is enough context for
   * the agent without paying that cost.
   */
  recent_price_context: { timestamp: number; price: number }[];
}

/** A news article ingested from a free news source (e.g. cryptocurrency.cv). */
export interface NewsArticleIngested extends BaseEvent {
  type: "NewsArticleIngested";
  headline: string;
  summary: string;
  source: string;
  url: string;
  /**
   * Tagged at ingestion time (not per-anomaly), so the classification
   * cost is paid once per article, not once per anomaly it might later
   * be considered for:
   *   - ticker_specific: mentions/is about THIS ticker specifically
   *   - market_wide: broader market/macro news (Fed, SEC, "crypto market")
   *     that could plausibly explain moves across many tickers at once
   *   - unrelated: mentions the ticker only in passing, not substantively
   * Candidate pool per anomaly = ticker_specific(that ticker) + all
   * market_wide articles; unrelated articles are filtered out entirely.
   */
  scope: "ticker_specific" | "market_wide" | "unrelated";
}

/**
 * The agent's output. Note: NOT free text. A claim type plus a list of
 * event_ids it is grounded in. This is the structured-output half of the
 * grounding design - verification becomes "do these ids exist and resolve
 * correctly", not "read this paragraph and guess."
 */
export interface ExplanationGenerated extends BaseEvent {
  type: "ExplanationGenerated";
  anomaly_event_id: EventId; // which PriceAnomalyDetected this explains
  claim: string; // short machine-readable factor label, e.g. "regulatory_news"
  human_summary: string; // the plain-english sentence shown to users
  cited_event_ids: EventId[]; // must be NewsArticleIngested / PriceTick ids
  confidence: number; // 0-1, model's own estimate
  /**
   * Total candidate news articles that were FETCHED for this anomaly
   * (not just the ones cited) - passed through explicitly so the
   * news-volume-spike signal downstream can use the real fetch count
   * rather than approximating from citation count, which would
   * conflate "how much news exists" with "how much the model chose to
   * cite" - two different signals.
   */
  candidate_news_count: number;
}

/** Result of running the deterministic + narrow-semantic grounding check. */
export interface GroundingVerified extends BaseEvent {
  type: "GroundingVerified";
  explanation_event_id: EventId;
  structurally_grounded: boolean; // do all cited ids exist + precede the anomaly
  semantically_grounded: boolean | null; // narrow relevance check, null if skipped
  failure_reason?: string;
}

export type DomainEvent =
  | PriceTick
  | PriceAnomalyDetected
  | NewsArticleIngested
  | ExplanationGenerated
  | GroundingVerified;
