import {
  METRIC_KEYS,
  type Evaluation,
  type MetricKey,
  type StoredEvaluation,
  type StoredOutcome
} from "./types.js";
import { buildCalibrationReport, fmtPct } from "./calibration.js";

export interface TrendRow {
  metric: MetricKey;
  /** Able to hold undefined when a metric was not applicable in a given record. */
  values: Array<number | undefined>;
  latest: number | undefined;
  mean: number | undefined;
  min: number | undefined;
  max: number | undefined;
  deltaFromFirst: number | undefined;
}

export interface MetricsReport {
  records: StoredEvaluation[];
  outcomes: StoredOutcome[];
  trend: TrendRow[];
}

export function buildTimeSeries(evaluations: StoredEvaluation[]): TrendRow[] {
  return METRIC_KEYS.map((metricKey) => {
    const values = evaluations.map((e) => {
      const me = e.evaluation.metrics?.[metricKey];
      return me?.applicable && me.score !== undefined ? me.score : undefined;
    });
    const present = values.filter((v): v is number => v !== undefined);
    const first = present[0];
    const last = present[present.length - 1];
    return {
      metric: metricKey,
      values,
      latest: last,
      mean: present.length ? present.reduce((a, b) => a + b, 0) / present.length : undefined,
      min: present.length ? Math.min(...present) : undefined,
      max: present.length ? Math.max(...present) : undefined,
      deltaFromFirst: first !== undefined && last !== undefined ? round1(last - first) : undefined
    };
  });
}

export function buildMetricsReport(
  evaluations: StoredEvaluation[],
  outcomes: StoredOutcome[]
): MetricsReport {
  const trend = buildTimeSeries(evaluations);
  return { records: evaluations, outcomes, trend };
}

/** Render full Markdown report from stored data. */
export function renderMarkdownReport(report: MetricsReport): string {
  const lines: string[] = [];
  lines.push("# Jev Metrics Report");
  lines.push("");
  lines.push(
    `Generated from ${report.records.length} evaluation record(s) and ${report.outcomes.length} outcome(s).`
  );
  lines.push("");
  lines.push("## Change timeline");
  lines.push("");
  if (report.records.length === 0) {
    lines.push("_No evaluations recorded yet._");
  } else {
    lines.push("| # | key | repo | commit | kind | recorded (UTC) |");
    lines.push("|---|-----|------|--------|------|----------------|");
    report.records.forEach((r, i) => {
      lines.push(
        `| ${i + 1} | \`${r.key}\` | ${r.repo ?? "—"} | ${r.commit ?? "—"} | ${r.kind ?? "—"} | ${r.recordedAt} |`
      );
    });
  }
  lines.push("");

  lines.push("## Score trend");
  lines.push("");
  lines.push(
    "Each row is one metric; columns are per-record scores (`—` = not applicable / not evaluated that round)."
  );
  lines.push("");
  lines.push(`| metric | ${report.records.map((_, i) => `#${i + 1}`).join(" | ")} | latest | mean | min | max | Δ first→last |`);
  lines.push(`|--------| ${report.records.map((_) => "---").join(" | ")} | --- | --- | --- | --- | --- |`);
  for (const row of report.trend) {
    const cells = row.values.map((v) => (v === undefined ? "—" : String(v)));
    lines.push(
      `| ${row.metric} | ${cells.join(" | ")} | ${row.latest ?? "—"} | ${
        row.mean === undefined ? "—" : row.mean.toFixed(1)
      } | ${row.min ?? "—"} | ${row.max ?? "—"} | ${row.deltaFromFirst === undefined ? "—" : fmtDelta(row.deltaFromFirst)} |`
    );
  }
  lines.push("");

  lines.push("## Regressions & potential regressions");
  lines.push("");
  const flagged: string[] = [];
  for (const row of report.trend) {
    if (row.values.length >= 2) {
      for (let i = 1; i < row.values.length; i++) {
        const prev = row.values[i - 1];
        const cur = row.values[i];
        if (prev === undefined || cur === undefined) continue;
        if (cur - prev <= -0.5) {
          flagged.push(
            `- **${row.metric}** dropped from ${prev} to ${cur} between round #${i} and #${i + 1}`
          );
        }
      }
    }
  }
  lines.push(flagged.length ? flagged.join("\n") : "_No score dropped by ≥0.5 between consecutive records._");
  lines.push("");

  lines.push("## Calibration audit");
  lines.push("");
  const cal = buildCalibrationReport(
    report.records.map((r) => ({ key: r.key, evaluation: r.evaluation })),
    report.outcomes.map((o) => ({
      evaluationKey: o.evaluationKey,
      metric: o.metric as MetricKey | undefined,
      faulty: Boolean(o.faulty),
      note: o.note
    }))
  );
  lines.push(cal.summary.split("\n").map((s) => `> ${s}`).join("\n"));
  lines.push("");
  lines.push("### Confidence buckets (metric-level samples)");
  lines.push("");
  lines.push("| confidence | samples | faulty | fault rate | note |");
  lines.push("|------------|---------|--------|------------|------|");
  for (const b of cal.buckets) {
    lines.push(
      `| ${b.label} | ${b.count} | ${b.faultyCount} | ${fmtPct(b.faultyRate)} | ${b.insufficient ? "_insufficient data_" : ""} |`
    );
  }
  lines.push("");

  lines.push("### False-confidence cases (score ≥7 & confidence ≥0.8 that later went faulty)");
  lines.push("");
  if (cal.falseConfidence.length === 0) {
    lines.push("_None. Good._");
  } else {
    lines.push("| metric | eval key | score | confidence | recorded issue |");
    lines.push("|--------|----------|-------|------------|----------------|");
    for (const fc of cal.falseConfidence) {
      lines.push(`| ${fc.metric} | \`${fc.evaluationKey}\` | ${fc.score} | ${fc.confidence.toFixed(2)} | ${fc.issue ?? "—"} |`);
    }
  }
  lines.push("");

  lines.push("### Coverage by metric");
  lines.push("");
  lines.push("| metric | samples | fault rate | min conf | max conf |");
  lines.push("|--------|---------|------------|----------|----------|");
  for (const m of cal.byMetric) {
    lines.push(
      `| ${m.metric} | ${m.samples} | ${fmtPct(m.faultRate)} | ${
        m.samples ? m.minConf.toFixed(2) : "—"
      } | ${m.samples ? m.maxConf.toFixed(2) : "—"} |`
    );
  }
  lines.push("");

  if (cal.dataSparseMetrics.length) {
    lines.push(`_Low outcome coverage (≤${2} samples): ${cal.dataSparseMetrics.join(", ")}_`);
    lines.push("");
  }

  return lines.join("\n");
}

function fmtDelta(d: number): string {
  return d > 0 ? `+${d.toFixed(1)}` : d.toFixed(1);
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

export function summarizeEvaluationBrief(e: Evaluation): string {
  const applicable = METRIC_KEYS.map((k) => e.metrics?.[k])
    .filter((m): m is NonNullable<typeof m> => Boolean(m?.applicable && m?.score !== undefined));
  const mean = applicable.length ? applicable.reduce((a, m) => a + (m.score ?? 0), 0) / applicable.length : 0;
  const weakest = [...applicable].sort((a, b) => (a.score ?? 10) - (b.score ?? 10))[0];
  const metricName = weakest ? Object.keys(e.metrics).find((k) => e.metrics[k as MetricKey] === weakest) ?? "?" : "?";
  return `mean=${mean.toFixed(1)} weakest=${metricName}(${(weakest?.score ?? 0).toFixed(1)})`;
}