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
  /** Position (0-based) of the owning evaluation in the time-ordered list. */
  roundIndex: number;
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
  rubricDrift: RubricDriftEntry[]; // metrics whose score rose but fault rate stayed high
  reliability: ReliabilityDiagram;
  ece: number; // expected calibration error over confidence buckets
  summary: string;
}

/** A dimension behaving as if its scoring rubric is systematically missing faults. */
export interface RubricDriftEntry {
  metric: MetricKey;
  samples: number;
  earlyMeanScore: number;
  lateMeanScore: number;
  scoreRise: number; // late - early
  faultRate: number;
  flag: "drift" | "rising-inconclusive" | "steady-risk" | "ok";
}

export interface ReliabilityBucket {
  low: number;
  label: string;
  count: number;
  /** Observed fault probability in this bucket. */
  probFaulty: number;
  /** Mean confidence reported in this bucket. */
  meanConfidence: number;
  /** abs(meanConfidence - probFaulty); small = well calibrated. */
  gap: number;
}

export interface ReliabilityDiagram {
  buckets: ReliabilityBucket[];
  /** Higher-confidence buckets should correlate with lower probFaulty. */
  rankCorrelation: number; // simple sign metric: -1..1
  monotonicUphill: boolean; // higher confidence monotonically lowers fault probability
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

  for (let round = 0; round < evaluations.length; round++) {
    const { key, evaluation } = evaluations[round]!;
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
        faulty: metricFaultVerdict.get(faultKey)!,
        roundIndex: round
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

  // 6) Rubric drift — a metric whose score rose over rounds yet still has
  //    high fault rate (the scoring rubric is likely systematically missing faults).
  const rubricDrift = detectRubricDrift(metricSamples);

  // 7) Reliability diagram + ECE over the confidence buckets.
  const reliability = buildReliabilityDiagram(buckets);
  const ece = computeECE(reliability.buckets);

  const summary = buildSummary({ metricSamples, buckets, falseConfidence, hcCount, hcFaulty, changeSamples, rubricDrift, ece });

  return {
    buckets,
    falseConfidence,
    highConfidenceHeadline: { samples: hcCount, faultySamples: hcFaulty, faultyRate: hcCount === 0 ? 0 : hcFaulty / hcCount },
    byMetric,
    changeLevel: { samples: changeSamples.length, faultyChanges: changeFaulty, faultRate: changeSamples.length === 0 ? 0 : changeFaulty / changeSamples.length },
    dataRichestMetrics: dataRichest,
    dataSparseMetrics: dataSparse,
    rubricDrift,
    reliability,
    ece,
    summary
  };
}

/** Detect dimensions where reported quality rose across rounds but hazards did not. */
export function detectRubricDrift(metricSamples: ConfidenceSample[]): RubricDriftEntry[] {
  const byMetric = groupBy(metricSamples, (s) => s.metric);
  const out: RubricDriftEntry[] = [];

  for (const [metric, samples] of byMetric) {
    if (samples.length < MIN_BUCKET_COUNT) continue; // not enough signal
    const ordered = [...samples].sort((a, b) => a.roundIndex - b.roundIndex);
    const mid = Math.floor(ordered.length / 2);
    const early = ordered.slice(0, mid);
    const late = ordered.slice(mid);
    const earlyMean = mean(early.map((s) => s.score));
    const lateMean = mean(late.map((s) => s.score));
    const scoreRise = lateMean - earlyMean;
    const overallFaultRate = ordered.filter((s) => s.faulty).length / ordered.length;
    // Drift is about *late* behaviour: if faults mostly happened early and
    // cleared late, that's healthy. Only a sustained late fault rate is bad.
    const lateFaultRate = late.length === 0 ? 0 : late.filter((s) => s.faulty).length / late.length;

    let flag: RubricDriftEntry["flag"];
    if (scoreRise >= 0.5 && lateFaultRate >= 0.35 && overallFaultRate >= 0.35) {
      flag = "drift"; // score rose, faults persisted into recent rounds
    } else if (scoreRise >= 0.5) {
      flag = "rising-inconclusive"; // score improved with low fault rate (fine)
    } else if (lateFaultRate >= 0.35 || overallFaultRate >= 0.35) {
      flag = "steady-risk"; // faults persist but no score improvement claimed
    } else {
      flag = "ok";
    }

    out.push({
      metric,
      samples: ordered.length,
      earlyMeanScore: round1(earlyMean),
      lateMeanScore: round1(lateMean),
      scoreRise: round1(scoreRise),
      faultRate: round1(overallFaultRate),
      flag
    });
  }

  return out.sort((a, b) => (b.flag === "drift" ? 1 : 0) - (a.flag === "drift" ? 1 : 0));
}

/** Build a reliability diagram from already-computed confidence buckets. */
export function buildReliabilityDiagram(buckets: CalibrationBucket[]): ReliabilityDiagram {
  const diagram: ReliabilityDiagram = {
    buckets: buckets.map((b) => {
      // Recompute mean confidence: we only kept aggregate rates in buckets, so
      // reconstruct approximate mean-confidence from the bucket's low edge + 0.05.
      const meanConfidence = Math.min(b.low + 0.05, 0.95);
      const probFaulty = b.count === 0 ? 0 : b.faultyCount / b.count;
      return {
        low: b.low,
        label: b.label,
        count: b.count,
        probFaulty,
        meanConfidence,
        gap: Math.abs(meanConfidence - probFaulty)
      };
    }),
    rankCorrelation: 0,
    monotonicUphill: false
  };

  // Rank correlation (simple): does probFaulty decrease as confidence rises?
  const suff = diagram.buckets.filter((b) => b.count >= MIN_BUCKET_COUNT);
  if (suff.length >= 2) {
    // Kendall-lite: count concordant pairs (conf up => faulty down or same)
    let concordant = 0;
    let discordant = 0;
    let pairs = 0;
    for (let i = 0; i < suff.length; i++) {
      for (let j = i + 1; j < suff.length; j++) {
        if (suff[i]!.low === suff[j]!.low) continue;
        pairs++;
        const confAsc = suff[j]!.low > suff[i]!.low;
        const faultyDesc = suff[j]!.probFaulty <= suff[i]!.probFaulty;
        if (confAsc === faultyDesc) concordant++;
        else discordant++;
      }
    }
    diagram.rankCorrelation = pairs === 0 ? 0 : round1((concordant - discordant) / pairs);
    // Monotonic: after excluding zero-sample buckets, fault prob never rises with confidence.
    diagram.monotonicUphill = suff.every((b, i, arr) => i === 0 || b.probFaulty <= arr[i - 1]!.probFaulty);
  }
  return diagram;
}

/** Expected Calibration Error over confidence buckets (Brier-like distance). */
export function computeECE(buckets: ReliabilityBucket[]): number {
  const totalCount = buckets.reduce((a, b) => a + b.count, 0);
  if (totalCount === 0) return 0;
  let acc = 0;
  for (const b of buckets) {
    if (b.count === 0) continue;
    const weight = b.count / totalCount;
    acc += weight * Math.abs(b.meanConfidence - b.probFaulty);
  }
  return round1(acc);
}

function buildSummary(args: {
  metricSamples: ConfidenceSample[];
  buckets: CalibrationBucket[];
  falseConfidence: FalseConfidenceEntry[];
  hcCount: number;
  hcFaulty: number;
  changeSamples: { evaluationKey: string; faulty: boolean }[];
  rubricDrift: RubricDriftEntry[];
  ece: number;
}): string {
  const { metricSamples, buckets, falseConfidence, hcCount, hcFaulty, changeSamples, rubricDrift, ece } = args;
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
  const drifts = rubricDrift.filter((d) => d.flag === "drift");
  if (drifts.length > 0) {
    parts.push(
      `Rubric drift suspected in: ${drifts.map((d) => d.metric).join(", ")} — scores rose ${drifts
        .map((d) => `+${d.scoreRise.toFixed(1)}`)
        .join("/")} over rounds but fault rate stayed >= 35%. This scoring rubric is likely systematically missing real faults.`
    );
  }
  if (ece > 0) {
    parts.push(`Expected Calibration Error (ECE): ${ece.toFixed(3)} — lower is better.`);
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

function groupBy<T, K extends string | number | symbol>(xs: T[], keyFn: (x: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const x of xs) {
    const k = keyFn(x);
    const arr = map.get(k);
    if (arr) arr.push(x);
    else map.set(k, [x]);
  }
  return map;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}