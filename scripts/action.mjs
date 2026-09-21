#!/usr/bin/env node
/**
 * GitHub Action entrypoint for jev-metrics.
 *
 * Reads committed evaluation + outcome JSON files from the workspace and emits
 * a Markdown calibration report to:
 *   - $GITHUB_STEP_SUMMARY (when running inside a GitHub Action)
 *   - stdout (fallback, so it can be run/verified locally)
 *
 * Runtime deps: Node 22+ and the project's built output in dist/ (the action
 * should run `npm ci && npm run build` first, or use a prebuilt release).
 */
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { renderReportFromFiles } from "../dist/fromFiles.js";

const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
// Configurable via action inputs / env; default to ./evals and ./evals/outcomes.
const evalsDir = process.env.JEV_METRICS_EVALS_DIR
  ? resolve(workspace, process.env.JEV_METRICS_EVALS_DIR)
  : join(workspace, "evals");
const outcomesDir = process.env.JEV_METRICS_OUTCOMES_DIR
  ? resolve(workspace, process.env.JEV_METRICS_OUTCOMES_DIR)
  : join(workspace, "evals", "outcomes");

const markdown = renderReportFromFiles({ evalsDir, outcomesDir });

// GitHub Actions writes a collapsible step summary to GITHUB_STEP_SUMMARY.
if (process.env.GITHUB_STEP_SUMMARY) {
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, markdown, "utf8");
  console.log("Wrote Jev Metrics report to GITHUB_STEP_SUMMARY.");
} else {
  process.stdout.write(markdown + "\n");
}