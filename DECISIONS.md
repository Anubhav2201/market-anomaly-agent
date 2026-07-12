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
how sensitive the *most* sensitive subscriber is, not with how
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
X would also just be a second source of the *same signal category*
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

## ADR-011: Adanos endpoint/schema correction from real API examples

**Context:** `sentimentIngestion.ts` was originally written from Adanos'
published docs/SDK examples without a live response to check against
(no network route to `api.adanos.org` from the dev sandbox this was
built in - flagged explicitly as an open verification item in this
file). The user later shared real screenshots of Adanos' actual API
responses.

**What was wrong:**
- Assumed endpoint: `GET /v1/reddit-crypto/token?ticker=BTC` (ticker as
  a query parameter)
- Real endpoint: `GET /reddit/stocks/v1/stock/{TICKER}` (ticker as a
  **path** parameter)
- Assumed field: `mention_count`
- Real field: `mentions`
- Missed field entirely: `found` (boolean) - tells you whether Adanos
  recognizes the ticker at all, distinct from "recognized but zero
  mentions"

**Fix applied:** Corrected the URL construction and field mapping in
both `src/sentiment/sentimentIngestion.ts` and
`src/eval/testLiveExternalApis.ts`. Added explicit handling for
`found: false` - degrades to "no sentiment data" (returns `null`),
consistent with every other soft-failure path in this pipeline, rather
than silently returning zeros for a ticker Adanos doesn't recognize.

**Still open:** every real example available (TSLA, NVDA, AMD, GME,
SPY, GOOGL) is a stock ticker. Whether `/reddit/stocks/v1/stock/{...}`
also serves crypto symbols (BTC, ETH) - as the Adanos homepage's
"Reddit: Stocks, ETFs, crypto" tile implies it should - has not been
confirmed with an actual crypto ticker response. If it returns
`found: false` for crypto symbols in practice, this integration needs
a different endpoint (not yet identified) or Adanos may not actually
cover crypto through this particular product despite the marketing
copy. **Verify with `testLiveExternalApis.ts` against a real crypto
ticker before trusting this in production.**

**Lesson for the log:** this is the second time in this project
(`newsIngestion.ts` being the first) that an external API integration
was built from documentation/marketing copy rather than a live
response, and the first time it was actually wrong in a way that would
have silently returned no data (`found: false` handling was missing
entirely - the old code would have returned a snapshot with all-zero
fields instead of correctly treating it as "no data available").
Worth prioritizing a live-response check earlier in the process for
any future external integration, rather than after the fact.

**Status:** Fixed. Not yet verified end-to-end with a real crypto
ticker - see "Open verification items" at the bottom of this file.
(Superseded by ADR-012 below - the endpoint this ADR fixed to was
still wrong, just less wrong.)

---

## ADR-012: Definitive fix - dedicated crypto endpoint found in real OpenAPI spec

**Context:** ADR-011 corrected the endpoint/field names against
screenshotted Adanos examples, but explicitly flagged an open
question: every example available was a stock ticker
(TSLA/NVDA/AMD/GME/SPY/GOOGL), and it was only an assumption that
`/reddit/stocks/v1/stock/{ticker}` also covered crypto symbols.

**What resolved it:** the user obtained Adanos' actual OpenAPI spec
(`api-1.json`). It shows Adanos exposes entirely separate path
families per platform AND per asset class:
`/reddit/stocks/v1/...`, `/reddit/crypto/v1/...`, `/news/stocks/v1/...`,
`/polymarket/stocks/v1/...`, `/x/stocks/v1/...` - stocks and crypto are
genuinely different endpoint trees, not the same endpoint serving both.

**The correct endpoint was never the stocks one.** It's:
`GET /reddit/crypto/v1/token/{symbol}` - confirmed directly from the
spec's `CryptoTokenSentiment` schema and a real example response for
ETH.

**Real schema (crypto-specific, from the spec):**
`symbol`, `name`, `found`, `buzz_score` (0-100), `mentions`,
`sentiment_score` (-1 to 1), `total_upvotes`, `unique_posts`,
`subreddit_count`, `trend`, `bullish_pct`, `bearish_pct`,
`period_days`, plus richer optional fields not currently consumed
(`top_subreddits`, `daily_trend`, `top_mentions` - representative
high-engagement posts, could be worth surfacing in the explanation
prompt later as concrete evidence rather than just aggregate scores).

**Also clarified by the spec (would have caused a subtle bug if
missed):** `found: false` on a normal `200` response means the symbol
IS supported but has no qualifying data in the requested window (e.g.
a quiet ticker) - this is an expected, non-error case. A genuinely
**unsupported** symbol returns HTTP `404` instead. These are two
different "no data" situations that both degrade to `null` in our
code, but are logged differently so a real symbol-support problem
isn't confused with an ordinary quiet-ticker case.

**Also confirmed by the spec:** the free tier is genuinely 250
requests/month (`X-RateLimit-Limit-Monthly: 250` in the example
response headers) - matches the design assumption in ADR-007, good to
have it confirmed from the source rather than secondhand.

**Fix applied:** `src/sentiment/sentimentIngestion.ts` and
`src/eval/testLiveExternalApis.ts` now call
`/reddit/crypto/v1/token/{symbol}`, map the real
`CryptoTokenSentiment` fields, and distinguish 404 (unsupported) from
`found:false` (supported, no data) with separate log messages.

**Lesson for the log, updated from ADR-011:** two consecutive
"corrections" to this same integration (ADR-011 then this one) were
both still guesses until the actual OpenAPI spec was in hand. The
spec should have been the first thing requested for any external
integration, not the last - screenshots and docs pages are a weaker
source than the machine-readable spec when one exists, and Adanos
happens to publish exactly that (`/llms.txt` for agent consumption,
per their own docs).

**Status:** Fixed against the real spec. Field parsing not yet
exercised against a live HTTP response from this environment (no
network route to `api.adanos.org` from this sandbox) - still worth
one real run via `testLiveExternalApis.ts BTC-USD` before trusting it
in production, but the endpoint/schema themselves are no longer a
guess.

---

## ADR-013: Confirmed against Adanos' authoritative machine-readable reference

**Context:** ADR-012 fixed the crypto endpoint from the real OpenAPI
spec (`api-1.json`). The user then supplied Adanos' full `llms.txt` -
the canonical, agent-oriented reference Adanos publishes specifically
for this purpose (linked from their own API root and OpenAPI docs).

**Result:** the ADR-012 fix is exactly correct.
`GET /reddit/crypto/v1/token/{symbol}` matches the documented endpoint
and response shape precisely, including the `found` semantics (200 +
`found:false` = supported symbol, no data this window) and the 404
distinction for genuinely unsupported symbols.

**One real refinement made from this reference:** the 404 response
body has a structured shape - `detail.error_code`, specifically
`"unsupported_symbol"` for crypto (vs `"unsupported_ticker"` for
stocks). `sentimentIngestion.ts` now parses and logs this code instead
of just logging "404", so a genuine "Adanos doesn't track this symbol"
case is distinguishable in logs from other possible 404 causes.

**New information surfaced, not yet acted on:**
- **`GET /reddit/crypto/v1/market-sentiment`** returns an
  aggregate crypto-wide sentiment reading with a `drivers[]` array
  (top symbols driving overall crypto sentiment) - this maps directly
  onto the `market_wide` concept from ADR-005 (news scope tagging).
  Worth considering as a second sentiment candidate type alongside the
  per-ticker snapshot: a `market_wide` sentiment reading, analogous to
  how `market_wide` news articles are already handled, for anomalies
  where crypto-wide social mood (not just this ticker's Reddit buzz)
  might be the real driver. Not implemented - flagged here so it isn't
  lost.
- **`GET /reddit/crypto/v1/compare?symbols=BTC,ETH`** - fetches
  sentiment for up to 10 symbols in one call. Not currently useful
  (this project fetches one ticker per anomaly), but relevant if the
  system ever needs to warm a sentiment cache for several tracked
  tickers at once instead of one call per ticker.
- Raw mention-level endpoints (`/token/{symbol}/mentions`) require a
  **Professional** account tier, not Free - confirms the aggregate
  `/token/{symbol}` endpoint (what this project actually uses) is the
  right one for the free-tier constraint; the more granular raw data
  simply isn't available on free at all.

**Status:** Endpoint/schema fix confirmed correct against the
authoritative source. Error-code parsing added. `market-sentiment` as
a second candidate type is a new deferred idea, not yet built.

---

## ADR-014: Market-wide crypto sentiment as a second sentiment candidate type

**Context:** ADR-013 surfaced `GET /reddit/crypto/v1/market-sentiment`
as a deferred idea - an aggregate crypto-wide sentiment reading with a
`drivers[]` list, mapping onto the existing `market_wide` news-scope
concept (ADR-005). Decided to build it now rather than leave it
deferred, since it's a natural extension of a pattern already proven
to work for news.

**Decision:** Add a `scope: "ticker_specific" | "market_wide"` field
to `SentimentSnapshotIngested` (mirroring `NewsArticleIngested.scope`
exactly). Fetch and cache BOTH a ticker-specific snapshot (existing
`/reddit/crypto/v1/token/{symbol}`) and a market-wide snapshot (new -
`/reddit/crypto/v1/market-sentiment`) for every anomaly, and hand both
to the explanation agent as separate citable candidates.

**Caching design:** the market-wide reading is NOT per-ticker (it's a
single global crypto-market reading), so it's cached under one global
Firestore key rather than one-per-ticker - every anomaly, regardless
of which ticker, shares the same cached market-wide snapshot within
the hourly TTL. This means adding market-wide sentiment does NOT
double the monthly Adanos request count per ticker - it adds a
constant ~1 extra fetch per hour total (across all tickers combined),
not 1 extra fetch per ticker per hour. Refactored the caching logic
into a shared `getCached()` helper in `SentimentIngestion` so both
snapshot types reuse the same cache-check-then-fetch flow.

**Prompt design:** the agent is told explicitly that a market_wide
sentiment citation should be framed as a broad/systemic mood shift,
not something specific to the ticker - same framing instruction
already used for market_wide news (ADR-005), applied consistently to
sentiment.

**Confidence scoring:** `tickerSpecificFraction` (scope-specificity
weighting, ADR in confidenceScorer.ts) now spans citations from BOTH
news and sentiment uniformly, rather than being computed from news
citations only - a citation's specificity should count the same way
regardless of which evidence type it came from. Sentiment coherence
checking was also generalized from "one cited sentiment snapshot" to
"however many were cited" (0, 1, or 2) - if a ticker-specific snapshot
and a market-wide snapshot disagree in direction, that disagreement
correctly makes the composite signal incoherent rather than being
silently averaged away.

**Tradeoff accepted:** the explanation agent now has two sentiment
candidates instead of one to reason about (plus however many news
articles), a slightly larger prompt. Cost impact is small - it's still
the same one Claude call per attempt, just a longer prompt, not an
extra API call. The extra Adanos call is effectively free given the
global-cache design above.

**Status:** Implemented (`src/events/types.ts`,
`src/sentiment/sentimentIngestion.ts` - new `getMarketSnapshot()`
alongside the existing `getSnapshot()`, `src/agent/explanationAgent.ts`
- `sentimentSnapshots` array replacing the old singular field,
`services/agent-svc/src/index.ts`, `services/grounding-svc/src/index.ts`
- scope-aware confidence scoring, `src/eval/testLiveExternalApis.ts` -
opt-in second Adanos call via `FETCH_MARKET_SENTIMENT=1`). Not yet
exercised against a live Adanos response - same open verification
item as the rest of the sentiment integration.

---

## ADR-015: Honest no_clear_cause incorrectly failed structural grounding (real bug, found via live test)

**Context:** The first live run of `testLiveExternalApis.ts` (XRP-USD,
2026-07-11) surfaced a real bug: `groundingVerifier.ts` and
`groundingVerifierAsync.ts` both unconditionally treated
`cited_event_ids.length === 0` as a structural failure -
`"no cited events - unsupported claim"` - regardless of whether the
explanation's claim was actually `"no_clear_cause"`.

**Why this was wrong:** an honest `no_clear_cause` (empty citations,
by design - see ADR-006) is NOT the same failure mode as an
`"explained"` claim with zero citations (which WOULD be a real
violation - asserting a specific cause with nothing to back it up).
The old code conflated these into one failure path. In production,
this meant every genuinely honest "I couldn't find a cause" answer
from the agent got labeled `structurally_grounded: false` with the
same failure reason as an actual fabrication - directly undermining
the distinction ADR-006 was built to preserve.

**Compounding issue:** even after fixing the grounding check itself,
letting a `no_clear_cause` explanation flow through
`computeConfidence()` produces a misleading nonzero score (~0.1-0.2,
from the "unknown/neutral" defaults in confidenceScorer.ts) for a
claim that explicitly has no causal content to be confident about.

**Fix applied (both files, plus grounding-svc and the test script):**
- `groundingVerifier.ts` / `groundingVerifierAsync.ts`: empty citations
  now return `structurally_grounded: true` (vacuously grounded -
  nothing to verify) specifically when `claim === "no_clear_cause"`;
  the `"no cited events - unsupported claim"` failure is now reserved
  for an explanation that asserts something but cites nothing.
- `services/grounding-svc/src/index.ts`: added a short-circuit
  immediately after the structural check - a `no_clear_cause`
  explanation now publishes its `AlertReady` directly with
  `composite_confidence: 0`, skipping the scoring math entirely,
  mirroring the pattern already used for small-tier skips in
  `agent-svc`.
- `src/eval/testLiveExternalApis.ts`: same skip, for consistency.

**How this was found:** this is a genuine example of why the live
smoke test was worth building - a scenario this specific (an honest
"no cause found" response) never came up in the hand-authored eval
scenarios (`runEvals.ts`), which tend to be written around cases WITH
a documented ground-truth cause.

**Status:** Fixed in all four locations, typechecked clean.

---

## ADR-016: cryptocurrency.cv outage - third-party hosting issue, not an integration bug

**Context:** The same live test run got `HTTP 402` from both
`newsIngestion.ts` endpoints. Investigation (`curl -v`) showed the
response was `x-vercel-error: DEPLOYMENT_DISABLED` with body "Payment
required" - this is Vercel's own platform message when a site owner's
hosting bill is unpaid or usage-capped, not cryptocurrency.cv's API
responding to a request. The API's own documentation and GitHub
README still claim "100% Free - No API keys required."

**Conclusion:** this is a genuine, ordinary outage of a free
third-party side-project API, unrelated to anything in this codebase.
`newsIngestion.ts`'s endpoint paths, auth assumptions (none needed),
and cost assumptions (free) are all still correct as designed - there
is nothing to fix in the integration itself.

**What this demonstrated working correctly:** with 0 news articles
returned, the pipeline did NOT error or fabricate - it correctly
proceeded to `no_clear_cause` (see ADR-015 above, which this same test
run surfaced). Graceful degradation under a real external failure,
exactly as designed.

**Open question this raises: resiliency against free-tier
dependencies.** This project now depends on THREE free external APIs
(Coinbase WS, Adanos, cryptocurrency.cv), each of which can silently
go dark for reasons entirely outside this codebase's control (a
maintainer's unpaid hosting bill, in this case). Options, not yet
decided:
1. Accept the risk - free-tier dependencies are part of the
   project's explicit cost-conscious design (ADR-007, ADR-009), and a
   graceful `no_clear_cause` fallback already exists for exactly this
   failure mode.
2. Add a second, independent free news source as a fallback if the
   primary one is down for some period - more integration surface and
   another schema to maintain, for a benefit that only matters during
   an outage.
3. Just retry later and treat this as transient - Vercel deployments
   get re-enabled once the owner's billing is sorted, which could be
   hours or could be indefinite depending on whether the project is
   actively maintained.

Leaning toward option 1/3 (no code change, just wait and retry) given
this is a portfolio/learning project, not a production system with an
uptime SLA - but noting the tradeoff explicitly rather than silently
picking it.

**Status:** Confirmed external, not a bug. No fix needed in this
codebase. Resiliency tradeoff logged, not yet decided.

---



## ADR-017: Swapped cryptocurrency.cv for Tiingo News API

**Context:** ADR-016 confirmed cryptocurrency.cv's outage was a
third-party hosting issue (Vercel `DEPLOYMENT_DISABLED` - the
maintainer's own unpaid bill), not a bug in this codebase. But it
raised a real resiliency question: depending on a free side-project
API means the whole news-ingestion path can go dark for reasons
entirely outside this project's control, with no warning and no ETA
for recovery.

**Options considered** (researched candidates: CoinGecko Demo,
CoinMarketCap Basic, Tiingo News API, NewsData.io):
- CoinGecko/CoinMarketCap free tiers are strong for market/price data
  but aren't built as full-article news-content APIs - weaker fit for
  what `newsIngestion.ts` actually needs (headline + summary text to
  scope-classify and cite).
- NewsData.io - real article text, 5,000 req/month, but general news
  (not crypto-native) - would need extra filtering for crypto
  relevance.
- **Tiingo News API** - purpose-built financial news mapped to 4,100+
  tickers (stocks, crypto, FX), 15+ years of history, 8,000-12,000
  articles/day. Closest match to the existing two-endpoint design
  (ticker-scoped + general/latest feed).

**Decision:** Tiingo News API.

**Why:** best content fit (real article text, not just price data),
and - just as importantly - a funded, commercially-operated API rather
than a free side-project, meaningfully reducing the "silently goes
dark" risk ADR-016 surfaced. Tiingo's "personal/internal use" license
restriction doesn't block this project: the restriction targets
redistributing their raw feed in a commercial/public product, not
processing news to generate this project's own derived explanations.

**Implementation, confirmed against Tiingo's actual published schema**
(fetched directly from https://www.tiingo.com/documentation/news,
2026-07-11 - not guessed from marketing copy or a screenshot, learned
from the Adanos ADR-011/012 lesson to go straight to the authoritative
source):
- Endpoint: `GET https://api.tiingo.com/tiingo/news`
- Auth: `Authorization: Token {TIINGO_API_KEY}` header (not keyless,
  unlike the old cryptocurrency.cv assumption)
- Real fields: `id`, `title`, `url`, `description`, `publishedDate`,
  `crawlDate`, `source` (domain), `tickers[]`, `tags[]`
- Same two-fetch pattern preserved: `?tickers={symbol}` (ticker-scoped)
  + `?sortBy=crawlDate` with no ticker filter (latest/general, catches
  market_wide articles a ticker-scoped query would miss)
- **One real improvement over the old design**: Tiingo's own
  `tickers[]` array is a stronger ticker-specific signal than the
  lexicon-based `classifyNewsScope()` heuristic - if Tiingo itself
  tagged an article with the exact symbol, that's trusted directly as
  `ticker_specific` rather than re-guessing from headline/summary text.
  The lexicon classifier remains the fallback for everything else
  (including `market_wide` detection, which Tiingo's tagging doesn't
  directly signal).
- `fetchRecentNews()` still returns `[]` (not throws) when
  `TIINGO_API_KEY` is unset or any request fails - same graceful
  degradation to honest `no_clear_cause` as before (ADR-006/ADR-015).

**Tradeoff accepted:** no longer keyless - requires a free Tiingo
signup, one more credential to manage alongside Anthropic/Adanos/Groq.
Worth it for the reliability gain.

**Status:** Implemented (`src/news/newsIngestion.ts`,
`.env.example`, `src/eval/testLiveExternalApis.ts` references
updated). Not yet exercised against a live Tiingo response - same
"confirmed from docs, not yet from a live call" caveat as the Adanos
work before ADR-013 validated it live.

---



## ADR-018: Tiingo News confirmed paid-only - decided to upgrade to Power

**Context:** ADR-017 swapped `newsIngestion.ts` to Tiingo. The first
live test (DOT-USD) got `HTTP 403` on both endpoints. Investigation
first considered an auth/config issue (wrong header format, a
News-API opt-in checkbox some Tiingo accounts need). The user then
supplied a screenshot of Tiingo's actual pricing page, which settles
it definitively.

**Confirmed:** Tiingo's pricing table has an explicit "Tiingo News"
row - **✗ on Starter ($0/month), ✓ only on Power ($30/month)**. This
is not a bug, not a missing checkbox, not a header format issue - the
free tier genuinely excludes the News API entirely. (IEX Feed and
Tiingo Crypto, by contrast, ARE included free - it's specifically News
that's gated.)

**Decision point, not yet resolved:** this breaks the project's
consistent "stay on free tier" design principle (ADR-007, ADR-009).
Options:
1. Pay Tiingo Power ($30/month) - best content quality (20M articles,
   3 months queryable history, proper ticker/FX/equity/crypto tagging)
   but the project's first paid dependency.
2. Switch to NewsData.io (free, 5,000 req/month) - real article text,
   general news rather than crypto-native, would need extra
   crypto-relevance filtering on top.
3. Look for one more free, crypto-native option before deciding.

**Decision made:** Option 1 - upgrading to Tiingo Power ($30/month).
This is the project's first paid dependency, a deliberate departure
from the free-tier-only principle held everywhere else (Coinbase,
Adanos, the X/Twitter rejection in ADR-009). Worth being upfront about
in any presentation of this project's architecture: everything else
is free by design; news ingestion is the one exception, chosen for
content quality (20M articles, proper multi-asset tagging) over
staying strictly free.

**Status:** Resolved. No code changes needed - `newsIngestion.ts`
(ADR-017) was already correctly written against Tiingo's real schema;
the `403` was purely the Starter plan's News restriction, not a bug.
Once the Power plan is active, the exact same code should work as-is.

---



## ADR-019: Tiingo's unfiltered feed is too broad for "market_wide" - scoped to crypto bellwethers instead

**Context:** With Tiingo Power active (ADR-018), the first real news
test (DOT-USD) returned 0 candidates with no errors - a different,
quieter symptom than the earlier `403`. Direct `curl` on the
unfiltered `?sortBy=crawlDate` endpoint (no ticker filter) - the query
this project had been using as the "general/latest feed," mirroring
cryptocurrency.cv's old "breaking news" endpoint - returned a "What is
a hosepipe ban" utility/weather article as the top result.

**What this revealed:** Tiingo's news feed spans every asset class and
topic they cover (stocks, ETFs, general financial/lifestyle topics -
their own docs mention art blogs, farming publications, healthcare
trade magazines). Unlike cryptocurrency.cv's breaking feed (crypto-only
by construction), an unfiltered Tiingo query is NOT crypto-specific at
all. Every one of those general articles was correctly classified as
`unrelated` by `classifyNewsScope()` and discarded - so the 0-candidate
result was the classifier working as designed, not a bug in it. The
actual bug was upstream: the query itself was the wrong shape for what
"market_wide crypto news" is supposed to mean.

**Fix:** replaced the unfiltered query with `tickers=btc,eth` (Tiingo's
documented, confirmed comma-separated tickers parameter - not a guess)
as a crypto-bellwether proxy for "market-wide crypto news." A
regulatory/Fed article that mentions Bitcoin or Ethereum but not the
specific ticker being analyzed is exactly the kind of `market_wide`
context this project wants (same intent as ADR-005), without pulling
in Tiingo's full multi-asset-class firehose. If the ticker being
analyzed IS BTC or ETH itself, it's excluded from its own bellwether
list (redundant, not harmful, just cleaned up).

**Tradeoff accepted:** this is a narrower "market-wide" definition than
"literally any macro/regulatory crypto news" - it specifically means
"news that also got tagged against BTC or ETH." A genuinely market-wide
crypto article that Tiingo's tagging algorithm somehow didn't associate
with either bellwether would be missed. Considered using Tiingo's
`tags=` parameter instead (also real, confirmed via a community
integration script) but did not use it here because the actual tag
string values Tiingo uses for crypto/regulatory topics aren't confirmed
from their own docs - would have been another guess, the exact mistake
ADR-011/012 already taught not to repeat. `tickers=btc,eth` uses only
the parameter and value shape already confirmed live.

**Status:** Implemented (`src/news/newsIngestion.ts`). Not yet
re-tested live after this fix - next `testLiveExternalApis.ts` run
should confirm real candidates now come through instead of an
unfiltered, mostly-irrelevant feed.

---



## ADR-020: Synthetic test price needed to be realistic per-ticker, not just "not zero"

**Context:** ADR (price:0 fix, folded into the file header history)
already fixed the original placeholder problem - a synthetic anomaly
price of exactly `0` caused Claude to correctly flag "price crashed to
zero" as a data glitch instead of attempting a real explanation. The
fix at the time was a generic `mean=100` placeholder. Live testing
with BTC-USD showed this had the SAME underlying problem in a new
form: once real Tiingo news came back mentioning BTC's actual price
(~$64,000), the synthetic anomaly price ($105, from `100 + 5*1`) stuck
out as obviously inconsistent - Claude again (correctly) concluded
"data glitch" rather than testing the explanation pipeline against a
plausible scenario.

**Root cause, more precisely stated:** the problem was never really
about avoiding zero specifically - it's that the synthetic price needs
to be in the right ballpark for whatever ticker is actually being
tested, now that real news/sentiment content is in the picture and
Claude can (correctly) cross-reference the synthetic price against
real-world figures it just read.

**Fix:** added a small `ROUGH_PRICE_ESTIMATES` lookup (BTC, ETH, SOL,
XRP, DOT, ADA, AVAX, LINK, DOGE, MATIC) giving each a realistic
ballpark price, with a generic `$50` fallback for anything not listed.
The synthetic rolling_mean/mad/price are now derived from that
baseline instead of a fixed generic number, so the synthetic anomaly
is at least plausible alongside genuine fetched content.

**Status:** Implemented (`src/eval/testLiveExternalApis.ts`). Still a
known limitation: these are rough, hand-maintained estimates, not
live-fetched prices - if BTC's real price drifts far enough from
$64,000 in the future, this same class of issue could resurface for
BTC specifically. A more robust fix (fetching a real current price
from a free source before constructing the synthetic anomaly) is a
reasonable future improvement if this becomes a recurring annoyance,
but wasn't judged worth the extra API dependency for what's
fundamentally a test/dev script, not production code.

---



## ADR-021: First full end-to-end validation - explained claim, correctly grounded and cited (plus a mistagging fix)

**Context:** ARB-USD live test (2026-07-11) - this is the first run
across the entire testing session that produced an `"explained"`
claim rather than `no_clear_cause`. Claude correctly identified and
cited the single genuinely relevant article out of 10 fetched (the
Robinhood Chain fee-revenue story) alongside real ARB-specific
sentiment, ignoring 8 completely unrelated articles that happened to
also come back tagged for this ticker. Structural grounding passed,
composite confidence landed at 0.57 (reasonable - single ticker-
specific news source plus coherent sentiment, not an overwhelming
multi-source case).

**This validates the full pipeline end-to-end for the first time**:
real Tiingo news -> real Adanos sentiment -> Claude citing specific
event_ids -> structural verification -> confidence scoring, all
against live data rather than synthetic/mocked candidates.

**Real finding from the same run: Tiingo ticker-tagging noise.**
Several of the 10 fetched articles (English speakers watching World
Cup broadcasts in Spanish, a Disney+ free-tier rumor, Netflix
removing a series) were tagged by Tiingo's own `tickers[]` field as
"arb" despite having zero textual connection to Arbitrum. The
pipeline was NOT broken by this - Claude correctly ignored all of it
and cited only the genuinely relevant article - but the underlying
trust assumption (ADR-017: trust Tiingo's own tag outright when it
matches) turned out to be too permissive for short/ambiguous symbols.

**Fix:** `newsIngestion.ts` now requires BOTH signals to agree -
Tiingo's tag is trusted as `ticker_specific` only when
`classifyNewsScope()` (text-based) also doesn't classify the article
as `unrelated`. Separately, `scopeClassifier.ts`'s text matching was
upgraded from plain substring (`text.includes(alias)`) to word-
boundary matching, since a short symbol like "arb" as a raw substring
would itself false-positive inside unrelated words ("barbecue",
"carburetor") - this matters more now that the classifier also serves
as the corroboration check for Tiingo's tagging, not just a
standalone fallback.

**Why this is worth fixing even though the LLM already handled it
correctly:** relying on Claude's judgment to always catch upstream
data-quality noise is a weaker guarantee than filtering it out before
it ever reaches the prompt - a future case (a mistagged article that
happens to be topically plausible-sounding) could pass Claude's
judgment where these obviously-irrelevant ones didn't. Filtering
noise at ingestion is more robust than trusting the LLM to always
notice it, per the same philosophy behind the grounding verifier
itself (don't rely on model judgment where a deterministic check is
possible).

**Status:** Implemented (`src/news/newsIngestion.ts`,
`src/news/scopeClassifier.ts`). Not yet re-tested live with this fix
in place - next ARB-USD (or similar short-symbol ticker) run should
show a cleaner candidate list with the unrelated articles filtered
out entirely, without changing the outcome (which was already
correct).

---



## ADR-022: The ADR-021 word-boundary fix had its own bug - ticker symbol vs. coin name mismatch

**Context:** the user asked a sharp question right after ADR-021
shipped: "the ticker symbol and the coin name can be different - won't
requiring text corroboration now wrongly discard valid news that only
uses the coin's full name?" This turned out to be a real bug in the
fix just made, not just a hypothetical.

**What went wrong:** ADR-021's word-boundary regex (`\bsymbol\b`)
correctly stops "arb" from false-matching inside unrelated words like
"barbecue" - but it ALSO stops "arb" from matching as a substring
inside **"Arbitrum"** itself, since there's no word boundary between
"arb" and "itrum" (both are word characters, so `\b` doesn't fire
there). ADR-021's own reasoning claimed "real arbitrum articles will
pass text classification too since arb is a substring of arbitrum" -
that claim was simply wrong once word-boundary matching replaced plain
substring matching. An article that only ever says "Arbitrum" and
never abbreviates to "ARB" would have been wrongly discarded as
`unrelated` by the ADR-021 fix, for exactly the ticker-vs-coin-name
mismatch reason the user identified.

**Fix:** expanded `fullNameMap` in `scopeClassifier.ts` from 3 entries
(btc, eth, sol) to cover every ticker this project currently has a
price estimate for: dot->polkadot, ada->cardano, avax->avalanche,
link->chainlink, doge->dogecoin, matic->polygon, arb->arbitrum,
xrp->ripple. Each ticker's aliases now include both the raw symbol and
its full project/coin name, so word-boundary matching works correctly
against either form.

**Known residual limitation, stated honestly:** this is still a
hand-maintained lookup table, not a general solution - any ticker NOT
in this map, whose coin name doesn't happen to contain the symbol as a
literal whole word, would still be vulnerable to the same bug for a
new/uncommon ticker this project hasn't been tested against yet.
Extending `fullNameMap` is a manual step required whenever a new
ticker is added to this project, not something that happens
automatically. A more complete solution (e.g. a maintained
symbol-to-name lookup service, or leaning more on Tiingo's own tagging
with a lighter-touch sanity check rather than requiring full text
corroboration) is a reasonable future improvement if this keeps
recurring, but the current fix directly addresses every ticker this
project actually uses today.

**Lesson for the log:** this is the second time in this project a fix
for one live-testing finding (ADR-011->012, and now ADR-021->022)
needed a second pass because the first fix's own reasoning had a gap.
Worth double-checking a fix's own claimed correctness against a
concrete counterexample (as the user did here) rather than accepting
"this should also handle X" without testing it.

**Status:** Implemented and confirmed live (`src/news/scopeClassifier.ts`).
Re-running ARB-USD after the fix showed exactly the intended result:
the same 8 irrelevant articles (World Cup, Disney+, Netflix) that
previously came through as false-positive `ticker_specific` matches
are now correctly filtered out entirely - the candidate pool went
from 10 articles (1 relevant, 8 noise) down to exactly 1 (the correct
Robinhood Chain article), with the same correct explanation and
confidence (0.57) as before the fix. Noise removed, outcome
unchanged - the fix worked as designed.

---



## ADR-023: Cost and correctness sweep - six changes, one review

**Context:** with the core pipeline validated end-to-end (ADR-021),
did a deliberate review of where money and correctness could both
improve, now that there was real live-test evidence to reason from
rather than speculation. Six changes, ranked by actual impact rather
than implemented in arbitrary order:

**1. Per-ticker anomaly cooldown** (`src/detector/anomalyCooldown.ts`)
- the single highest-impact change. EWMA/MAD fires once per TICK past
  threshold, not once per real-world event - a sustained pump could
  fire the full news+sentiment+Claude pipeline dozens of times for one
  causal event. Firestore-backed (multi-instance safe), 15-min window,
  tier escalation always breaks through (a genuinely bigger move is
  never suppressed).

**2. Deterministic skip when nothing is fetchable** - with zero news
AND zero sentiment, the only valid outcome is an honest
`no_clear_cause` with empty citations (there's nothing else to cite) -
synthesized directly, no Claude call. This was literally the DOT-USD
test case from live testing.

**3. News cache + URL dedup** (`src/news/newsCache.ts`) - fixed two
problems: no caching at all (re-fetched every anomaly), and a real
event-sourcing smell (the same article getting a fresh `event_id`
every fetch, meaning five anomalies on one ticker could store the same
article five times under five different ids). 20-min TTL, URL-hash
index for cross-fetch dedup.

**4. Explanation reuse cache** (`src/agent/explanationCache.ts`) -
keyed on ticker + direction + tier + the exact sorted candidate
event_id set. Complements #1 rather than duplicating it: cooldown
handles "same event, many ticks"; this handles two genuinely separate
anomalies (e.g. after a cooldown window lapsed) still explained by
identical underlying data. Reused explanations get a fresh event_id
and point at the new anomaly - never reuse the cached event's own id.

**5. Prompt caching** (`src/agent/explanationAgent.ts`) - split the
prompt into a stable, cacheable context block (anomaly + news +
sentiment - identical across retry attempts) and a variable suffix
(feedback + closing instructions). Also cached the tool schema itself,
since it's identical across every call regardless of ticker. Benefits
the retry loop most (up to 4 calls per large-tier anomaly), where
attempts 2+ now pay roughly cache-read pricing instead of full input.

**6. Model routing by tier** (`anomalyTiering.ts`) - medium tier
(bulk of volume, one-shot, bounded citation task) routes to Haiku 4.5;
large tier (retry loop, highest fabrication-risk stakes) keeps the
more capable model. Same tier-to-behavior pattern already used for
`maxRetries`, applied to model choice.

**What was deliberately NOT done:** Redis/Memorystore - starts at
$35+/month, more expensive than this project's most expensive existing
dependency (Tiingo Power, $30/month), for a workload Firestore already
handles fine at this scale (same reasoning as ADR-007's sentiment
cache). An in-memory LRU cache was also rejected - Cloud Run can scale
`agent-svc` to multiple instances, and a per-instance cache doesn't
share state across them, the same problem ADR-007 already solved by
going Firestore-backed instead.

**Status:** All six implemented and typechecked clean, delivered as
six separate git commits (one per change) for a clean, reviewable
history. Not yet exercised against live production traffic - the
cooldown and caching behaviors in particular would benefit from being
watched under a real sustained anomaly to confirm the suppression
logic behaves as designed, not just as unit-reasoned.

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
- **Daily trending snapshot** (`GET /reddit/crypto/v1/trending`) -
  cache once/day globally (same pattern as market-wide sentiment: one
  shared global key, not per-ticker, so cost is ~30 calls/month
  regardless of ticker count - free tier is 250/month). Two intended
  uses: (1) feed into the explanation prompt as ambient corroborating
  context (e.g. "BTC is #2 on Reddit trending" alongside the existing
  news/sentiment candidates), and (2) a feature for the deferred
  backtesting/news-impact-study batch layers - "was this ticker
  trending the day of/before the anomaly?" as a signal to test against
  outcomes later. New event type (`TrendingSnapshotIngested`, kept
  separate from the sentiment snapshot since it's a ranked list, not a
  single reading), stored in the event store same as everything else.
  Not started.

## Open verification items (schema confirmed from spec, not yet exercised live)

- `src/news/newsIngestion.ts` - endpoint and schema now confirmed
  directly from Tiingo's own documentation page (ADR-017):
  `GET /tiingo/news`. Field names (`title`, `description`, `url`,
  `publishedDate`, `tickers[]`, etc.) come from Tiingo's published
  docs, not a live response yet - same caveat pattern as Adanos before
  ADR-013 validated it live.
- `src/sentiment/sentimentIngestion.ts` - **validated live** (ADR-013):
  real XRP response confirmed the schema matches exactly. The
  Adanos side of this project is the one integration that's actually
  been proven end-to-end against a real response, not just a spec.
- Use `src/eval/testLiveExternalApis.ts` (single-call-per-API smoke
  test, no Firestore/Pub-Sub side effects) to verify Tiingo against a
  real response before relying on it in production - this is now the
  one remaining unverified external integration.
