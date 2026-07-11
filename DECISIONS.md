# Design Decisions & Tradeoffs Log

Lightweight ADR (Architecture Decision Record) log for the Market Anomaly
Agent. Each entry captures: the problem, the options actually considered,
what was chosen and why, and what we deliberately gave up. Meant to be
useful for two audiences: future-you picking this project back up, and
anyone (e.g. an interviewer) asking "why did you build it this way?"

Ordered chronologically. Add a new entry every time a real design
tradeoff gets made - don't edit past entries to look smarter in
hindsight; add a note below them instead if a decision was later revised.

---

## ADR-001: EWMA/MAD streaming detector as the permanent core (not ML)

**Context:** Needed an anomaly detector that works on a continuous,
always-on tick stream with no natural "batch" boundary.

**Options considered:**

- Isolation Forest / One-Class SVM (unsupervised outlier detection)
- LSTM Autoencoders (reconstruction-error based)
- EWMA + MAD (exponentially weighted moving average / mean absolute
  deviation) rolling z-score

**Decision:** EWMA/MAD as the permanent core detector.

**Why:**

- O(1) update per tick, no stored history window, no retraining -
  fits a continuous stream naturally where the ML options require a
  batch-trained model with periodic retraining and drift management.
- MAD (mean absolute deviation) is more robust to outliers than raw
  stddev: a single huge spike doesn't quadratically inflate the
  "normal" baseline the way variance-based methods do, which would
  otherwise numb the detector to the very events it should catch.

**Tradeoff accepted:** EWMA/MAD only catches univariate deviations
(price, volume independently). It won't catch subtler
multi-dimensional patterns (e.g. price+volume+order-book-imbalance
moving together in a way that's individually unremarkable). Isolation
Forest / autoencoders are explicitly kept as an optional v2
second-stage filter on top of the EWMA trigger, not a replacement -
see ADR-002.

**Status:** Implemented (`src/detector/anomalyDetector.ts`).

---

## ADR-002: ML models as optional v2 filter, not core

**Context:** Following ADR-001 - should ML anomaly detection be added
alongside EWMA/MAD, and if so, how?

**Decision:** ML (Isolation Forest, autoencoders) stays a strictly
optional second-stage filter layered ON TOP of an EWMA/MAD trigger,
never a replacement for it.

**Why:** Keeps the always-on core cheap and dependency-free. ML
becomes valuable specifically for catching multi-signal anomalies that
a single-threshold trigger misses - an enhancement for precision, not
a requirement for the system to function at all.

**Status:** Not yet implemented. Deferred.

---

## ADR-003: Coinbase Advanced Trade WebSocket over Binance

**Context:** Needed a free, real-time crypto price feed.

**Options considered:** Binance WebSocket, Coinbase Advanced Trade
WebSocket.

**Decision:** Coinbase.

**Why:** Binance's feed was geo-blocked in testing. Coinbase provides
genuine real-time trades (`market_trades` channel, fires on every
match) and order-book depth (`level2` channel), free, requiring only a
free CDP API key for JWT auth on the subscribe message.

**Tradeoff accepted:** Requires a JWT auth step Binance's public feed
didn't (or was assumed not to) require - a real setup cost, not zero
configuration, but still free and still real-time.

**Status:** Implemented (`src/ingestion/coinbaseIngestion.ts`).

---

## ADR-004: Detect once per ticker, fan out per-subscriber

**Context:** Multiple researchers can subscribe to the same ticker with
different sensitivity thresholds. Naive approach: one detector
instance per (user, ticker) pair.

**Options considered:**

1. One `AnomalyDetector` instance per subscriber per ticker
2. One shared instance per ticker, run at the most sensitive threshold
   across all subscribers, then filter per-subscriber after detection

**Decision:** Option 2.

**Why:** Avoids redundant EWMA state duplicated across every
subscriber watching the same ticker - the underlying tick stream and
statistical baseline are the same regardless of who's watching. Only
the notification decision is per-subscriber.

**Tradeoff accepted:** Requires an explicit subscriptions store
(`userId -> ticker configs`) and a `refreshThresholds()` polling loop
to keep the shared detector's threshold in sync with the most
sensitive active subscriber - a small extra moving part, in exchange
for O(tickers) detector instances instead of O(subscribers).

**Status:** Implemented (`src/subscriptions/subscriptionsStore.ts`,
`AnomalyDetector.setTickerThresholds()`, `detector-svc`).

---

## ADR-005: News scope tagging at ingestion time, not query time

**Context:** Not all news that explains a ticker's move mentions that
ticker by name - e.g. a Fed rate decision or SEC regulatory
announcement can move BTC without ever saying "Bitcoin."

**Decision:** Tag every ingested article with a scope
(`ticker_specific` / `market_wide` / `unrelated`) once, at ingestion
time. Per-anomaly candidate pool = `ticker_specific(ticker) +
market_wide(all)`, excluding `unrelated`.

**Why:** Pays the classification cost once per article instead of
once per anomaly it might later be considered for. Lets a genuinely
relevant macro article surface as a candidate for any ticker, not just
ones that name-check it.

**Tradeoff accepted:** The explanation agent and semantic verifier now
need scope-aware logic (a `market_wide` citation must be framed as
systemic, not ticker-specific) - more prompt complexity and a branch in
the semantic check, in exchange for not missing genuinely relevant
macro causes.

**Status:** Implemented (`src/news/scopeClassifier.ts`,
`src/news/newsIngestion.ts`).

---

## ADR-006: Unexplained anomalies are reported, never suppressed

**Context:** What should happen when an anomaly fires but no candidate
news/sentiment explains it?

**Decision:** Report it with `claim: "no_clear_cause"`, don't hide it.

**Why:** An anomaly the agent can't explain might be the single most
valuable alert for a researcher - a novel pattern, a data glitch, or
something that hasn't hit the news yet. Suppressing it because the
system has nothing to say would defeat the point of a research tool.

**Tradeoff accepted:** Some `no_clear_cause` alerts will just be noise
the detector shouldn't have fired on in the first place - see ADR-008
(magnitude tiering), which is the actual fix for that failure mode,
not suppression.

**Status:** Implemented (`explanationAgent.ts` prompt instructs honest
refusal; `agent-svc`/`grounding-svc` pass it through as a normal
alert).

---

## ADR-007: Social sentiment via Adanos (Reddit), cached hourly, event-sourced grounding

**Context:** Wanted a social-sentiment signal alongside news, without
blowing a free-tier request budget.

**Decision:** Adanos Reddit Crypto API, free tier (250 req/month),
cached per ticker on an hourly TTL, with each fetched snapshot
persisted to the event store under its own `event_id` - same grounding
pattern as news articles.

**Why:** Per-anomaly fetching would exhaust 250 req/month almost
immediately. Caching hourly (matching Adanos's own refresh cycle)
keeps this on the free tier regardless of how many anomalies fire in a
given hour. Firestore-backed (not in-memory) cache specifically
because Cloud Run can scale `agent-svc` to multiple instances - an
in-memory cache would let each instance independently burn through the
shared monthly quota.

**Tradeoff accepted:** Sentiment can be up to 1 hour stale relative to
the actual anomaly - acceptable, since Reddit sentiment shifts on the
order of hours, not seconds, and the alternative (per-anomaly fetch)
isn't viable on the free tier at all.

**Status:** Implemented (`src/sentiment/sentimentIngestion.ts`). Field
names verified against Adanos docs only, not a live response yet - see
the "Open Verification Items" section at the bottom of this file.

---

## ADR-008: Magnitude tiering + bounded retry loop for the explanation pipeline

**Context:** Two related problems surfaced once subscriber-configurable
sensitivity was in place: (1) a low sensitivity threshold means many
more anomalies fire, each costing a Claude API call - cost scales with
how sensitive the _most_ sensitive subscriber is, not with how
interesting the anomaly actually is; (2) small anomalies often have no
real "cause" at all (they're noise/thin liquidity), and forcing an
explanation risks the agent inventing a plausible-sounding but false
link to unrelated news - exactly what the grounding verifier exists to
catch, but better to not manufacture the problem in the first place.

**Decision:** Two-part fix:

1. **Magnitude tiering** - classify every anomaly by
   `max(price_z, volume_z)` into `small` / `medium` / `large` before
   deciding what to do with it:
   - `small`: skip the explanation agent entirely, report the raw stat
     with no cause attempted. Zero LLM calls.
   - `medium`: one-shot explanation, no retry budget (matches original
     pre-tiering behavior).
   - `large`: full bounded retry loop (see below) - most likely to be
     a genuinely notable move, worth the extra attempts.
2. **Bounded Plan → Act → Observe → Decide retry loop** for `large`
   tier anomalies - if the structural grounding check rejects an
   explanation (fabricated id, citation postdates the anomaly), the
   specific rejection reason is fed back to the model as feedback for
   the next attempt, capped at 3 attempts before an honest
   `no_clear_cause` fallback.

**Why:** Tiering directly controls the cost/sensitivity tradeoff
without asking the subscriber to compromise on their threshold. The
retry loop turns "one Claude call, trust the output" into a real
agentic decision loop - the system observes its own verification
failures and corrects course, rather than a single LLM call with
post-hoc checking bolted on.

**Tradeoff accepted:** `large`-tier anomalies can now cost up to 3x the
Claude API calls of a single-shot approach. Mitigated by the fact that
tiering means only genuinely large moves reach this path at all - the
volume of anomalies that get the expensive treatment is much smaller
than the volume that fires in total.

**Alternatives considered and rejected:**

- Flat retry budget for every anomaly regardless of size - rejected,
  defeats the cost-control purpose entirely.
- Suppressing small anomalies instead of reporting them - rejected,
  contradicts ADR-006 (unexplained ≠ suppress). Tiering reports the
  stat; it just doesn't attempt a cause for it.

**Status:** Implemented (`src/detector/anomalyTiering.ts`,
`explainWithRetries()` in `services/agent-svc/src/index.ts`,
feedback-aware prompt in `src/agent/explanationAgent.ts`).

---

## ADR-009: X/Twitter sentiment rejected as a second social source

**Context:** Considered whether to add X/Twitter alongside Reddit
(Adanos) sentiment, since retail-driven pumps often show up on X before
Reddit or news.

**Options considered:**

- Official X API
- Third-party X data providers (Sorsa, GetXAPI, Netrows, etc.)

**Decision:** Rejected. Not implemented.

**Why:** X killed its free tier as of February 2026 - pay-per-use only
($0.005/read, $0.01/profile lookup), capped at 2M reads/month before
forced Enterprise pricing (~$42,000+/month). This breaks the project's
explicit strict-free-tier constraint (see ADR-007's design rationale,
which applies here too). Third-party scrapers are cheaper but carry
ToS/reliability risk and don't fit the "free, official-source" pattern
used everywhere else in this project (Coinbase, Adanos, cryptocurrency.cv).
X would also just be a second source of the _same signal category_
(social sentiment) that Reddit already covers - unlike news vs.
sentiment, which are genuinely different signal types.

**Status:** Explicitly rejected, documented here so it doesn't get
re-litigated without a reason to revisit (e.g. a future free-tier
policy change from X).

---

## ADR-010: Microservice split - ingestion / detector / agent / grounding / fanout

**Context:** How to structure the system for independent scaling and
failure isolation.

**Decision:** Five services connected via Pub/Sub, each with a single
responsibility:

- `ingestion-svc` - Coinbase WS -> `PriceTick` events
- `detector-svc` - ticks -> `PriceAnomalyDetected` (stateful, in-memory
  baseline per ticker - see note below)
- `agent-svc` - anomaly -> tiering -> explanation (+ retry loop) ->
  `ExplanationGenerated`
- `grounding-svc` - explanation -> structural verification + confidence
  scoring -> `AlertReady`
- `fanout-svc` - alert -> per-subscriber filtering -> delivery

**Why:** Each stage has different scaling and statefulness
characteristics. `agent-svc` and `grounding-svc` are stateless and can
scale horizontally; `detector-svc` cannot (see tradeoff below).
Pub/Sub decouples them so a slow/failing stage (e.g. Claude API
latency) doesn't block ingestion.

**Tradeoff accepted:** `detector-svc` holds its EWMA baseline state
in-memory per ticker. Cloud Run can scale it to multiple instances,
but Pub/Sub push doesn't guarantee the same instance sees every tick
for a given ticker - correctness currently depends on deploying it
with `max-instances=1`. Properly sharding baseline state across
instances (e.g. consistent hashing so all BTC ticks land on the same
instance) is a known, deliberately deferred scaling improvement, not
solved prematurely.

**Status:** Implemented (`services/*/src/index.ts`,
`shared/pubsub.ts`).

---

## Deferred / not yet built (tracked, not forgotten)

- **v2 backtesting batch layer** - replay EWMA/MAD against historical
  tick data to test whether anomalies (especially `no_clear_cause`
  ones) predict mean-reversion or trend-continuation within N hours.
  Must guard against look-ahead bias, survivorship bias, and
  trading-cost/slippage assumptions.
- **News impact study** - tag historical news by category (regulatory,
  hack/exchange, macro, listing, whale) and learn category -> typical
  market reaction priors, feeding back into the live confidence
  scorer. Must guard against reverse causality (news written after the
  move already happened) and category sample imbalance.

## Open verification items (schema assumed, not yet confirmed live)

- `src/news/newsIngestion.ts` - cryptocurrency.cv field names
  (`title`/`headline`, `published_at`/`publishedAt`, etc.) built from
  published examples, not a live response.
- `src/sentiment/sentimentIngestion.ts` - Adanos field names
  (`buzz_score`, `sentiment_score`, `trend`, `mention_count`) same
  caveat.
- Use `src/eval/testLiveExternalApis.ts` (single-call-per-API smoke
  test, no Firestore/Pub-Sub side effects) to verify both against real
  responses before relying on them in production.
