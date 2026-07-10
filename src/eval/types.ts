/**
 * Schema for a single eval scenario: a historical (or manually judged
 * live) anomaly with a documented ground-truth cause.
 *
 * The harness replays each scenario through the REAL pipeline (real
 * prompt construction, real Claude call, real grounding verification,
 * real confidence scoring) and scores the output against the answer
 * key. Nothing is mocked except the data sources - the point is to
 * test the system's actual judgment, not a simulation of it.
 */

export interface EvalNewsArticle {
  /** Stable id within the scenario file, e.g. "news-1" - becomes the event_id */
  id: string;
  headline: string;
  summary: string;
  source: string;
  url: string;
  /** Offset in minutes BEFORE the anomaly (positive = earlier). Using
   * relative offsets rather than absolute timestamps keeps scenarios
   * readable and replayable at any wall-clock time. */
  minutes_before_anomaly: number;
  scope: "ticker_specific" | "market_wide";
}

export interface EvalScenario {
  scenario_id: string;
  description: string; // human-readable: what real event this represents
  ticker: string;
  /** The anomaly's characteristics, as the detector would have emitted them */
  anomaly: {
    price: number;
    price_direction: "up" | "down";
    price_z_score: number;
    volume_z_score: number;
  };
  /** News that existed BEFORE the anomaly - the candidate pool the
   * agent gets to work with. May deliberately include irrelevant/
   * distractor articles to test that the agent doesn't force a
   * connection. */
  candidate_news: EvalNewsArticle[];
  /** The answer key */
  ground_truth: {
    /** The claim label(s) considered correct, e.g. ["exchange_collapse",
     * "exchange_insolvency"] - multiple accepted labels because claim
     * naming isn't exact-match-able; the harness checks membership
     * with normalization. "no_clear_cause" is a valid ground truth for
     * scenarios where the distractor news genuinely doesn't explain
     * the move. */
    accepted_claims: string[];
    /** ids (from candidate_news) of the article(s) a correct
     * explanation should cite. Empty if ground truth is no_clear_cause. */
    correct_citation_ids: string[];
    /** Documented source establishing the real cause - for the human
     * maintaining this dataset, not used by the harness */
    documentation: string;
  };
}
