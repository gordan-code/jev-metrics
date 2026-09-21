import { test } from "node:test";
import assert from "node:assert/strict";
import { MetricsStore } from "../src/store.js";
import { buildCalibrationReport, collectSamples, detectRubricDrift, buildReliabilityDiagram, computeECE, type CalibrationBucket } from "../src/calibration.js";
import { buildMetricsReport, buildTimeSeries, renderMarkdownReport } from "../src/report.js";
import type { Evaluation, MetricKey } from "../src/types.js";

function bareEvaluation(score: number, confidence: number, applicableMetrics: MetricKey[] = ["correctness", "security"]): Evaluation {
  const metrics = {} as Evaluation["metrics"];
  for (const k of applicableMetrics) {
    metrics[k] = { applicable: true, score, confidence };
  }
  for (const k of ["performance", "scalability", "compatibility", "observability"] as MetricKey[]) {
    if (!applicableMetrics.includes(k)) {
      metrics[k] = { applicable: false };
    }
  }
  return { metrics, priorities: [] };
}

test("store persists and reads an evaluation", () => {
  const store = new MetricsStore(":memory:");
  const ev = bareEvaluation(7.2, 0.85);
  store.recordEvaluation({ key: "k1", repo: "a/b", commit: "abc", kind: "baseline" }, ev, { task: "x" });
  const got = store.getEvaluation("k1");
  assert.ok(got);
  assert.equal(got.key, "k1");
  assert.equal(got.evaluation.metrics["correctness"]?.score, 7.2);
  assert.equal(store.countOf("evaluations"), 1);
  store.close();
});

test("recordEvaluation upserts on matching key", () => {
  const store = new MetricsStore(":memory:");
  store.recordEvaluation({ key: "k" }, bareEvaluation(5, 0.6));
  store.recordEvaluation({ key: "k" }, bareEvaluation(8, 0.9));
  assert.equal(store.countOf("evaluations"), 1);
  store.close();
});

test("outcome requires a recorded evaluation", () => {
  const store = new MetricsStore(":memory:");
  assert.throws(() => store.recordOutcome({ evaluationKey: "missing", faulty: true }), /No evaluation recorded/);
  store.close();
});

test("calibration buckets and false-confidence detection", () => {
  const ev1 = bareEvaluation(8.5, 0.95); // high score, high conf -> should be clean
  const ev2 = bareEvaluation(8.5, 0.95); // same but outcome marks it FAULTY -> false confidence
  const ev3 = bareEvaluation(3.0, 0.6); // low conf, low score, faulty
  const evs = [
    { key: "a", evaluation: ev1 },
    { key: "b", evaluation: ev2 },
    { key: "c", evaluation: ev3 }
  ];
  const outcomes = [
    { evaluationKey: "a", metric: "correctness" as MetricKey, faulty: false },
    { evaluationKey: "b", metric: "correctness" as MetricKey, faulty: true },
    { evaluationKey: "c", metric: "security" as MetricKey, faulty: true }
  ];
  const cal = buildCalibrationReport(evs, outcomes);
  // False confidence = score>=7 & conf>=0.8 & faulty -> only "b"@correctness
  assert.equal(cal.falseConfidence.length, 1);
  assert.equal(cal.falseConfidence[0]!.evaluationKey, "b");
  // 0.95 bucket should contain a & b (correctness), 0.6 bucket c (security)
  const high = cal.buckets.find((b) => b.label === "0.9–1.0")!;
  assert.equal(high.count, 2);
  assert.equal(high.faultyCount, 1);
  const low = cal.buckets.find((b) => b.label === "0.6–0.7")!;
  assert.equal(low.count, 1);
  // Per-metric coverage shows "correctness" carrying the high-confidence samples.
  const correctnessStats = cal.byMetric.find((m) => m.metric === "correctness")!;
  assert.equal(correctnessStats.samples, 2);
  assert.equal(correctnessStats.faultRate, 0.5);
});

test("collectSamples collapses multiple markers to a faulty verdict", () => {
  const evs = [{ key: "a", evaluation: bareEvaluation(7, 0.85) }];
  const { metricSamples } = collectSamples(
    evs,
    [
      { evaluationKey: "a", metric: "correctness", faulty: false },
      { evaluationKey: "a", metric: "correctness", faulty: true }
    ],
    {}
  );
  const correctness = metricSamples.find((s) => s.metric === "correctness");
  assert.ok(correctness);
  assert.equal(correctness.faulty, true);
});

test("time series and delta computation", () => {
  const store = new MetricsStore(":memory:");
  store.recordEvaluation({ key: "1", repo: "r", kind: "baseline" }, bareEvaluation(6, 0.7));
  store.recordEvaluation({ key: "2", repo: "r", kind: "rescore" }, bareEvaluation(8, 0.9));
  const evs = store.listEvaluations("r");
  const trend = buildMetricsReport(evs, []).trend;
  const correctness = trend.find((t) => t.metric === "correctness")!;
  assert.deepEqual(correctness.values, [6, 8]);
  assert.equal(correctness.deltaFromFirst, 2);
  store.close();
});

test("markdown report renders", () => {
  const store = new MetricsStore(":memory:");
  store.recordEvaluation({ key: "x", repo: "r" }, bareEvaluation(7, 0.8));
  store.recordOutcome({ evaluationKey: "x", metric: "correctness", faulty: false });
  const report = buildMetricsReport(store.listEvaluations(), store.listOutcomes());
  const md = renderMarkdownReport(report);
  assert.match(md, /# Jev Metrics Report/);
  assert.match(md, /## Calibration audit/);
  assert.match(md, /## Score trend/);
  store.close();
});

test("time series only counts applicable metrics", () => {
  const trend = buildTimeSeries([
    { id: 1, key: "a", recordedAt: "t", evaluation: bareEvaluation(7, 0.8, ["correctness"]) } as any,
    { id: 2, key: "b", recordedAt: "t", evaluation: bareEvaluation(5, 0.6, ["security"]) } as any
  ]);
  const correctness = trend.find((t) => t.metric === "correctness")!;
  // In record "b" correctness is not applicable, so second cell is undefined
  assert.deepEqual(correctness.values, [7, undefined]);
});

test("rubric drift flags a metric whose score rose but fault rate stayed high", () => {
  // 6 samples of "security": early rounds low score+low faults, late rounds HIGH score but STILL faulty
  const samples = [
    // early: score 5.x, low fault rate
    mk("security", 5.0, true, 0), mk("security", 5.2, false, 1), mk("security", 5.4, true, 2),
    // late: score 8.x but faults persist => drift signal
    mk("security", 8.0, true, 3), mk("security", 8.5, true, 4), mk("security", 8.9, true, 5)
  ];
  const drift = detectRubricDrift(samples);
  const security = drift.find((d) => d.metric === "security")!;
  assert.equal(security.flag, "drift");
  assert.ok(security.scoreRise >= 0.5);
  assert.ok(security.faultRate >= 0.35);
});

test("rubric drift does NOT flag a metric that rose AND cleared its faults", () => {
  const samples = [
    mk("testQuality", 4.0, true, 0), mk("testQuality", 4.5, true, 1), mk("testQuality", 5.0, true, 2),
    // late: high score, no faults => healthy improvement
    mk("testQuality", 7.5, false, 3), mk("testQuality", 8.0, false, 4), mk("testQuality", 8.5, false, 5)
  ];
  const drift = detectRubricDrift(samples);
  const tq = drift.find((d) => d.metric === "testQuality")!;
  // score rose >= 0.5 but fault rate dropped below 0.35 => "rising-inconclusive" (not "drift")
  assert.notEqual(tq.flag, "drift");
});

test("reliability diagram and ECE reward a well-calibrated bucket set", () => {
  // Buckets where high confidence buckets have low fault rate and small gap => low ECE
  const buckets: CalibrationBucket[] = [
    { low: 0.6, label: "0.6–0.7", count: 10, faultyCount: 8, faultyRate: 0.8, insufficient: false },
    { low: 0.9, label: "0.9–1.0", count: 10, faultyCount: 1, faultyRate: 0.1, insufficient: false }
  ];
  const rel = buildReliabilityDiagram(buckets);
  // monotonic: 0.9 bucket fault prob (0.1) < 0.6 bucket (0.8) => true
  assert.equal(rel.monotonicUphill, true);
  // rank correlation positive
  assert.ok(rel.rankCorrelation > 0);
  const ece = computeECE(rel.buckets);
  assert.ok(ece > 0 && ece < 1);
});

test("poorly calibrated buckets get high ECE / non-monotonic flag", () => {
  // 0.6 bucket clean but 0.9 bucket faulty => confidence is misleading
  const buckets: CalibrationBucket[] = [
    { low: 0.6, label: "0.6–0.7", count: 10, faultyCount: 1, faultyRate: 0.1, insufficient: false },
    { low: 0.9, label: "0.9–1.0", count: 10, faultyCount: 9, faultyRate: 0.9, insufficient: false }
  ];
  const rel = buildReliabilityDiagram(buckets);
  assert.equal(rel.monotonicUphill, false);
  assert.ok(rel.rankCorrelation < 0);
});

// helper: build a ConfidenceSample with roundIndex
function mk(metric: MetricKey, score: number, faulty: boolean, roundIndex: number) {
  return {
    metric,
    evaluationKey: "k" + roundIndex,
    confidence: 0.8 + roundIndex * 0.01,
    score,
    faulty,
    roundIndex
  };
}