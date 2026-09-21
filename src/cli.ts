#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { MetricsStore } from "./store.js";
import { METRIC_KEYS_SET, type Evaluation, type MetricKey, type OutcomeInput } from "./types.js";
import { buildMetricsReport, renderMarkdownReport, summarizeEvaluationBrief } from "./report.js";

const DEFAULT_DB = ".jev-metrics.sqlite";

function usage(help: boolean): void {
  const s = `jev-metrics — time-series persistence + calibration audit for Jev evaluation results.

USAGE (all subcommands take --db <path>; default ${DEFAULT_DB}):

  jev-metrics record [--key <k>] [--repo <r>] [--commit <c>] [--kind <baseline|rescore|final>] [--file <path>|-]
      Read an Evaluation JSON (or {"evaluation":..., "metadata": {...}} wrapper) and persist it.
      With no --file, reads JSON from stdin.
      If the JSON is a bare Evaluation and no --key is given, requires --key.

  jev-metrics outcome --key <evaluationKey> [--metric <name>] [--faulty] [--note <text>]
      Record an after-the-fact truth marker for a recorded evaluation key.
      Omit --faulty to record "no problem". --metric limits the marker to one metric.

  jev-metrics report [--out <path>] [--repo <r>]
      Render the Markdown trend + calibration report. Writes to stdout unless --out.

  jev-metrics export [--file <path>]
      Dump all stored records + outcomes as JSON.

  jev-metrics help
`;
  writeFileSync(process.stderr.fd, s);
  void help;
}

/** Read a JSON value from a file path or stdin ("-" or undefined). */
function readJsonArg(file: string | undefined): unknown {
  if (file && file !== "-") {
    return JSON.parse(readFileSync(file, "utf8"));
  }
  // Synchronously read all of fd 0 (stdin) — keeps the CLI run-to-completion.
  const text = readFileSync(0, "utf8").trim();
  if (!text) throw new Error("Empty stdin. Provide JSON via --file or pipe it in.");
  return JSON.parse(text);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function cmdRecord(dbPath: string, flags: Record<string, unknown>): void {
  const store = new MetricsStore(dbPath);
  try {
    const raw = readJsonArg(String(flags.file ?? "-"));
    let evaluation: Evaluation;
    let metadata: { key: string; repo?: string; commit?: string; label?: string; kind?: string; context?: Record<string, unknown> };

    if (raw && isRecord(raw) && raw.evaluation && isRecord(raw.evaluation)) {
      // Wrapper form: { metadata?: {...}, evaluation: {...}, context?: {...} }
      const wrap = raw as { metadata?: Record<string, unknown>; evaluation: Evaluation; context?: Record<string, unknown> };
      evaluation = wrap.evaluation;
      const md = isRecord(wrap.metadata) ? wrap.metadata : {};
      metadata = {
        key: String(md.key ?? flags.key ?? ""),
        repo: (md.repo as string | undefined) ?? (flags.repo as string | undefined),
        commit: (md.commit as string | undefined) ?? (flags.commit as string | undefined),
        label: md.label as string | undefined,
        kind: (md.kind as string | undefined) ?? (flags.kind as string | undefined) ?? "baseline",
        context: wrap.context
      };
    } else {
      // Bare Evaluation form; key must come from flags.
      evaluation = raw as Evaluation;
      metadata = {
        key: String(flags.key ?? ""),
        repo: flags.repo as string | undefined,
        commit: flags.commit as string | undefined,
        kind: (flags.kind as string | undefined) ?? "baseline"
      };
    }

    if (!metadata.key) throw new Error("A `key` is required (wrapper metadata.key, --key, or --file with metadata).");

    const stored = store.recordEvaluation(metadata, evaluation, metadata.context);
    process.stderr.write(
      `recorded #${stored.id} key="${stored.key}" kind=${stored.kind} (${summarizeEvaluationBrief(evaluation)})\n`
    );
  } finally {
    store.close();
  }
}

function cmdOutcome(dbPath: string, flags: Record<string, unknown>): void {
  const store = new MetricsStore(dbPath);
  try {
    const key = String(flags.key ?? "");
    if (!key) throw new Error("outcome requires --key <evaluationKey>.");
    const metric = flags.metric as string | undefined;
    if (metric !== undefined && !METRIC_KEYS_SET.has(metric)) {
      throw new Error(`Unknown metric "${metric}". Valid: ${[...METRIC_KEYS_SET].join(", ")}`);
    }
    const outcome: OutcomeInput = {
      evaluationKey: key,
      metric: metric as MetricKey | undefined,
      faulty: Boolean(flags.faulty),
      note: flags.note as string | undefined
    };
    const stored = store.recordOutcome(outcome);
    process.stderr.write(
      `outcome #${stored.id} for "${stored.evaluationKey}"${stored.metric ? ` [${stored.metric}]` : ""} faulty=${stored.faulty ? "yes" : "no"}\n`
    );
  } finally {
    store.close();
  }
}

function cmdReport(dbPath: string, flags: Record<string, unknown>): void {
  const store = new MetricsStore(dbPath);
  try {
    const evaluations = store.listEvaluations(flags.repo as string | undefined);
    const outcomes = store.listOutcomes();
    const report = buildMetricsReport(evaluations, outcomes);
    const md = renderMarkdownReport(report);
    const out = flags.out as string | undefined;
    if (out) {
      writeFileSync(out, md, "utf8");
      process.stderr.write(`wrote ${out}\n`);
    } else {
      process.stdout.write(md + "\n");
    }
  } finally {
    store.close();
  }
}

function cmdExport(dbPath: string, flags: Record<string, unknown>): void {
  const store = new MetricsStore(dbPath);
  try {
    const evaluations = store.listEvaluations();
    const outcomes = store.listOutcomes();
    const payload = JSON.stringify({ evaluations, outcomes }, null, 2);
    const file = flags.file as string | undefined;
    if (file) {
      writeFileSync(file, payload, "utf8");
      process.stderr.write(`wrote ${file}\n`);
    } else {
      process.stdout.write(payload + "\n");
    }
  } finally {
    store.close();
  }
}

export function main(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      db: { type: "string", default: process.env.JEV_METRICS_DB ?? DEFAULT_DB },
      key: { type: "string" },
      repo: { type: "string" },
      commit: { type: "string" },
      label: { type: "string" },
      kind: { type: "string" },
      file: { type: "string" },
      metric: { type: "string" },
      faulty: { type: "boolean", default: false },
      note: { type: "string" },
      out: { type: "string" }
    }
  });

  const sub = positionals[0];
  const dbPath = String(values.db ?? DEFAULT_DB);
  try {
    switch (sub) {
      case "record":
        cmdRecord(dbPath, values);
        break;
      case "outcome":
        cmdOutcome(dbPath, values);
        break;
      case "report":
        cmdReport(dbPath, values);
        break;
      case "export":
        cmdExport(dbPath, values);
        break;
      case "help":
      case "h":
      case "--help":
      case undefined:
        usage(true);
        break;
      default:
        throw new Error(`Unknown command "${sub}".`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${msg}\n\n`);
    usage(false);
    process.exitCode = 1;
  }
}

// Executed only when run as the CLI entrypoint (guarded so tests can import main).
if (process.argv[1] && /cli\.(js|mjs)$/.test(process.argv[1].replaceAll("\\", "/"))) {
  main(process.argv.slice(2));
}