/**
 * Tracks a rolling baseline of "articles mentioning this ticker per fetch
 * window" per ticker, using the same EWMA technique as the price
 * anomaly detector. A spike in news volume, independent of any single
 * headline's content, is real corroborating evidence that something
 * happened - it doesn't depend on the LLM judging any article
 * "plausible."
 */
export interface NewsVolumeResult {
  currentCount: number;
  baselineRate: number;
  isSpike: boolean;
  ratio: number; // currentCount / baselineRate, for logging/debugging
}

class TickerNewsBaseline {
  private meanCount = 1; // seed with a small non-zero floor
  private alpha: number;
  private seen = 0;

  constructor(alpha = 0.2) {
    this.alpha = alpha;
  }

  update(count: number): NewsVolumeResult {
    const baselineRate = this.meanCount;
    const ratio = count / Math.max(baselineRate, 0.5);
    this.seen++;

    // Update EWMA after scoring against the prior baseline.
    this.meanCount = this.alpha * count + (1 - this.alpha) * this.meanCount;

    return {
      currentCount: count,
      baselineRate,
      // Require a few observations before trusting "spike" - otherwise
      // the very first fetch always looks like an infinite-ratio spike.
      isSpike: this.seen > 3 && ratio >= 2.5,
      ratio,
    };
  }
}

export class NewsVolumeTracker {
  private baselines: Map<string, TickerNewsBaseline> = new Map();

  record(ticker: string, articleCount: number): NewsVolumeResult {
    if (!this.baselines.has(ticker)) {
      this.baselines.set(ticker, new TickerNewsBaseline());
    }
    return this.baselines.get(ticker)!.update(articleCount);
  }
}
