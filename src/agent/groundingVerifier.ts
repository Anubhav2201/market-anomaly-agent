import { EventStore } from "../events/store";
import { ExplanationGenerated, GroundingVerified } from "../events/types";
import { v4 as uuidv4 } from "uuid";

/**
 * Verifies an agent's ExplanationGenerated event WITHOUT an LLM call for
 * the structural half. This is the core cost/reliability win of the
 * event-sourced grounding design:
 *
 *  1. Existence check: does every cited_event_id actually exist in the
 *     store? (pure lookup, O(1) per id, free)
 *  2. Causality check: does every cited event's timestamp precede the
 *     anomaly it's supposedly explaining? (catches the agent citing news
 *     that came out AFTER the price move - a real bug class, not just
 *     "hallucination")
 *  3. Semantic check (optional, narrow): does the cited event's content
 *     actually relate to the claimed factor? This is the one piece that
 *     still benefits from a model call, but note it's now scoped to
 *     "does THIS snippet support THIS specific claim" - a much smaller,
 *     cheaper, more reliable prompt than "read this whole explanation and
 *     judge it holistically."
 */
export class GroundingVerifier {
  constructor(private store: EventStore) {}

  verifyStructural(explanation: ExplanationGenerated): GroundingVerified {
    const anomaly = this.store.getById(explanation.anomaly_event_id);

    if (!anomaly) {
      return this.fail(
        explanation,
        "anomaly_event_id does not exist in store"
      );
    }

    if (explanation.cited_event_ids.length === 0) {
      return this.fail(explanation, "no cited events - unsupported claim");
    }

    for (const citedId of explanation.cited_event_ids) {
      const cited = this.store.getById(citedId);
      if (!cited) {
        return this.fail(
          explanation,
          `cited event_id ${citedId} does not exist in store`
        );
      }
      if (cited.timestamp > anomaly.timestamp) {
        return this.fail(
          explanation,
          `cited event ${citedId} (t=${cited.timestamp}) occurs AFTER the anomaly it explains (t=${anomaly.timestamp}) - causality violation`
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
      semantically_grounded: null, // not yet checked - see verifySemantic
    };
  }

  private fail(
    explanation: ExplanationGenerated,
    reason: string
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

  /**
   * Narrow semantic check: given the explanation's claim and the cited
   * events' content, does the content actually support the claim?
   *
   * This is a placeholder for the real implementation, which would call a
   * cheap/free model (e.g. Groq Llama or Gemini Flash) with ONLY the
   * claim + the cited snippets - not the full explanation, not the full
   * article. Keeping the check's input surface small is what keeps it
   * cheap and reliable relative to "judge this whole paragraph."
   */
  async verifySemantic(
    explanation: ExplanationGenerated,
    checkFn: (claim: string, citedContent: string[]) => Promise<boolean>
  ): Promise<boolean> {
    const citedContent = explanation.cited_event_ids
      .map((id) => this.store.getById(id))
      .filter((e): e is NonNullable<typeof e> => !!e)
      .map((e) => {
        if (e.type === "NewsArticleIngested") {
          return `${e.headline}: ${e.summary}`;
        }
        if (e.type === "PriceTick") {
          return `price=${e.price} volume=${e.volume} at ${e.timestamp}`;
        }
        return "";
      });

    return checkFn(explanation.claim, citedContent);
  }
}
