import {
  METRIC_KEYS,
  type Evaluation,
  type MetricKey,
  type MetricEvaluation,
  type OutcomeInput
} from "./types.js";

/**
 * Calibration auditing for Jev quality scores.
 *
 * Core idea: Jev claims calibrated confidence — a dimension scored at high
 * confidence should be *right* at that confidence. In the quality-review
 * setting, "right" means *the change did not turn out to have a real problem
 * in that metric*. So a well-calibrated scorer should show: as confidence
 * rises, the observed fault rate falls.
 *
 * The most dangerous failure is **false confidence**: a metric scored high AND
 * at high confidence that later turned out to be genuinely faulty. That is the
 * case that would let both the coding agent and a human reviewer relax — and
 * get burned. We surface that explicitly.
 *
 * We compute two calibrations:
 *  - metric-level: uses outcomes that carry a `metric`.
 *  - change-level: uses key-only outcomes against the whole change.
 */

const MIN_BUCKET_COUNT = 3; // below this, we flag the bucket as "insufficient data"

export interface ConfidenceSample {
  metric: MetricKey;
  evaluationKey: string;
  confidence: number;
  score: number;
  faulty: boolean;
}

export interface CalibrationBucket {
  /** Inclusive low bound of the bucket. */
  low: number;
  label: string;
  count: number;
  faultyCount: number;
  faultyRate: number; // 0..1
  insufficient: boolean;
}

export interface FalseConfidenceEntry {
  metric: MetricKey;
  evaluationKey: string;
  score: number;
  confidence: number;
  issue?: string;
}

export interface MetricCalibrationStats {
  metric: MetricKey;
  samples: number;
  faultySamples: number;
  faultRate: number; // observed fault rate across samples
  minConf: number;
  maxConf: number;
}

export interface CalibrationReport {
  buckets: CalibrationBucket[];
  falseConfidence: FalseConfidenceEntry[];
  highConfidenceHeadline: {
    samples: number;
    faultySamples: number;
    faultyRate: number;
  };
  byMetric: MetricCalibrationStats[];
  changeLevel: {
    samples: number;
    faultyChanges: number;
    faultRate: number;
  };
  dataRichestMetrics: MetricKey[];
  dataSparseMetrics: MetricKey[]; // outcomes with little/no coverage
  summary: string;
}

interface SampleSource {
  evaluationKey: string;
  evaluation: Evaluation;
  metric: MetricKey;
  metricEval: MetricEvaluation;
}

export interface SampleOutcome {
  evaluationKey: string;
  metric?: string;
  faulty: number | boolean;
}

export function collectSamples(
  evaluations: Array<{ key: string; evaluation: Evaluation }>,
  outcomes: SampleOutcome[],
  opts: { includeChangeLevel?: boolean } = {}
): {
  metricSamples: ConfidenceSample[];
  changeSamples: { evaluationKey: string; faulty: boolean }[];
} {
  // For every eval+metric that received a metric-scoped outcome, collapse the
  // markers to a single fault verdict (a faulty marker dominates, safety-first).
  const metricFaultVerdict = new Map<string, boolean>(); // `${evalKey}|${metric}` -> faulty?
  for (const o of outcomes) {
    if (!o.metric) continue;
    const key2 = `${o.evaluationKey}|${o.metric}`;
    const prev = metricFaultVerdict.get(key2) ?? false;
    metricFaultVerdict.set(key2, prev || toBool(o.faulty));
  }

  const changeFaultVerdict = new Map<string, boolean>();
  if (opts.includeChangeLevel) {
    for (const o of outcomes) {
      if (o.metric) continue;
      const prev = changeFaultVerdict.get(o.evaluationKey) ?? false;
      changeFaultVerdict.set(o.evaluationKey, prev || toBool(o.faulty));
    }
  }

  const metricSamples: ConfidenceSample[] = [];
  const changeSamples: { evaluationKey: string; faulty: boolean }[] = [];

  for (const { key, evaluation } of evaluations) {
    for (const metricKey of METRIC_KEYS) {
      const me = evaluation.metrics?.[metricKey];
      if (!me?.applicable || me.score === undefined || me.confidence === undefined) continue;
      const faultKey = `${key}|${metricKey}`;
      if (!metricFaultVerdict.has(faultKey)) continue; // no metric-scoped outcome for this eval+metric
      metricSamples.push({
        metric: metricKey,
        evaluationKey: key,
        confidence: me.confidence,
        score: me.score,
        faulty: metricFaultVerdict.get(faultKey)!
      });
    }
    if (opts.includeChangeLevel && changeFaultVerdict.has(key)) {
      changeSamples.push({ evaluationKey: key, faulty: changeFaultVerdict.get(key)! });
    }
  }

  return { metricSamples, changeSamples };
}

export function buildCalibrationReport(
  evaluations: Array<{ key: string; evaluation: Evaluation }>,
  outcomes: OutcomeInput[]
): CalibrationReport {
  const { metricSamples, changeSamples } = collectSamples(evaluations, outcomes, {
    includeChangeLevel: true
  });

  // 1) Bucket by confidence
  const buckets: CalibrationBucket[] = [];
  const boundaries = [
    { low: 0.5, label: "0.5–0.6" },
    { low: 0.6, label: "0.6–0.7" },
    { low: 0.7, label: "0.7–0.8" },
    { low: 0.8, label: "0.8–0.9" },
    { low: 0.9, label: "0.9–1.0" }
  ];
  for (const b of boundaries) {
    const inBucket = metricSamples.filter(
      (s) => s.confidence >= b.low && s.confidence < b.low + 0.1
    );
    // The 0.9 bucket is closed on the right; higher is impossible (>1).
    const faultyCount = inBucket.filter((s) => s.faulty).length;
    const count = inBucket.length;
    buckets.push({
      low: b.low,
      label: b.label,
      count,
      faultyCount,
      faultyRate: count === 0 ? 0 : faultyCount / count,
      insufficient: count < MIN_BUCKET_COUNT
    });
  }

  // 2) False confidence: high score (>=7) AND high confidence (>=0.8) that was faulty
  const falseConfidence: FalseConfidenceEntry[] = [];
  let hcCount = 0;
  let hcFaulty = 0;
  for (const s of metricSamples) {
    if (s.confidence >= 0.8) {
      hcCount++;
      if (s.faulty) hcFaulty++;
    }
    if (s.score >= 7 && s.confidence >= 0.8 && s.faulty) {
      const evalRec = evaluations.find((e) => e.key === s.evaluationKey);
      const me = evalRec?.evaluation.metrics?.[s.metric];
      falseConfidence.push({
        metric: s.metric,
        evaluationKey: s.evaluationKey,
        score: s.score,
        confidence: s.confidence,
        issue: me?.issues?.[0]?.description
      });
    }
  }

  // 3) Per-metric stats
  const byMetric: MetricCalibrationStats[] = [];
  for (const metricKey of METRIC_KEYS) {
    const sub = metricSamples.filter((s) => s.metric === metricKey);
    if (sub.length === 0) {
      byMetric.push({
        metric: metricKey,
        samples: 0,
        faultySamples: 0,
        faultRate: 0,
        minConf: 0,
        maxConf: 0
      });
      continue;
    }
    const confs = sub.map((s) => s.confidence);
    byMetric.push({
      metric: metricKey,
      samples: sub.length,
      faultySamples: sub.filter((s) => s.faulty).length,
      faultRate: sub.filter((s) => s.faulty).length / sub.length,
      minConf: Math.min(...confs),
      maxConf: Math.max(...confs)
    });
  }

  // 4) Data richness — which metrics actually have outcome coverage
  const byMetricWithData = byMetric.filter((m) => m.samples >= MIN_BUCKET_COUNT);
  const byMetricSparse = byMetric.filter((m) => m.samples < MIN_BUCKET_COUNT);
  const dataRichest = [...byMetricWithData].sort((a, b) => b.samples - a.samples).map((m) => m.metric);
  const dataSparse = [...byMetricSparse].sort((a, b) => a.samples - b.samples).map((m) => m.metric);

  // 5) Change-level
  const changeFaulty = changeSamples.filter((c) => c.faulty).length;

  const summary = buildSummary({ metricSamples, buckets, falseConfidence, hcCount, hcFaulty, changeSamples });

  return {
    buckets,
    falseConfidence,
    highConfidenceHeadline: { samples: hcCount, faultySamples: hcFaulty, faultyRate: hcCount === 0 ? 0 : hcFaulty / hcCount },
    byMetric,
    changeLevel: { samples: changeSamples.length, faultyChanges: changeFaulty, faultRate: changeSamples.length === 0 ? 0 : changeFaulty / changeSamples.length },
    dataRichestMetrics: dataRichest,
    dataSparseMetrics: dataSparse,
    summary
  };
}

function buildSummary(args: {
  metricSamples: ConfidenceSample[];
  buckets: CalibrationBucket[];
  falseConfidence: FalseConfidenceEntry[];
  hcCount: number;
  hcFaulty: number;
  changeSamples: { evaluationKey: string; faulty: boolean }[];
}): string {
  const { metricSamples, buckets, falseConfidence, hcCount, hcFaulty, changeSamples } = args;
  if (metricSamples.length === 0) {
    return "No metric-scoped outcomes recorded yet. Add outcomes (jev-metrics outcome) after your changes reach the field or a staging gate to start auditing calibration.";
  }

  // Do high-confidence buckets show LOW fault rates?
  const highConfidenceBuckets = buckets.filter((b) => b.low >= 0.8 && !b.insufficient);
  const lowConfidenceBuckets = buckets.filter((b) => b.low < 0.8 && !b.insufficient);
  const highRate = highConfidenceBuckets.length
    ? highConfidenceBuckets.reduce((acc, b) => acc + b.faultyRate, 0) / highConfidenceBuckets.length
    : 0;
  const lowRate = lowConfidenceBuckets.length
    ? lowConfidenceBuckets.reduce((acc, b) => acc + b.faultyRate, 0) / lowConfidenceBuckets.length
    : 0;

  const parts: string[] = [];
  parts.push(
    `${metricSamples.length} metric-level samples; ${changeSamples.length} change-level samples.`
  );
  if (hcCount > 0) {
    parts.push(
      falseConfidence.length === 0
        ? `No false confidence found: every high-score high-confidence metric stayed clean.`
        : `${falseConfidence.length} false-confidence case(s): a metric scored >=7 at >=0.8 confidence later showed a real problem, and its root cause is still unexplained.`
    );
  }
  if (highRate !== 0 && lowRate !== 0) {
    const improving = highRate < lowRate;
    parts.push(
      `Mean fault rate in high-confidence buckets (>=0.8) is ${(highRate * 100).toFixed(0)}% vs ${(
        lowRate * 100
      ).toFixed(0)}% in lower-confidence buckets: ${
        improving
          ? "calibration is behaving as intended (higher confidence ⇒ fewer faults)."
          : "CAUTION: higher confidence is NOT associated with fewer faults — the rubric or scores may be mis-leveraged."
      }`
    );
  }
  if (hcCount > 0 && hcFaulty > 0) {
    parts.push(`Headline false-confidence rate: ${(hcFaulty / hcCount * 100).toFixed(1)}% of high-confidence metrics were faulty.`);
  }
  return parts.join("\n");
}

export function fmtPct(x: number): string {
  if (!Number.isFinite(x)) return "—";
  return `${(x * 100).toFixed(1)}%`;
}

function toBool(x: number | boolean): boolean {
  return typeof x === "boolean" ? x : x !== 0;
}