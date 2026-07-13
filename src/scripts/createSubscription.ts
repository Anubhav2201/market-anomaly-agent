/**
 * Standalone CLI to create a subscription - the quickest way to seed
 * yourself as a test subscriber (your own email, a ticker, and
 * thresholds) without writing to Firestore by hand.
 *
 * Usage:
 *   npx tsx src/scripts/createSubscription.ts you@example.com BTC-USD 3.0 2.0 300000
 *
 * Args: email, ticker, price_z_threshold, volume_z_threshold, debounce_ms
 * Thresholds/debounce are optional - defaults match SubscriptionsStore's
 * own DEFAULT_THRESHOLDS (price_z=3.0, volume_z=2.0, debounce=5min).
 * A LOWER threshold is MORE sensitive - use a low value here while
 * testing, so your own real anomalies actually cross it.
 */
import "dotenv/config";
import { SubscriptionsStore } from "../subscriptions/subscriptionsStore";

async function main() {
  const [email, ticker, priceZ, volumeZ, debounceMs] = process.argv.slice(2);

  if (!email || !ticker) {
    console.error(
      "Usage: createSubscription.ts <email> <ticker> [price_z_threshold] [volume_z_threshold] [debounce_ms]"
    );
    console.error('Example: createSubscription.ts you@example.com BTC-USD 3.0 2.0 300000');
    process.exit(1);
  }

  const store = new SubscriptionsStore();
  const sub = await store.create({
    user_id: email, // no separate user system yet - email doubles as the identifier for now
    email,
    ticker,
    price_z_threshold: priceZ ? Number(priceZ) : 3.0,
    volume_z_threshold: volumeZ ? Number(volumeZ) : 2.0,
    debounce_ms: debounceMs ? Number(debounceMs) : 5 * 60 * 1000,
  });

  console.log("✓ Subscription created:");
  console.log(JSON.stringify(sub, null, 2));
}

main().catch((err) => {
  console.error("Failed to create subscription:", err);
  process.exit(1);
});
