/**
 * Classifies a news article's scope relative to a specific ticker, at
 * ingestion time (paid once per article, not once per anomaly it might
 * later be a candidate for).
 *
 * Deliberately a cheap lexicon/heuristic classifier, not an LLM call -
 * this runs on every ingested article, so it needs to be free and fast.
 * If this proves too coarse in practice, it's a natural place to swap in
 * the free-tier semantic model later without changing anything
 * downstream (the scope field's meaning stays the same either way).
 */

const MARKET_WIDE_TERMS = [
  "federal reserve",
  "fed rate",
  "interest rate",
  "sec ",
  "sec.gov",
  "regulator",
  "regulation",
  "crypto market",
  "market-wide",
  "market wide",
  "bitcoin dominance",
  "macro",
  "inflation",
  "cpi report",
  "recession",
  "risk-off",
  "risk off",
  "stock market",
  "s&p 500",
  "nasdaq",
  "treasury yield",
  "geopolitical",
];

export type NewsScope = "ticker_specific" | "market_wide" | "unrelated";

/**
 * tickerBaseSymbol should be the base asset symbol, e.g. "BTC" (from
 * "BTC-USD") - matched against headline/summary text, case-insensitive.
 */
export function classifyNewsScope(
  headline: string,
  summary: string,
  tickerBaseSymbol: string
): NewsScope {
  const text = `${headline} ${summary}`.toLowerCase();
  const symbol = tickerBaseSymbol.toLowerCase();

  // Common full names for the major symbols, so "Bitcoin" matches "BTC"
  // and "Ethereum" matches "ETH" etc. - extend this map as you add tickers.
  const fullNameMap: Record<string, string[]> = {
    btc: ["bitcoin"],
    eth: ["ethereum", "ether"],
    sol: ["solana"],
  };
  const aliases = [symbol, ...(fullNameMap[symbol] ?? [])];

  const mentionsTicker = aliases.some((alias) => text.includes(alias));
  const mentionsMarketWide = MARKET_WIDE_TERMS.some((term) =>
    text.includes(term)
  );

  if (mentionsTicker) return "ticker_specific";
  if (mentionsMarketWide) return "market_wide";
  return "unrelated";
}
