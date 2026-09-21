/**
 * jev-metrics core types.
 *
 * These mirror the `Evaluation` shape produced by the `jev-review` MCP plugin
 * (`src/evaluation/types.ts`), so that an Evaluation returned by `jev_review`
 * can be dropped straight into the recorder. We deliberately *copy* the shape
 * rather than importing `jev-review` (which is not published to npm) so this
 * package stays dependency-free and usable standalone.
 */

export const METRIC_KEYS = [
  "correctness",
  "cognitiveComplexity",
  "readability",
  "modularity",
  "coupling",
  "changeability",
  "abstractionQuality",
  "projectStructure",
  "duplication",
  "maintainability",
  "testQuality",
  "reliability",
  "security",
  "consistency",
  "documentation",
  "performance",
  "scalability",
  "compatibility",
  "observability"
] as const;

export type MetricKey = (typeof METRIC_KEYS)[number];

export type Severity = "low" | "medium" | "high";

export interface MetricIssue {
  severity: Severity;
  description: string;
  location?: string;
  suggestion?: string;
}

export interface MetricEvaluation {
  applicable: boolean;
  score?: number; // 1..10 (only when applicable)
  confidence?: number; // 0..1 (only when applicable)
  summary?: string;
  issues?: MetricIssue[];
}

export interface PriorityEntry {
  metric: MetricKey;
  severity: Severity;
  reason: string;
}

export interface ComparisonEntry {
  metric: MetricKey;
  previousScore: number;
  currentScore: number;
  delta: number;
  direction: "improved" | "regressed" | "unchanged";
}

export interface Evaluation {
  metrics: Record<MetricKey, MetricEvaluation>;
  priorities: PriorityEntry[];
  improvements?: string[];
  regressions?: string[];
  comparison?: ComparisonEntry[];
}

// ---- Persistence envelope -------------------------------------------------

/**
 * Metadata attached to a recorded evaluation. Everything except `key` is
 * optional so the recorder can be used with as little or as much context as
 * the caller has.
 */
export interface RecordMetadata {
  /** Stable id of this evaluation/change. Used to correlate an outcome later. */
  key: string;
  /** Repository identifier, e.g. "org/repo" or a local path. */
  repo?: string;
  /** Commit / change hash the evaluation applied to. */
  commit?: string;
  /** Optional natural-language label for readability in reports. */
  label?: string;
  /** Whether this record reflects a fresh baseline or a rescore after fixes. */
  kind?: "baseline" | "rescore" | "final" | string;
  /** Free-form JSON the caller wants stored alongside (e.g. the task/diff). */
  context?: Record<string, unknown>;
}

export interface StoredEvaluation {
  id: number;
  key: string;
  repo?: string;
  commit?: string;
  label?: string;
  kind?: string;
  recordedAt: string; // ISO-8601
  /** Full evaluation payload serialized as JSON. */
  evaluation: Evaluation;
  /** Caller context serialized as JSON. */
  context?: string;
}

/**
 * An "after the fact" truth marker tied to one evaluation key (whole change)
 * and optionally one metric. Calibration auditing compares these against the
 * confidence Jev assigned at review time.
 */
export interface OutcomeInput {
  /** Must match the `key` used when the evaluation was recorded. */
  evaluationKey: string;
  /** Optional metric the outcome applies to; omit for a whole-change outcome. */
  metric?: MetricKey;
  /** Did this change turn out to cause a real problem in this metric? */
  faulty: boolean;
  /** Optional remediation / comment. */
  note?: string;
}

export interface StoredOutcome {
  id: number;
  evaluationKey: string;
  metric?: string;
  faulty: number; // 0 or 1
  note?: string;
  createdAt: string;
}

export const METRIC_KEYS_SET: ReadonlySet<string> = new Set<string>(METRIC_KEYS);