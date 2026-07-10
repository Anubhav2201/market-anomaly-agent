/**
 * ingestion-svc: connects to Coinbase's public websocket and publishes
 * every trade tick to the "price-ticks" Pub/Sub topic. Deliberately the
 * simplest possible service - one job, one upstream connection,
 * publish-and-forget. Deploy with min-instances=1 (it needs to hold a
 * persistent websocket connection, so it can't scale-to-zero like the
 * other services can).
 */
import { CoinbaseIngestion } from "../../../src/ingestion/coinbaseIngestion";
import { PriceTick } from "../../../src/events/types";
import { publishEvent } from "../../../shared/pubsub";
import * as http from "http";

const PRICE_TICKS_TOPIC = "price-ticks";

let tickCount = 0;
const startedAt = Date.now();

const ingestion = new CoinbaseIngestion({
  productIds: ["BTC-USD", "ETH-USD", "SOL-USD"],
  onTick: async (tick: PriceTick) => {
    tickCount++;
    try {
      await publishEvent(PRICE_TICKS_TOPIC, tick);
    } catch (err) {
      console.error("[ingestion-svc] publish failed:", err);
    }

    if (tickCount % 100 === 0) {
      const elapsedSec = (Date.now() - startedAt) / 1000;
      console.log(
        `[ingestion-svc] ${tickCount} ticks published (${(tickCount / elapsedSec).toFixed(1)}/sec)`
      );
    }
  },
  onError: (err: Error) => {
    console.error("[ingestion-svc] CoinbaseIngestion error:", err.message);
  },
});

console.log("[ingestion-svc] starting...");
ingestion.start();

// Cloud Run requires a service to listen on $PORT even if its "real"
// job is the websocket connection above - this is just a liveness/health
// endpoint so Cloud Run knows the container is up.
const port = process.env.PORT || 8080;
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        ticksPublished: tickCount,
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      })
    );
  })
  .listen(port, () => {
    console.log(`[ingestion-svc] health endpoint listening on :${port}`);
  });

process.on("SIGTERM", () => {
  console.log("[ingestion-svc] SIGTERM received, shutting down...");
  ingestion.stop();
  process.exit(0);
});
