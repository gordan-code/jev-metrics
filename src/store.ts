import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  METRIC_KEYS,
  type Evaluation,
  type MetricKey,
  type OutcomeInput,
  type RecordMetadata,
  type StoredEvaluation,
  type StoredOutcome
} from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS evaluations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT NOT NULL,
  repo        TEXT,
  "commit"    TEXT,
  label       TEXT,
  kind        TEXT,
  recorded_at TEXT NOT NULL,
  evaluation  TEXT NOT NULL,
  context     TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_evaluations_key ON evaluations(key);

CREATE TABLE IF NOT EXISTS outcomes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  evaluation_key TEXT NOT NULL REFERENCES evaluations(key),
  metric         TEXT,
  faulty         INTEGER NOT NULL CHECK (faulty IN (0,1)),
  note           TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outcomes_eval ON outcomes(evaluation_key);
CREATE INDEX IF NOT EXISTS idx_outcomes_metric ON outcomes(metric);
`;

export class MetricsStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") {
      const dir = dirname(path);
      if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    this.#db = new DatabaseSync(path);
    this.#db.exec(SCHEMA);
  }

  close(): void {
    this.#db.close();
  }

  /**
   * Record one evaluation. `key` is required by the RecordMetadata contract;
   * all other metadata is optional.
   */
  recordEvaluation(
    metadata: RecordMetadata,
    evaluation: Evaluation,
    context?: Record<string, unknown>
  ): StoredEvaluation {
    const recordedAt = new Date().toISOString();
    const result = this.#db
      .prepare(
        `INSERT INTO evaluations (key, repo, "commit", label, kind, recorded_at, evaluation, context)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           repo = excluded.repo,
           "commit" = excluded."commit",
           label = excluded.label,
           kind = excluded.kind,
           evaluation = excluded.evaluation,
           context = excluded.context`
      )
      .run(
        metadata.key,
        metadata.repo ?? null,
        metadata.commit ?? null,
        metadata.label ?? null,
        metadata.kind ?? "baseline",
        recordedAt,
        JSON.stringify(evaluation),
        context === undefined ? null : JSON.stringify(context)
      );

    const id = Number(result.lastInsertRowid);
    return { id, key: metadata.key, repo: metadata.repo, commit: metadata.commit, label: metadata.label, kind: metadata.kind, recordedAt, evaluation, context: context === undefined ? undefined : JSON.stringify(context) };
  }

  getEvaluation(key: string): StoredEvaluation | undefined {
    const row = this.#db
      .prepare(`SELECT * FROM evaluations WHERE key = ?`)
      .get(key) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return this.#rowToEvaluation(row);
  }

  listEvaluations(repo?: string): StoredEvaluation[] {
    const rows = repo
      ? (this.#db.prepare(`SELECT * FROM evaluations WHERE repo = ? ORDER BY recorded_at`).all(repo) as unknown as Array<Record<string, unknown>>)
      : (this.#db.prepare(`SELECT * FROM evaluations ORDER BY recorded_at`).all() as unknown as Array<Record<string, unknown>>);
    return rows.map((r) => this.#rowToEvaluation(r));
  }

  /** Record an after-the-fact outcome (truth marker) for a whole change or one metric. */
  recordOutcome(outcome: OutcomeInput): StoredOutcome {
    // Allow recording an outcome even if the evaluation was recorded under a
    // key; we keep the FK guarantee but surface a helpful error on mismatch.
    if (!this.getEvaluation(outcome.evaluationKey)) {
      throw new Error(
        `No evaluation recorded with key "${outcome.evaluationKey}". Record the evaluation first.`
      );
    }
    const createdAt = new Date().toISOString();
    const result = this.#db
      .prepare(
        `INSERT INTO outcomes (evaluation_key, metric, faulty, note, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        outcome.evaluationKey,
        outcome.metric ?? null,
        outcome.faulty ? 1 : 0,
        outcome.note ?? null,
        createdAt
      );
    return {
      id: Number(result.lastInsertRowid),
      evaluationKey: outcome.evaluationKey,
      metric: outcome.metric,
      faulty: outcome.faulty ? 1 : 0,
      note: outcome.note,
      createdAt
    };
  }

  listOutcomes(evaluationKey?: string): StoredOutcome[] {
    const rows = evaluationKey
      ? (this.#db.prepare(`SELECT * FROM outcomes WHERE evaluation_key = ? ORDER BY created_at`).all(evaluationKey) as unknown as Array<Record<string, unknown>>)
      : (this.#db.prepare(`SELECT * FROM outcomes ORDER BY created_at`).all() as unknown as Array<Record<string, unknown>>);
    return rows.map((r) => ({
      id: Number(r.id),
      evaluationKey: String(r.evaluation_key),
      metric: r.metric === null ? undefined : String(r.metric),
      faulty: Number(r.faulty),
      note: r.note === null ? undefined : String(r.note),
      createdAt: String(r.created_at)
    }));
  }

  /** Number of stored records (sanity check / test helper). */
  countOf(table: "evaluations" | "outcomes"): number {
    const row = this.#db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return Number(row.n);
  }

  #rowToEvaluation(row: Record<string, unknown>): StoredEvaluation {
    return {
      id: Number(row.id),
      key: String(row.key),
      repo: row.repo === null ? undefined : String(row.repo),
      commit: row.commit === null ? undefined : String(row.commit),
      label: row.label === null ? undefined : String(row.label),
      kind: row.kind === null ? undefined : String(row.kind),
      recordedAt: String(row.recorded_at),
      evaluation: JSON.parse(String(row.evaluation)) as Evaluation,
      context: row.context === null ? undefined : String(row.context)
    };
  }

  /** All metric keys present in the schema (for report iteration). */
  static metricKeys(): readonly MetricKey[] {
    return METRIC_KEYS;
  }
}