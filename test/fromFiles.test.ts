import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReportFromFiles, renderReportFromFiles } from "../src/fromFiles.js";

function bareEval(score: number, confidence: number, key = "k") {
  return {
    metadata: { key, kind: "rescore" },
    evaluation: {
      metrics: {
        security: { applicable: true, score, confidence },
        correctness: { applicable: false }
      },
      priorities: []
    }
  };
}

function bareOutcome(key: string, metric = "security", faulty = false, note = "") {
  return { evaluationKey: key, metric, faulty, note };
}

test("buildReportFromFiles rebuilds a report from JSON files", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-metrics-"));
  const ev = join(dir, "evals");
  const outc = join(dir, "evals", "outcomes");
  mkdirSync(ev, { recursive: true });
  mkdirSync(outc, { recursive: true });

  writeFileSync(join(ev, "01.eval.json"), JSON.stringify(bareEval(7.0, 0.8, "k1")));
  writeFileSync(join(ev, "02.eval.json"), JSON.stringify(bareEval(6.0, 0.6, "k2")));
  writeFileSync(join(outc, "o1.json"), JSON.stringify(bareOutcome("k1", "security", false)));
  writeFileSync(join(outc, "o2.json"), JSON.stringify(bareOutcome("k2", "security", true)));

  const report = buildReportFromFiles({ evalsDir: ev, outcomesDir: outc });
  assert.equal(report.records.length, 2);
  assert.equal(report.outcomes.length, 2);
  // Trend for security: [7.0, 6.0]
  const security = report.trend.find((t) => t.metric === "security")!;
  assert.deepEqual(security.values, [7.0, 6.0]);
});

test("renderReportFromFiles produces a Markdown report", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-metrics-"));
  const ev = join(dir, "evals");
  const outc = join(dir, "evals", "outcomes");
  mkdirSync(ev, { recursive: true });
  mkdirSync(outc, { recursive: true });

  writeFileSync(join(ev, "e1.json"), JSON.stringify(bareEval(7.5, 0.9, "k1")));
  writeFileSync(join(outc, "o1.json"), JSON.stringify(bareOutcome("k1", "security", false)));

  const md = renderReportFromFiles({ evalsDir: ev, outcomesDir: outc });
  assert.match(md, /# Jev Metrics Report/);
  assert.match(md, /## Calibration audit/);
  assert.match(md, /## Score trend/);
});

test("buildReportFromFiles throws on a malformed eval file", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-metrics-"));
  const ev = join(dir, "evals");
  mkdirSync(ev, { recursive: true });
  writeFileSync(join(ev, "bad.json"), JSON.stringify({ foo: 1 })); // no Evaluation
  assert.throws(() => buildReportFromFiles({ evalsDir: ev }), /does not contain an Evaluation/);
});