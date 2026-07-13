# GCP Deployment Guide

Covers all five services: `ingestion-svc`, `detector-svc`, `agent-svc`,
`grounding-svc`, `fanout-svc`.

## Prerequisites

```bash
gcloud config set project YOUR_PROJECT_ID
gcloud services enable run.googleapis.com pubsub.googleapis.com firestore.googleapis.com secretmanager.googleapis.com

# Firestore database (Native mode)
gcloud firestore databases create --location=us-central1

# Pub/Sub topics - one per stage of the pipeline
gcloud pubsub topics create price-ticks
gcloud pubsub topics create anomalies
gcloud pubsub topics create explanations
gcloud pubsub topics create alerts

# Secrets (safer than plain env vars for anything beyond local testing)
echo -n "$ANTHROPIC_API_KEY" | gcloud secrets create anthropic-api-key --data-file=-
echo -n "$TIINGO_API_KEY" | gcloud secrets create tiingo-api-key --data-file=-   # REQUIRED - Power plan, see DECISIONS.md ADR-017/018
echo -n "$GROQ_API_KEY" | gcloud secrets create groq-api-key --data-file=-       # optional
echo -n "$ADANOS_API_KEY" | gcloud secrets create adanos-api-key --data-file=-   # optional

# Service account for Pub/Sub push auth (one-time)
gcloud iam service-accounts create pubsub-invoker
```

## Deploy ingestion-svc

Needs `min-instances=1` — holds a persistent websocket connection, can't
scale to zero.

```bash
cd market-anomaly-agent   # repo root

gcloud run deploy ingestion-svc \
  --source=. \
  --dockerfile=services/ingestion-svc/Dockerfile \
  --region=us-central1 \
  --min-instances=1 \
  --max-instances=1 \
  --no-allow-unauthenticated
```

## Deploy detector-svc

Capped at `max-instances=1` — its anomaly baseline is in-memory state
per ticker; Pub/Sub push doesn't guarantee the same instance sees every
tick for a given ticker. Sharding by ticker across instances is a real
scaling improvement for later, not solved yet.

```bash
gcloud run deploy detector-svc \
  --source=. \
  --dockerfile=services/detector-svc/Dockerfile \
  --region=us-central1 \
  --max-instances=1 \
  --no-allow-unauthenticated
```

## Deploy agent-svc

Stateless — safe to let this scale normally.

```bash
gcloud run deploy agent-svc \
  --source=. \
  --dockerfile=services/agent-svc/Dockerfile \
  --region=us-central1 \
  --set-secrets=ANTHROPIC_API_KEY=anthropic-api-key:latest,ADANOS_API_KEY=adanos-api-key:latest \
  --no-allow-unauthenticated
```
(`ADANOS_API_KEY` is optional — sentiment fetch just gets skipped
without it.)

## Deploy grounding-svc

Also stateless (its news-volume baseline resets on cold start —
acceptable tradeoff, noted in source).

```bash
gcloud run deploy grounding-svc \
  --source=. \
  --dockerfile=services/grounding-svc/Dockerfile \
  --region=us-central1 \
  --set-secrets=GROQ_API_KEY=groq-api-key:latest \
  --no-allow-unauthenticated
```
(`GROQ_API_KEY` optional — semantic check gets skipped without it.)

## Deploy fanout-svc

Stateless, no external API keys needed (reads Subscriptions from
Firestore).

```bash
gcloud run deploy fanout-svc \
  --source=. \
  --dockerfile=services/fanout-svc/Dockerfile \
  --region=us-central1 \
  --no-allow-unauthenticated
```

## Wire all four push subscriptions

```bash
DETECTOR_URL=$(gcloud run services describe detector-svc --region=us-central1 --format='value(status.url)')
AGENT_URL=$(gcloud run services describe agent-svc --region=us-central1 --format='value(status.url)')
GROUNDING_URL=$(gcloud run services describe grounding-svc --region=us-central1 --format='value(status.url)')
FANOUT_URL=$(gcloud run services describe fanout-svc --region=us-central1 --format='value(status.url)')

for SVC in detector-svc agent-svc grounding-svc fanout-svc; do
  gcloud run services add-iam-policy-binding $SVC \
    --region=us-central1 \
    --member="serviceAccount:pubsub-invoker@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
    --role="roles/run.invoker"
done

gcloud pubsub subscriptions create price-ticks-sub \
  --topic=price-ticks --push-endpoint="${DETECTOR_URL}/pubsub/push" \
  --push-auth-service-account="pubsub-invoker@YOUR_PROJECT_ID.iam.gserviceaccount.com"

gcloud pubsub subscriptions create anomalies-sub \
  --topic=anomalies --push-endpoint="${AGENT_URL}/pubsub/push" \
  --push-auth-service-account="pubsub-invoker@YOUR_PROJECT_ID.iam.gserviceaccount.com"

gcloud pubsub subscriptions create explanations-sub \
  --topic=explanations --push-endpoint="${GROUNDING_URL}/pubsub/push" \
  --push-auth-service-account="pubsub-invoker@YOUR_PROJECT_ID.iam.gserviceaccount.com"

gcloud pubsub subscriptions create alerts-sub \
  --topic=alerts --push-endpoint="${FANOUT_URL}/pubsub/push" \
  --push-auth-service-account="pubsub-invoker@YOUR_PROJECT_ID.iam.gserviceaccount.com"
```

## Seeding a test subscription

Before `fanout-svc` has anything to fan out to, you need at least one
subscription in Firestore. Quickest way for testing — a small one-off
script:

```bash
node -e "
const { SubscriptionsStore } = require('./dist/src/subscriptions/subscriptionsStore');
const store = new SubscriptionsStore();
store.create({
  user_id: 'test-user-1',
  ticker: 'BTC-USD',
  price_z_threshold: 3.0,
  volume_z_threshold: 2.0,
  debounce_ms: 5 * 60 * 1000,
}).then(sub => console.log('created:', sub));
"
```

## Verify the full pipeline

```bash
gcloud run services logs read ingestion-svc --region=us-central1 --limit=10
gcloud run services logs read detector-svc --region=us-central1 --limit=10
gcloud run services logs read agent-svc --region=us-central1 --limit=10
gcloud run services logs read grounding-svc --region=us-central1 --limit=10
gcloud run services logs read fanout-svc --region=us-central1 --limit=10
```

You should see, in order: ticks flowing, an anomaly detected and
persisted, a claim generated by Claude, a composite confidence score
computed, and (if you seeded a subscription above) a delivery log line
naming the test user.

## Free tier / cost checklist

```bash
gcloud billing budgets create --billing-account=YOUR_BILLING_ACCOUNT \
  --display-name="market-anomaly-agent" --budget-amount=30USD
```

- `ingestion-svc` (min-instances=1) is the one continuously-running
  cost — a few dollars/month. Everything else scales to zero between
  events.
- Firestore: `SubscriptionsStore` and `SentimentIngestion` both cache
  aggressively (5 min and 60 min respectively) specifically to avoid
  per-tick/per-anomaly Firestore reads that would blow through the free
  tier.
- Adanos sentiment: 250 requests/month total — the hourly Firestore
  cache is load-bearing here, not optional. Don't remove it.
- Claude API is the main variable cost — see the earlier cost breakdown
  in this project's design history (~$10-35/month at modest trigger
  volume).

## What's genuinely NOT built yet

- Eval harness (deliberately deferred)
- Real delivery channel in fanout-svc (currently logs only)
- Dashboard/UI
- Ticker-sharded scaling for detector-svc beyond a single instance

## Pushing this to GitHub

```bash
# Create a new repo on github.com first (via the web UI or `gh repo create`), then:
git remote add origin https://github.com/YOUR_USERNAME/market-anomaly-agent.git
git branch -M main
git push -u origin main
```

The commit history is intentionally kept as real, incremental commits
(not squashed) — each one is a genuine step in how this was actually
built, which is worth preserving if you're using this repo as a
portfolio piece.
