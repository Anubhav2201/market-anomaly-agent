# Eval Dataset Guide

## What this is

`scenarios.json` is the ground-truth dataset for the eval harness
(`src/eval/runEvals.ts`). Each scenario is a historical (or manually
judged live) anomaly with a documented real cause, replayed through the
REAL pipeline and scored against the answer key.

Current size: 3 seed scenarios. **This is a smoke test, not statistics.**
The value comes from growing it — target 15-20+ scenarios before
treating the aggregate numbers as meaningful.

## How to add a scenario

### Source 1: documented historical events
Pick a well-documented crypto price event (exchange collapse, hack, ETF
decision, regulatory action). Requirements:
- The cause must be **publicly documented by reputable sources** (cite
  them in `ground_truth.documentation`)
- Reconstruct the news that existed **before** the price move (check
  article publication timestamps carefully — citing an article published
  after the move is exactly the causality bug the system is designed to
  catch, don't bake it into the answer key)
- Include at least one **distractor** article (real-looking but
  irrelevant) — scenarios where every candidate is correct don't test
  anything

### Source 2: your own deployed pipeline (the sustainable source)
Once deployed, every anomaly + explanation + verdict is in Firestore.
Periodically review them:
1. Query recent `ExplanationGenerated` events
2. Manually judge: was the claim right? Were the citations right?
3. Convert judged cases into scenarios (the candidate news is already
   in the event log with correct timestamps — no reconstruction needed)

This makes the eval set grow from real production behavior, which is
worth more than synthetic scenarios.

### Always include no_clear_cause tests
The hardest, most important behavior is **honest refusal** — reporting
`no_clear_cause` when the candidates genuinely don't explain the move,
instead of forcing a connection. Keep roughly 1 in 4 scenarios as
refusal tests (only distractor candidates available). A system that
always finds "a cause" is worse than useless for this project's purpose.

## Scoring rules (see runEvals.ts)

- **claim_correct**: normalized substring match against
  `accepted_claims` — list several phrasings, the model won't produce
  exact labels
- **citations_correct**: at least one correct citation AND zero
  incorrect ones — citing a distractor alongside a correct article
  still fails, deliberately
- **honest_refusal**: for no_clear_cause scenarios only — claim AND
  empty citations both required

## Cost per run

Each scenario = 1 real Claude call (~$0.01-0.02 on Sonnet). The Groq
semantic check is deliberately excluded from eval runs to keep them
dependency-light.
