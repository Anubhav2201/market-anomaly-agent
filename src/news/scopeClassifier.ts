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
  tickerBaseSymbol: string,
): NewsScope {
  const text = `${headline} ${summary}`.toLowerCase();
  const symbol = tickerBaseSymbol.toLowerCase();

  // Common full names for the major symbols, so "Bitcoin" matches "BTC"
  // and "Ethereum" matches "ETH" etc. IMPORTANT: this must cover every
  // ticker whose full project/coin name doesn't literally contain the
  // ticker symbol as a whole word - e.g. "Arbitrum" does NOT satisfy a
  // word-boundary match on "arb" (there's no word boundary between
  // "arb" and "itrum"), so an article that only ever says "Arbitrum"
  // and never abbreviates to "ARB" would be wrongly discarded as
  // unrelated without this entry. This was a real bug found live
  // (ARB-USD test, see DECISIONS.md ADR-022) - extend this map
  // whenever a new ticker's coin name doesn't already contain the
  // symbol as a standalone word.
  const fullNameMap: Record<string, string[]> = {
    btc: ["bitcoin"],
    eth: ["ethereum", "ether"],
    sol: ["solana"],
    dot: ["polkadot"],
    ada: ["cardano"],
    avax: ["avalanche"],
    link: ["chainlink"],
    doge: ["dogecoin"],
    matic: ["polygon"],
    arb: ["arbitrum"],
    xrp: ["ripple"],
  };
  const aliases = [symbol, ...(fullNameMap[symbol] ?? [])];

  // Word-boundary matching, not plain substring - a naive .includes()
  // check would let a short symbol like "arb" false-match inside
  // unrelated words ("barbecue", "carburetor"). This matters more now
  // that classifyNewsScope also serves as the corroboration check for
  // Tiingo's own ticker tagging (see ADR-021 in DECISIONS.md).
  const containsWholeWord = (haystack: string, needle: string): boolean => {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "i").test(haystack);
  };

  const mentionsTicker = aliases.some((alias) =>
    containsWholeWord(text, alias),
  );
  const mentionsMarketWide = MARKET_WIDE_TERMS.some((term) =>
    text.includes(term),
  );

  if (mentionsTicker) return "ticker_specific";
  if (mentionsMarketWide) return "market_wide";
  return "unrelated";
}
