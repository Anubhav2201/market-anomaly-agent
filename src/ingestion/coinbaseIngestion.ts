import WebSocket from "ws";
import { v4 as uuidv4 } from "uuid";
import { PriceTick } from "../events/types";

/**
 * Live ingestion from Coinbase's public Advanced Trade websocket.
 *
 * Why Coinbase over Binance.US for this project:
 *  - Single, unified legal entity (NASDAQ-listed, regulated in all 50 US
 *    states + 100+ countries) - no US/global split, no geo-block 451s.
 *  - Meaningfully deeper liquidity than Binance.US specifically, so the
 *    volume signal in our anomaly detector is less likely to be noise
 *    from one thin, US-only order book.
 *  - Most market-data channels (ticker, market_trades) now work WITHOUT
 *    authentication - no API key needed for what we're doing here.
 *
 * Endpoint: wss://advanced-trade-ws.coinbase.com
 * We use the "market_trades" channel, which is the closest equivalent to
 * Binance's raw @trade stream - one message per executed trade.
 */

export interface CoinbaseIngestionConfig {
  productIds: string[]; // Coinbase format, e.g. ["BTC-USD", "ETH-USD"]
  onTick: (tick: PriceTick) => void;
  onError?: (err: Error) => void;
  reconnectDelayMs?: number;
}

interface CoinbaseMarketTradesMessage {
  channel: string;
  events: {
    type: string; // "snapshot" | "update"
    trades: {
      trade_id: string;
      product_id: string;
      price: string;
      size: string;
      time: string; // ISO 8601
      side: string;
    }[];
  }[];
}

export class CoinbaseIngestion {
  private ws: WebSocket | null = null;
  private config: Required<CoinbaseIngestionConfig>;
  private shouldReconnect = true;

  constructor(config: CoinbaseIngestionConfig) {
    this.config = {
      onError: () => {},
      reconnectDelayMs: 3000,
      ...config,
    };
  }

  start(): void {
    this.ws = new WebSocket("wss://advanced-trade-ws.coinbase.com");

    this.ws.on("open", () => {
      console.log(
        `[CoinbaseIngestion] connected, subscribing to: ${this.config.productIds.join(", ")}`
      );
      const subscribeMsg = {
        type: "subscribe",
        product_ids: this.config.productIds,
        channel: "market_trades",
      };
      this.ws?.send(JSON.stringify(subscribeMsg));
    });

    this.ws.on("message", (raw: WebSocket.RawData) => {
      try {
        const msg: CoinbaseMarketTradesMessage = JSON.parse(raw.toString());
        if (msg.channel !== "market_trades" || !msg.events) return;

        for (const event of msg.events) {
          for (const trade of event.trades) {
            const tick: PriceTick = {
              type: "PriceTick",
              event_id: uuidv4(),
              ticker: trade.product_id, // e.g. "BTC-USD"
              timestamp: new Date(trade.time).getTime(),
              price: parseFloat(trade.price),
              volume: parseFloat(trade.size),
            };
            this.config.onTick(tick);
          }
        }
      } catch (err) {
        this.config.onError(err as Error);
      }
    });

    this.ws.on("error", (err: Error) => {
      this.config.onError(err);
    });

    this.ws.on("close", () => {
      console.log("[CoinbaseIngestion] connection closed");
      if (this.shouldReconnect) {
        console.log(
          `[CoinbaseIngestion] reconnecting in ${this.config.reconnectDelayMs}ms...`
        );
        setTimeout(() => this.start(), this.config.reconnectDelayMs);
      }
    });
  }

  stop(): void {
    this.shouldReconnect = false;
    this.ws?.close();
  }
}
