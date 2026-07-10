# Market Anomaly Agent

> **⚠️ Disclaimer: This project is for educational and research purposes only.**
> It is a study of event-driven architecture, AI agent grounding, and
> verification techniques — **it is not financial advice, not a trading
> tool, and not intended to inform investment decisions.** The
> explanations it generates describe *what happened and possible why* —
> never what anyone should buy or sell. Crypto assets are volatile and
> risky; consult a licensed financial advisor for investment decisions.

A free, open, real-time crypto price-anomaly explainer. Detects unusual
price/volume moves and uses an AI agent to explain *why* — grounded in
verifiable citations, not free-text guesses.

## Why this exists

Most "AI explains market moves" products (e.g. Robinhood's Cortex
Digests) are paywalled and closed. This is the same idea, built free and
open, with an explicit focus on making the AI's explanation *verifiable*
rather than just plausible-sounding — see "Grounding architecture" below.

## Architecture

```
ingestion-svc (Coinbase WS, always-on, min-instances=1)
   --publishes--> [price-ticks topic]
       --push--> detector-svc (anomaly detection, stateful, max-instances=1)
           --publishes--> [anomalies topic]
               --push--> agent-svc (news + sentiment fetch, Claude call, stateless)
                   --publishes--> [explanations topic]
                       --push--> grounding-svc (verification + confidence scoring)
                           --publishes--> [alerts topic]
                               --push--> fanout-svc (per-subscriber filtering)
                           --writes--> Firestore (durable event log)
```

Five independently-deployable Cloud Run services, sharing a durable
Firestore event store, communicating via Pub/Sub. See `DEPLOYMENT.md`
for the full `gcloud` deployment guide.

There's also a **local, no-infra path** (`src/live.ts`, `src/demo.ts`)
for development and testing without deploying anything — see "Local
development" below.

## Grounding architecture (the core idea)

The agent's output is NOT free text. It's a structured claim citing
specific `event_id`s from real, stored events (news articles, sentiment
snapshots). Verification is then mostly deterministic, not another LLM
judging the first LLM:

1. **Existence check**: does every cited `event_id` actually exist in
   the store? (catches fabricated citations, for free — no LLM call)
2. **Causality check**: does every cited event's timestamp precede the
   anomaly it's explaining? (catches "citing the future" — a real bug
   class, not just hallucination)
3. **Narrow semantic check** (optional, the one piece that still uses a
   model): does the cited content actually support the specific claim?
   Scoped small (one claim + its own citations, not the whole
   explanation) and routed to a free-tier model (Groq), not Claude.

On top of structural grounding, a **composite confidence score** is
computed from independently-verifiable signals (never the model's bare
self-reported confidence):
- News-volume spike (is there unusually more news than normal for this
  ticker right now?)
- Sentiment-direction coherence (does cited sentiment/news direction
  match the observed price direction?)
- Source diversity (how many independent sources corroborate this?)
- Temporal proximity (how close in time was the citation to the
  anomaly?)
- Scope specificity (is the citation about this ticker specifically, or
  broader market-wide news?)
- The narrow semantic check above

**A failed structural check hard-gates confidence to exactly 0**,
regardless of how good the other signals look.

## Candidate sources for citations

1. **News** (`src/news/`) — cryptocurrency.cv, free, tagged at ingestion
   time as `ticker_specific` / `market_wide` / `unrelated` (unrelated is
   filtered out entirely). Fetched from both a ticker-scoped endpoint
   and the general/breaking feed, so market-wide events that don't name
   the ticker aren't missed.
2. **Social sentiment** (`src/sentiment/`) — Reddit crypto sentiment via
   Adanos' free tier (250 requests/month total), cached **hourly per
   ticker in Firestore** (not in-memory — agent-svc can run multiple
   instances, so an in-memory cache would let each burn through the
   shared quota independently).

Both are citable; both go through the same existence/causality checks —
no special-casing per source type.

## Detection: adaptive, not fixed-threshold

`src/detector/anomalyDetector.ts` uses an EWMA-based rolling baseline
per ticker (not a fixed % threshold), MAD (median-ish absolute
deviation) instead of raw stddev so a single huge move doesn't numb
future detection, combined price+volume triggering, and a debounce
window.

## Subscriptions & fan-out

Design principle: **detect once per ticker at the most sensitive
threshold across all subscribers, then fan out per-subscriber** — not
one detector instance per subscriber.

- `src/subscriptions/` — Firestore-backed subscription records
  (`userId` + `ticker` + their own price/volume/debounce thresholds).
  `getMinThresholdsForTicker()` caches in-memory, refreshed every 5 min
  (not queried per-tick — stays within Firestore free tier).
- `detector-svc` pulls the min (most sensitive) threshold per known
  ticker and configures itself to never miss an anomaly any subscriber
  cares about.
- `fanout-svc` then filters the single detected anomaly against each
  individual subscriber's own (possibly less sensitive) threshold and
  enforces per-subscriber debounce, independent of the detection-level
  debounce.
- **Delivery is stubbed** — `fanout-svc` logs who would receive an
  alert; wiring real email/push (SendGrid, FCM) is an isolated next step
  that plugs in right there.

## Local development (no GCP needed)

```bash
npm install
cp .env.example .env   # fill in ANTHROPIC_API_KEY at minimum
npx tsc --outDir dist

node dist/src/demo.js          # synthetic replay - proves grounding logic, no network needed
node dist/src/testSignals.js   # signal sanity tests - no network needed
node dist/src/live.js          # full live pipeline: Coinbase -> detect -> explain -> verify
```

`live.ts` uses the in-memory `EventStore` (`src/events/store.ts`), not
Firestore — good for local iteration without any GCP setup at all.

## Deploying to GCP

See `DEPLOYMENT.md` for the complete guide: creating Pub/Sub topics,
deploying all five services, wiring push subscriptions with proper IAM,
and a free-tier cost checklist.

## What's honestly NOT built yet

- **Real delivery channel** for `fanout-svc` (currently logs only)
- **Dashboard/UI**
- **Ticker-sharded scaling** for `detector-svc` beyond a single instance
  (its baseline state is in-memory; Pub/Sub push doesn't guarantee tick
  affinity across instances)
- **A larger eval dataset** — the harness exists (see below) but ships
  with only 3 seed scenarios; the aggregate numbers become meaningful
  around 15-20+. See `eval-data/README.md` for how to grow it.
- **v2 batch layer**: backtesting the detector against historical data
  to test whether anomalies (especially `no_clear_cause` ones) predict
  mean-reversion or trend-continuation — a separate planned layer, not
  blocking v1

## Eval harness

`src/eval/runEvals.ts` replays documented historical scenarios through
the REAL pipeline (real Claude call, real grounding verification, real
confidence scoring — nothing mocked except data sources) and scores
against a ground-truth answer key (`eval-data/scenarios.json`):

- **claim correctness** — did the explanation match the documented cause?
- **citation correctness** — did it cite the right articles and *only*
  the right articles? (citing a distractor alongside a correct article
  still fails, deliberately)
- **honest refusal** — for scenarios where no candidate genuinely
  explains the move, did it say `no_clear_cause` instead of forcing a
  connection? This is the hardest and most important behavior tested.
- **confidence calibration** — is composite confidence higher on correct
  answers than incorrect ones?

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npx tsc --outDir dist
node dist/src/eval/runEvals.js
```

Each scenario is one real Claude call (~$0.01-0.02). See
`eval-data/README.md` for how to grow the dataset — including harvesting
real judged cases from your deployed pipeline's Firestore log, which is
the sustainable long-term source.

## Known caveats worth stating in any writeup

- **Data source scope**: Coinbase is a single (deep, US-regulated)
  exchange, not a global crypto aggregate. Chosen over Binance.US
  because it's a single unified entity (no US/global split, no geo-block
  451s) with meaningfully deeper liquidity.
- **News/sentiment API schemas are built from published docs, not
  verified against live responses** (this dev environment has no
  network route to cryptocurrency.cv or api.adanos.org) — verify field
  names against real responses before relying on this in production.
- **Grounding proves citations are real and causally prior — not that
  they're the true cause.** A cited article can exist, predate the
  anomaly, and still not be the actual reason for the move. This is a
  known, documented limitation shared by every system in this space
  (Robinhood's own Cortex docs describe "guardrails for factual
  consistency," not causal-attribution guarantees). The confidence
  signals reduce this risk but don't eliminate it — the eval harness is
  what would measure it properly.

## Git history

This project's commit history is intentionally kept meaningful (each
commit is one real feature/fix), not squashed — see `git log` for the
full story of how this was built incrementally.
