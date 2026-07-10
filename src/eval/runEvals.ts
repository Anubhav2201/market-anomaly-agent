/**
 * Eval harness: replays historical scenarios through the REAL pipeline
 * (real prompt construction, real Claude call, real grounding
 * verification, real confidence scoring) and scores outputs against
 * documented ground truth.
 *
 * What this measures, per scenario:
 *   1. claim_correct    - did the claim match an accepted ground-truth label?
 *   2. citations_correct - did it cite (at least one of) the right articles,
 *                          and nothing that wasn't in the correct set?
 *   3. structurally_grounded - did the citation pass existence+causality?
 *   4. honest_refusal    - for no_clear_cause scenarios: did it refuse to
 *                          force a connection? (subset of claim_correct,
 *                          reported separately because it's the hardest and
 *                          most important behavior)
 *   5. confidence_calibration - was composite confidence higher on correct
 *                          answers than incorrect ones? (reported as an
 *                          aggregate, needs multiple scenarios to mean much)
 *
 * COST NOTE: each scenario = 1 real Claude call (+1 optional Groq call).
 * With 3 seed scenarios that's ~$0.05/run on Sonnet. Fine to run
 * frequently; still worth knowing it's not free.
 *
 * Usage:
 *   export ANTHROPIC_API_KEY=sk-ant-...
 *   npx tsc --outDir dist && node dist/src/eval/runEvals.js
 */
import * as fs from "fs";
import * as path from "path";
import { v4 as uuidv4 } from "uuid";
import { EvalScenario } from "./types";
import { EventStore } from "../events/store";
import { GroundingVerifier } from "../agent/groundingVerifier";
import { generateExplanation } from "../agent/explanationAgent";
import {
  computeConfidence,
  temporalProximityScore,
} from "../signals/confidenceScorer";
import { checkSentimentCoherence } from "../signals/sentimentCoherence";
import {
  NewsArticleIngested,
  PriceAnomalyDetected,
} from "../events/types";

interface ScenarioResult {
  scenario_id: string;
  claim_returned: string;
  claim_correct: boolean;
  citations_returned: string[];
  citations_correct: boolean;
  structurally_grounded: boolean;
  composite_confidence: number;
  is_no_cause_scenario: boolean;
  honest_refusal: boolean | null; // null when not a no_clear_cause scenario
}

/** Loose claim matching: normalize and check substring overlap both ways,
 * because the model won't produce exact label strings. */
function claimMatches(returned: string, accepted: string[]): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  const r = norm(returned);
  return accepted.some((a) => {
    const n = norm(a);
    return r.includes(n) || n.includes(r);
  });
}

async function runScenario(scenario: EvalScenario): Promise<ScenarioResult> {
  // Build an isolated event store per scenario - each replay starts clean.
  const store = new EventStore();
  const verifier = new GroundingVerifier(store);

  const anomalyTimestamp = Date.now();

  // Materialize candidate news as real events with the scenario's stable
  // ids as event_ids (so ground-truth citation ids are directly comparable).
  const candidateNews: NewsArticleIngested[] = scenario.candidate_news.map(
    (n) => ({
      type: "NewsArticleIngested",
      event_id: n.id,
      ticker: scenario.ticker,
      timestamp: anomalyTimestamp - n.minutes_before_anomaly * 60 * 1000,
      headline: n.headline,
      summary: n.summary,
      source: n.source,
      url: n.url,
      scope: n.scope,
    })
  );
  candidateNews.forEach((n) => store.append(n));

  const anomaly: PriceAnomalyDetected = {
    type: "PriceAnomalyDetected",
    event_id: uuidv4(),
    ticker: scenario.ticker,
    timestamp: anomalyTimestamp,
    price: scenario.anomaly.price,
    price_direction: scenario.anomaly.price_direction,
    price_z_score: scenario.anomaly.price_z_score,
    volume_z_score: scenario.anomaly.volume_z_score,
    rolling_mean: 0,
    rolling_mad: 0.001,
    recent_price_context: [],
  };
  store.append(anomaly);

  // === THE REAL PIPELINE ===
  const explanation = await generateExplanation({
    anomaly,
    recentTicks: [],
    candidateNews,
  });
  store.append(explanation);

  const verdict = verifier.verifyStructural(explanation);
  store.append(verdict);

  // Confidence signals (same computation as grounding-svc, minus the
  // news-volume tracker which needs a baseline history a single replay
  // doesn't have - treated as no-spike, the conservative default).
  const citedArticles = explanation.cited_event_ids
    .map((id) => candidateNews.find((n) => n.event_id === id))
    .filter((a): a is NewsArticleIngested => !!a);

  const sentimentResults = citedArticles.map((a) =>
    checkSentimentCoherence(a, anomaly.price_direction)
  );
  const confidence = computeConfidence({
    structurallyGrounded: verdict.structurally_grounded,
    newsVolumeSpike: false,
    sentimentCoherent:
      sentimentResults.length === 0
        ? null
        : sentimentResults.every((r) => r.isCoherent),
    sourceCount: new Set(citedArticles.map((a) => a.source)).size,
    proximityScore:
      citedArticles.length === 0
        ? 0
        : citedArticles.reduce(
            (s, a) => s + temporalProximityScore(a.timestamp, anomaly.timestamp),
            0
          ) / citedArticles.length,
    semanticSupport: null, // keep eval runs free of Groq dependency
    tickerSpecificFraction:
      citedArticles.length === 0
        ? 0
        : citedArticles.filter((a) => a.scope === "ticker_specific").length /
          citedArticles.length,
  });

  // === SCORING ===
  const gt = scenario.ground_truth;
  const isNoCause = gt.accepted_claims.includes("no_clear_cause");

  const claim_correct = claimMatches(explanation.claim, gt.accepted_claims);

  // Citations correct: for no_clear_cause, must be empty. Otherwise, at
  // least one returned citation must be in the correct set AND no
  // returned citation may be outside it (citing a distractor = wrong,
  // even alongside a correct citation).
  let citations_correct: boolean;
  if (isNoCause) {
    citations_correct = explanation.cited_event_ids.length === 0;
  } else {
    const correctSet = new Set(gt.correct_citation_ids);
    const anyCorrect = explanation.cited_event_ids.some((id) =>
      correctSet.has(id)
    );
    const noneWrong = explanation.cited_event_ids.every((id) =>
      correctSet.has(id)
    );
    citations_correct =
      explanation.cited_event_ids.length > 0 && anyCorrect && noneWrong;
  }

  return {
    scenario_id: scenario.scenario_id,
    claim_returned: explanation.claim,
    claim_correct,
    citations_returned: explanation.cited_event_ids,
    citations_correct,
    structurally_grounded: verdict.structurally_grounded,
    composite_confidence: confidence.score,
    is_no_cause_scenario: isNoCause,
    honest_refusal: isNoCause ? claim_correct && citations_correct : null,
  };
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is required to run evals (each scenario is a real Claude call).");
    process.exit(1);
  }

  const dataPath = path.join(__dirname, "../../../eval-data/scenarios.json");
  const scenarios: EvalScenario[] = JSON.parse(fs.readFileSync(dataPath, "utf-8"));
  console.log(`Running ${scenarios.length} eval scenarios...\n`);

  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    console.log(`--- ${scenario.scenario_id} ---`);
    try {
      const result = await runScenario(scenario);
      results.push(result);
      console.log(`  claim: "${result.claim_returned}" -> ${result.claim_correct ? "CORRECT" : "WRONG"}`);
      console.log(`  citations: [${result.citations_returned.join(", ")}] -> ${result.citations_correct ? "CORRECT" : "WRONG"}`);
      console.log(`  grounded: ${result.structurally_grounded}, confidence: ${result.composite_confidence.toFixed(2)}`);
      if (result.honest_refusal !== null) {
        console.log(`  honest refusal (no_clear_cause test): ${result.honest_refusal ? "PASSED" : "FAILED"}`);
      }
    } catch (err) {
      console.error(`  ERROR:`, err);
    }
    console.log("");
  }

  // === AGGREGATE REPORT ===
  const total = results.length;
  const claimCorrect = results.filter((r) => r.claim_correct).length;
  const citationsCorrect = results.filter((r) => r.citations_correct).length;
  const grounded = results.filter((r) => r.structurally_grounded || r.is_no_cause_scenario).length;
  const noCauseTests = results.filter((r) => r.is_no_cause_scenario);
  const honestRefusals = noCauseTests.filter((r) => r.honest_refusal).length;

  const correctConfidences = results.filter((r) => r.claim_correct && r.citations_correct).map((r) => r.composite_confidence);
  const incorrectConfidences = results.filter((r) => !(r.claim_correct && r.citations_correct)).map((r) => r.composite_confidence);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

  console.log("=== EVAL SUMMARY ===");
  console.log(`claims correct:      ${claimCorrect}/${total}`);
  console.log(`citations correct:   ${citationsCorrect}/${total}`);
  console.log(`structurally sound:  ${grounded}/${total}`);
  console.log(`honest refusals:     ${honestRefusals}/${noCauseTests.length} (no_clear_cause scenarios)`);
  console.log(
    `confidence calibration: avg on correct=${avg(correctConfidences).toFixed(2)}, avg on incorrect=${avg(incorrectConfidences).toFixed(2)}` +
      (correctConfidences.length && incorrectConfidences.length
        ? avg(correctConfidences) > avg(incorrectConfidences)
          ? " (correctly ordered)"
          : " (MISCALIBRATED - confidence higher on wrong answers)"
        : " (need both correct and incorrect results to assess)")
  );
  console.log(
    "\nNOTE: with only " + total + " scenarios, treat these numbers as smoke-test\n" +
      "signal, not statistics. The dataset is designed to grow: add real\n" +
      "cases from your deployed pipeline's Firestore log as you manually\n" +
      "judge them, and more documented historical events over time."
  );
}

main();
