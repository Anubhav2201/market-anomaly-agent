import { NewsArticleIngested } from "../events/types";

/**
 * Checks whether a candidate article's sentiment direction is coherent
 * with the observed price direction. This is intentionally NOT an LLM
 * call - it's a cheap lexicon-based classification, because this check
 * needs to run over every candidate article, and a simple keyword
 * signal is enough to catch a real class of bad citations (positive
 * news cited to explain a price drop, or vice versa) without spending a
 * model call on each one.
 *
 * NOTE: cryptocurrency.cv's API reportedly supports a sentiment filter/
 * field natively (bullish/bearish/neutral) per its docs - if that field
 * is present on the raw article response, prefer it over this lexicon
 * fallback. This module exists as a robust fallback when it isn't.
 */

const BEARISH_TERMS = [
  "crash",
  "plunge",
  "drop",
  "sell-off",
  "selloff",
  "hack",
  "exploit",
  "ban",
  "lawsuit",
  "investigation",
  "delist",
  "outage",
  "regulatory crackdown",
  "fraud",
  "collapse",
  "liquidation",
  "warning",
  "restrict",
];

const BULLISH_TERMS = [
  "surge",
  "rally",
  "approve",
  "approval",
  "adoption",
  "partnership",
  "upgrade",
  "breakthrough",
  "record high",
  "all-time high",
  "institutional interest",
  "etf inflow",
  "buy",
  "bullish",
  "gains",
];

export type SentimentLabel = "bullish" | "bearish" | "neutral";
export type PriceDirection = "up" | "down";

function classifySentiment(text: string): SentimentLabel {
  const lower = text.toLowerCase();
  const bearishHits = BEARISH_TERMS.filter((t) => lower.includes(t)).length;
  const bullishHits = BULLISH_TERMS.filter((t) => lower.includes(t)).length;

  if (bearishHits === 0 && bullishHits === 0) return "neutral";
  return bearishHits > bullishHits ? "bearish" : "bullish";
}

export interface SentimentCoherenceResult {
  sentiment: SentimentLabel;
  priceDirection: PriceDirection;
  isCoherent: boolean; // false only on a genuine directional contradiction
}

/**
 * priceDirection should be derived from the anomaly (price above vs
 * below the rolling mean at trigger time), passed in by the caller.
 */
export function checkSentimentCoherence(
  article: NewsArticleIngested,
  priceDirection: PriceDirection
): SentimentCoherenceResult {
  const sentiment = classifySentiment(
    `${article.headline} ${article.summary}`
  );

  // Neutral sentiment can't contradict anything - only a clear opposite
  // signal counts as incoherent. This avoids over-penalizing legitimate
  // but blandly-worded news.
  const isCoherent =
    sentiment === "neutral" ||
    (sentiment === "bearish" && priceDirection === "down") ||
    (sentiment === "bullish" && priceDirection === "up");

  return { sentiment, priceDirection, isCoherent };
}
