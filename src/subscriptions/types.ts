/**
 * A user's subscription to anomaly alerts for a specific ticker, with
 * their own sensitivity thresholds. This is what makes the "detect once
 * per ticker at the most sensitive threshold, fan out per-subscriber"
 * design possible: detector-svc runs at the MINIMUM (most sensitive)
 * threshold across all subscribers for a ticker, so it never misses an
 * anomaly any subscriber cares about - then fanout-svc filters the
 * single detected anomaly against each individual subscriber's own
 * (possibly less sensitive) threshold before deciding whether THEY get
 * notified.
 */
export interface Subscription {
  subscription_id: string;
  user_id: string;
  ticker: string;
  price_z_threshold: number;
  volume_z_threshold: number;
  debounce_ms: number;
  created_at: number;
}
