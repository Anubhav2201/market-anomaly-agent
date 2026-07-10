import { PriceTick, PriceAnomalyDetected } from "../events/types";
import { v4 as uuidv4 } from "uuid";

/**
 * Per-ticker rolling statistics using an EWMA (exponentially weighted
 * moving average/variance) rather than a fixed-window recompute.
 *
 * Why EWMA over a naive rolling window of raw stddev:
 *  - O(1) update per tick, no need to store/rescan history (Welford-style
 *    incremental update, adapted to be recency-weighted).
 *  - Recent volatility regime matters more than data from hours ago -
 *    crypto genuinely shifts between calm and wild periods, and a static
 *    window either reacts too slowly or gets swamped by stale data.
 *  - We track absolute deviation (MAD-style) rather than squared deviation
 *    (stddev) for the "spread" estimate, because a single huge outlier
 *    inflates variance quadratically, numbing the detector to the very
 *    kind of event it should be catching.
 */
class TickerBaseline {
  private alpha: number; // EWMA smoothing factor
  private meanReturn = 0;
  private meanAbsDev = 0.001; // seed with a small non-zero floor to avoid div-by-zero
  private meanVolume = 0;
  private meanAbsVolDev = 1;
  private lastPrice: number | null = null;
  private initialized = false;

  constructor(alpha = 0.05) {
    this.alpha = alpha;
  }

  /** Returns {priceZ, volumeZ, direction} for the incoming tick, then updates the baseline. */
  update(
    price: number,
    volume: number
  ): { priceZ: number; volumeZ: number; direction: "up" | "down" } {
    if (this.lastPrice === null) {
      this.lastPrice = price;
      this.meanVolume = volume;
      this.initialized = true;
      return { priceZ: 0, volumeZ: 0, direction: "up" };
    }

    const ret = (price - this.lastPrice) / this.lastPrice;

    // Score against CURRENT baseline before updating it (so the anomaly
    // is measured against "normal so far", not including itself).
    const priceDev = Math.abs(ret - this.meanReturn);
    const priceZ = priceDev / Math.max(this.meanAbsDev, 1e-6);
    const direction: "up" | "down" = ret >= 0 ? "up" : "down";

    const volDev = Math.abs(volume - this.meanVolume);
    const volumeZ = volDev / Math.max(this.meanAbsVolDev, 1e-6);

    // EWMA update of mean and mean-absolute-deviation (robust "spread").
    this.meanReturn = this.alpha * ret + (1 - this.alpha) * this.meanReturn;
    this.meanAbsDev =
      this.alpha * priceDev + (1 - this.alpha) * this.meanAbsDev;
    this.meanVolume =
      this.alpha * volume + (1 - this.alpha) * this.meanVolume;
    this.meanAbsVolDev =
      this.alpha * volDev + (1 - this.alpha) * this.meanAbsVolDev;

    this.lastPrice = price;
    return { priceZ, volumeZ, direction };
  }

  get isWarmedUp(): boolean {
    return this.initialized;
  }

  get mean(): number {
    return this.meanReturn;
  }
  get mad(): number {
    return this.meanAbsDev;
  }
}

export interface AnomalyDetectorConfig {
  priceZThreshold: number; // e.g. 3.0
  volumeZThreshold: number; // e.g. 2.0
  debounceMs: number; // suppress re-trigger for this long per ticker
  warmupTicks: number; // ignore triggers until baseline has seen this many ticks
}

const DEFAULT_CONFIG: AnomalyDetectorConfig = {
  priceZThreshold: 3.0,
  volumeZThreshold: 2.0,
  debounceMs: 5 * 60 * 1000, // 5 minutes
  warmupTicks: 30,
};

export class AnomalyDetector {
  private baselines: Map<string, TickerBaseline> = new Map();
  private tickCounts: Map<string, number> = new Map();
  private lastTriggerAt: Map<string, number> = new Map();
  private config: AnomalyDetectorConfig;

  // Small rolling buffer of recent ticks per ticker, held ONLY in memory
  // - this is what lets us embed price context into an anomaly event
  // without persisting every single tick to durable storage. Capped
  // small; this is context for the agent prompt, not an audit trail.
  private recentTicksBuffer: Map<string, { timestamp: number; price: number }[]> =
    new Map();
  private readonly bufferSize = 20;

  /**
   * Per-ticker threshold overrides, set externally (e.g. by
   * detector-svc pulling the most-sensitive subscriber thresholds from
   * SubscriptionsStore). Falls back to this.config (the constructor
   * defaults) if no override is set for a given ticker - this preserves
   * the original zero-subscriber behavior exactly.
   */
  private tickerOverrides: Map<string, AnomalyDetectorConfig> = new Map();

  setTickerThresholds(ticker: string, overrides: AnomalyDetectorConfig): void {
    this.tickerOverrides.set(ticker, overrides);
  }

  private configFor(ticker: string): AnomalyDetectorConfig {
    return this.tickerOverrides.get(ticker) ?? this.config;
  }

  constructor(config: Partial<AnomalyDetectorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Process one tick. Returns a PriceAnomalyDetected event if this tick
   * crosses the combined price+volume threshold AND we're past debounce,
   * otherwise null.
   */
  process(tick: PriceTick): PriceAnomalyDetected | null {
    if (!this.baselines.has(tick.ticker)) {
      this.baselines.set(tick.ticker, new TickerBaseline());
      this.tickCounts.set(tick.ticker, 0);
    }
    const baseline = this.baselines.get(tick.ticker)!;
    const count = (this.tickCounts.get(tick.ticker) || 0) + 1;
    this.tickCounts.set(tick.ticker, count);

    const { priceZ, volumeZ, direction } = baseline.update(tick.price, tick.volume);

    // Maintain the small rolling context buffer regardless of whether
    // this tick triggers an anomaly - we need history BEFORE the trigger
    // moment, not starting from it.
    if (!this.recentTicksBuffer.has(tick.ticker)) {
      this.recentTicksBuffer.set(tick.ticker, []);
    }
    const buffer = this.recentTicksBuffer.get(tick.ticker)!;
    buffer.push({ timestamp: tick.timestamp, price: tick.price });
    if (buffer.length > this.bufferSize) buffer.shift();

    // Don't trigger until we've seen enough ticks to trust the baseline,
    // and don't trigger on the very first tick (no prior baseline at all).
    const cfg = this.configFor(tick.ticker);

    if (count < cfg.warmupTicks) {
      return null;
    }

    const combinedTrigger =
      priceZ >= cfg.priceZThreshold &&
      volumeZ >= cfg.volumeZThreshold;

    if (!combinedTrigger) {
      return null;
    }

    // Debounce: suppress repeat triggers for this ticker within the window.
    const last = this.lastTriggerAt.get(tick.ticker) ?? 0;
    if (tick.timestamp - last < cfg.debounceMs) {
      return null;
    }
    this.lastTriggerAt.set(tick.ticker, tick.timestamp);

    return {
      type: "PriceAnomalyDetected",
      event_id: uuidv4(),
      ticker: tick.ticker,
      timestamp: tick.timestamp,
      price_z_score: priceZ,
      volume_z_score: volumeZ,
      price: tick.price,
      price_direction: direction,
      rolling_mean: baseline.mean,
      rolling_mad: baseline.mad,
      recent_price_context: [...buffer],
    };
  }
}
