import Anthropic from "@anthropic-ai/sdk";
import { v4 as uuidv4 } from "uuid";
import {
  PriceAnomalyDetected,
  NewsArticleIngested,
  PriceTick,
  ExplanationGenerated,
  SentimentSnapshotIngested,
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

const EXPLAIN_TOOL: Anthropic.Tool = {
  name: "submit_explanation",
  description:
    "Submit a structured explanation for why a price anomaly occurred, citing ONLY the event_ids of candidate NEWS ARTICLES or the SENTIMENT SNAPSHOT actually provided to you. Price context has no event_id and cannot be cited. Never invent an event_id.",
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
  // This schema is byte-identical across EVERY call this pipeline ever
  // makes, regardless of ticker or anomaly - caching it benefits not
  // just the retry loop but every single Claude call, not only
  // large-tier anomalies. Cache reads run ~90% cheaper than fresh
  // input (see DECISIONS.md pricing notes).
  cache_control: { type: "ephemeral" },
};

interface CandidateContext {
  anomaly: PriceAnomalyDetected;
  recentTicks: PriceTick[]; // small window of price history for context
  candidateNews: NewsArticleIngested[]; // must be BEFORE anomaly.timestamp
  /**
   * Sentiment candidates - can include a ticker_specific snapshot (this
   * ticker's own Reddit buzz) and/or a market_wide snapshot (aggregate
   * crypto-wide mood, see ADR-014 in DECISIONS.md), same scope concept
   * as candidateNews. Both are optional and independently cached.
   */
  sentimentSnapshots?: SentimentSnapshotIngested[];
  /**
   * Feedback from previously REJECTED attempts on this same anomaly (used
   * by the bounded retry loop in agent-svc for "large" tier anomalies).
   * Each entry is the list of rejection reasons from one failed attempt,
   * in order. Empty/undefined on the first attempt. This is what makes
   * the loop Observe -> Decide -> retry rather than a blind resend of the
   * same prompt.
   */
  priorRejections?: string[][];
}

function buildFeedbackSection(priorRejections?: string[][]): string {
  if (!priorRejections || priorRejections.length === 0) return "";
  const attempts = priorRejections
    .map(
      (reasons, i) =>
        `Attempt ${i + 1} was REJECTED for:\n` +
        reasons.map((r) => `  - ${r}`).join("\n"),
    )
    .join("\n");
  return `\nIMPORTANT - this anomaly has already been attempted and rejected ${priorRejections.length} time(s):
${attempts}

Do not repeat the same mistake. If you cannot produce a citation that avoids
these specific problems, respond honestly with claim "no_clear_cause" and an
empty cited_event_ids array rather than repeating a rejected citation.
`;
}

/**
 * The stable part of the prompt - anomaly details, price context, news,
 * sentiment. Identical across every retry attempt for a given anomaly
 * (only the feedback/instructions suffix below changes between
 * attempts), so this is the part marked cache_control in
 * generateExplanation(). Split out specifically to enable prompt
 * caching for the retry loop - see DECISIONS.md for the cost reasoning.
 */
function buildStableContext(ctx: CandidateContext): string {
  const { anomaly, recentTicks, candidateNews, sentimentSnapshots } = ctx;

  const tickSummary = recentTicks
    .slice(-10)
    .map((t) => `  t=${t.timestamp} price=${t.price}`) // no event_id shown - not citable, see note below
    .join("\n");

  const newsSummary =
    candidateNews.length > 0
      ? candidateNews
          .map(
            (n) =>
              `  [${n.event_id}] t=${n.timestamp} scope=${n.scope} "${n.headline}" (${n.source}): ${n.summary}`,
          )
          .join("\n")
      : "  (no candidate news articles available)";

  const sentimentList = sentimentSnapshots ?? [];
  const sentimentSummary =
    sentimentList.length > 0
      ? sentimentList
          .map((s) => {
            const base =
              `  [${s.event_id}] scope=${s.scope} Reddit crypto sentiment (cached hourly): ` +
              `buzz_score=${s.buzz_score}/100, sentiment_score=${s.sentiment_score.toFixed(2)} ` +
              `(-1 bearish to +1 bullish), trend=${s.trend}, mentions=${s.mention_count}`;
            if (
              s.scope === "market_wide" &&
              s.drivers &&
              s.drivers.length > 0
            ) {
              const drivers = s.drivers
                .slice(0, 5)
                .map(
                  (d) =>
                    `${d.symbol} (mentions=${d.mentions}, sentiment=${d.sentiment_score.toFixed(2)})`,
                )
                .join(", ");
              return `${base}\n      top symbols driving overall crypto sentiment: ${drivers}`;
            }
            return base;
          })
          .join("\n")
      : "  (no sentiment data available)";

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
citable. Each is tagged with a scope: ticker_specific means it's
specifically about ${anomaly.ticker}; market_wide means it's broader
market/macro news that could plausibly affect many assets at once
(prefer a ticker_specific citation when one genuinely fits, since it's a
more direct explanation):
${newsSummary}

Reddit crypto sentiment snapshots (also citable if actually relevant to
explaining this specific anomaly). Same scope concept as news:
ticker_specific is this ticker's own Reddit buzz; market_wide is the
aggregate crypto-wide mood across the whole market, not specific to
${anomaly.ticker} - if you cite a market_wide sentiment snapshot, frame
your reasoning as a broad/systemic mood shift affecting the whole
market, not as something specific to ${anomaly.ticker}:
${sentimentSummary}`;
}

/**
 * The variable part of the prompt - retry feedback (empty on the first
 * attempt) plus the closing instructions. NOT cached, since the
 * feedback section differs on every retry attempt - only this
 * (typically short) suffix gets sent as fresh, uncached input on a
 * retry, while the much larger stable context above is served from
 * cache.
 */
function buildVariableSuffix(priorRejections?: string[][]): string {
  return `${buildFeedbackSection(priorRejections)}
Using ONLY the event_ids from the candidate news articles or the
sentiment snapshots listed above (never invent an id, never cite the
price context above - it has no id), explain why this anomaly likely
occurred.
If nothing actually explains it, say so honestly with claim
"no_clear_cause" and an empty cited_event_ids array - do not fabricate a connection.
Call the submit_explanation tool with your answer.`;
}

export async function generateExplanation(
  ctx: CandidateContext,
  model = "claude-sonnet-5",
): Promise<ExplanationGenerated> {
  const stableContext = buildStableContext(ctx);
  const variableSuffix = buildVariableSuffix(ctx.priorRejections);

  const message = await client.messages.create({
    model,
    max_tokens: 1024,
    tools: [EXPLAIN_TOOL],
    tool_choice: { type: "tool", name: "submit_explanation" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: stableContext,
            // Cache breakpoint: this block (anomaly + price context +
            // news + sentiment) is byte-identical across every retry
            // attempt for this anomaly - only the block below changes.
            // A "large" tier anomaly can make up to 4 calls through the
            // retry loop; from the 2nd attempt onward, this block is
            // served from cache at ~10% of fresh input cost.
            cache_control: { type: "ephemeral" },
          },
          {
            type: "text",
            text: variableSuffix,
          },
        ],
      },
    ],
  });

  const toolUse = message.content.find(
    (block: { type: string }): block is Anthropic.ToolUseBlock =>
      block.type === "tool_use",
  );

  if (!toolUse) {
    throw new Error(
      "Claude did not return a tool_use block - unexpected given tool_choice was forced",
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
