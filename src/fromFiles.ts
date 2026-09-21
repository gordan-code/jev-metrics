import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { MetricsStore } from "./store.js";
import type { Evaluation, OutcomeInput } from "./types.js";
import { extractEvaluation } from "./parse.js";
import { buildMetricsReport, renderMarkdownReport, type MetricsReport } from "./report.js";

export interface FromFilesOptions {
  /** Directory containing `*.eval.json` (or `*.eval` or any *.json) evaluation files. */
  evalsDir?: string;
  /** Directory containing `*.outcome.json` outcome files. */
  outcomesDir?: string;
}

/**
 * Rebuild a MetricsReport from committed JSON files, without touching a real
 * project SQLite DB. This is the core the GitHub Action (and any batch
 * pipeline) runs.
 *
 * Each file in `evalsDir` is parsed with the same tolerant loader as `record`:
 * bare Evaluation, metadata wrapper, or jev_review MCP response. Each file in
 * `outcomesDir` is a single OutcomeInput JSON.
 */
export function buildReportFromFiles(opts: FromFilesOptions): MetricsReport {
  const store = new MetricsStore(":memory:");

  const evalsDir = opts.evalsDir;
  if (evalsDir) {
    const evalFiles = jsonFiles(evalsDir);
    // Deterministic order by filename for stable round indices.
    evalFiles.sort();
    for (const file of evalFiles) {
      const raw = parseFile(join(evalsDir, file));
      const evaluation = extractEvaluation(raw);
      if (!evaluation) {
        throw new Error(`File ${file} does not contain an Evaluation.`);
      }
      const kindHint = readKind(raw);
      const keyHint = readKey(raw) ?? file.replace(/\.[^.]+$/, "");
      store.recordEvaluation(
        { key: keyHint, kind: kindHint ?? "baseline" },
        evaluation as Evaluation
      );
    }
  }

  const outcomesDir = opts.outcomesDir;
  if (outcomesDir) {
    const outcomeFiles = jsonFiles(outcomesDir);
    outcomeFiles.sort();
    for (const file of outcomeFiles) {
      const outcome = parseFile(join(outcomesDir, file)) as OutcomeInput;
      if (!outcome || typeof outcome.evaluationKey !== "string") {
        throw new Error(`File ${file} is not a valid outcome (needs evaluationKey).`);
      }
      try {
        store.recordOutcome(outcome);
      } catch (err) {
        throw new Error(`Outcome file ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const report = buildMetricsReport(store.listEvaluations(), store.listOutcomes());
  store.close();
  return report;
}

/** Render a ready-to-post Markdown report from files (the Action's output). */
export function renderReportFromFiles(opts: FromFilesOptions): string {
  return renderMarkdownReport(buildReportFromFiles(opts));
}

function jsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return []; // missing data dir => no records (Action-friendly)
  return readdirSync(dir).filter((f) => f.endsWith(".json"));
}

function parseFile(path: string): unknown {
  const text = readFileSync(path, "utf8");
  const cleaned = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return JSON.parse(cleaned);
}

function readKey(raw: unknown): string | undefined {
  if (isRecord(raw)) {
    if (isRecord(raw.metadata) && typeof raw.metadata.key === "string") return raw.metadata.key;
  }
  return undefined;
}

function readKind(raw: unknown): string | undefined {
  if (isRecord(raw)) {
    if (isRecord(raw.metadata) && typeof raw.metadata.kind === "string") return raw.metadata.kind as string;
  }
  return undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}