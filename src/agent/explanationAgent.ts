import Anthropic from "@anthropic-ai/sdk";
import { v4 as uuidv4 } from "uuid";
import {
  PriceAnomalyDetected,
  NewsArticleIngested,
  PriceTick,
  ExplanationGenerated,
} from "../events/types";

/**
 * Calls the real Claude API to generate a structured, event-cited
 * explanation for a detected anomaly.
 *
 * Key design point (this is the whole reason for the event-sourced
 * grounding approach): we do NOT ask Claude for free text. We force a
 * tool call with a fixed schema, and the model MUST cite specific
 * event_ids from the candidate events we hand it - it cannot invent an
 * id, because the grounding verifier will look up whatever id it names
 * against the real event store afterward. The model choosing not to
 * cite anything (empty cited_event_ids) is a valid, honest answer we
 * should accept, not something to prompt-engineer away - an anomaly
 * with no supporting news IS sometimes just noise.
 */

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

const EXPLAIN_TOOL = {
  name: "submit_explanation",
  description:
    "Submit a structured explanation for why a price anomaly occurred, citing ONLY the event_ids of candidate NEWS ARTICLES actually provided to you. Price context has no event_id and cannot be cited. Never invent an event_id.",
  input_schema: {
    type: "object" as const,
    properties: {
      claim: {
        type: "string",
        description:
          "Short machine-readable label for the factor, e.g. 'regulatory_news', 'exchange_outage', 'no_clear_cause'",
      },
      human_summary: {
        type: "string",
        description:
          "One or two plain-English sentences explaining the move, suitable to show a retail user.",
      },
      cited_event_ids: {
        type: "array",
        items: { type: "string" },
        description:
          "event_id values of candidate events that support this explanation. Empty array if no candidate event actually explains the anomaly - do not force a connection that isn't there.",
      },
      confidence: {
        type: "number",
        description: "0-1 confidence that this explanation is correct.",
      },
    },
    required: ["claim", "human_summary", "cited_event_ids", "confidence"],
  },
};

interface CandidateContext {
  anomaly: PriceAnomalyDetected;
  recentTicks: PriceTick[]; // small window of price history for context
  candidateNews: NewsArticleIngested[]; // must be BEFORE anomaly.timestamp
}

function buildPrompt(ctx: CandidateContext): string {
  const { anomaly, recentTicks, candidateNews } = ctx;

  const tickSummary = recentTicks
    .slice(-10)
    .map((t) => `  t=${t.timestamp} price=${t.price}`) // no event_id shown - not citable, see note below
    .join("\n");

  const newsSummary =
    candidateNews.length > 0
      ? candidateNews
          .map(
            (n) =>
              `  [${n.event_id}] t=${n.timestamp} "${n.headline}" (${n.source}): ${n.summary}`
          )
          .join("\n")
      : "  (no candidate news articles available)";

  return `A price anomaly was detected:
  ticker: ${anomaly.ticker}
  price: ${anomaly.price}
  timestamp: ${anomaly.timestamp}
  price_z_score: ${anomaly.price_z_score.toFixed(2)}
  volume_z_score: ${anomaly.volume_z_score.toFixed(2)}

Recent price context leading up to this anomaly (for your understanding
only - these are NOT citable events, they have no event_id):
${tickSummary}

Candidate news articles (all timestamped BEFORE the anomaly) - these ARE
the only events you may cite:
${newsSummary}

Using ONLY the event_ids from the candidate news articles listed above
(never invent an id, never cite the price context above - it has no
id), explain why this anomaly likely occurred.
If no candidate news article actually explains it, say so honestly with claim
"no_clear_cause" and an empty cited_event_ids array - do not fabricate a connection.
Call the submit_explanation tool with your answer.`;
}

export async function generateExplanation(
  ctx: CandidateContext,
  model = "claude-sonnet-4-6"
): Promise<ExplanationGenerated> {
  const message = await client.messages.create({
    model,
    max_tokens: 1024,
    tools: [EXPLAIN_TOOL],
    tool_choice: { type: "tool", name: "submit_explanation" },
    messages: [{ role: "user", content: buildPrompt(ctx) }],
  });

  const toolUse = message.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
  );

  if (!toolUse) {
    throw new Error(
      "Claude did not return a tool_use block - unexpected given tool_choice was forced"
    );
  }

  const input = toolUse.input as {
    claim: string;
    human_summary: string;
    cited_event_ids: string[];
    confidence: number;
  };

  return {
    type: "ExplanationGenerated",
    event_id: uuidv4(),
    ticker: ctx.anomaly.ticker,
    timestamp: Date.now(),
    anomaly_event_id: ctx.anomaly.event_id,
    claim: input.claim,
    human_summary: input.human_summary,
    cited_event_ids: input.cited_event_ids,
    confidence: input.confidence,
    candidate_news_count: ctx.candidateNews.length,
  };
}
