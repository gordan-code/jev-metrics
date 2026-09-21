import { test } from "node:test";
import assert from "node:assert/strict";
import { extractEvaluation, extractContext, extractKeyHint, extractKindHint } from "../src/parse.js";
import { detectGit, normalizeRemote } from "../src/git.js";
import type { Evaluation } from "../src/types.js";

const bareEval: Evaluation = {
  metrics: { correctness: { applicable: true, score: 7, confidence: 0.8 } } as Evaluation["metrics"],
  priorities: []
};

test("extractEvaluation: bare Evaluation", () => {
  const out = extractEvaluation(bareEval);
  assert.ok(out);
  assert.equal(out!.metrics.correctness?.score, 7);
});

test("extractEvaluation: metadata wrapper", () => {
  const out = extractEvaluation({ metadata: { key: "k" }, evaluation: bareEval });
  assert.ok(out);
  assert.equal(out!.metrics.correctness?.score, 7);
});

test("extractEvaluation: jev_review MCP response structuredContent", () => {
  const out = extractEvaluation({
    content: [{ type: "text", text: "json" }],
    structuredContent: bareEval
  });
  assert.ok(out);
  assert.equal(out!.metrics.correctness?.score, 7);
});

test("extractEvaluation: MCP response with wrapped structuredContent", () => {
  const out = extractEvaluation({
    structuredContent: { metadata: { key: "k" }, evaluation: bareEval }
  });
  assert.ok(out);
  assert.equal(out!.metrics.correctness?.score, 7);
});

test("extractEvaluation: returns undefined for junk", () => {
  assert.equal(extractEvaluation("{not json"), undefined);
  assert.equal(extractEvaluation(null), undefined);
  assert.equal(extractEvaluation({ foo: 1 }), undefined);
});

test("extractContext and key/kind hints", () => {
  const input = { metadata: { key: "k1", kind: "final" }, evaluation: bareEval, context: { task: "x" } };
  assert.equal(extractKeyHint(input), "k1");
  assert.equal(extractKindHint(input), "final");
  assert.deepEqual(extractContext(input), { task: "x" });
});

test("normalizeRemote: scp and https forms", () => {
  assert.equal(normalizeRemote("git@github.com:acme/api.git"), "acme/api");
  assert.equal(normalizeRemote("https://github.com/acme/api"), "acme/api");
  assert.equal(normalizeRemote("git@github.com:acme/api"), "acme/api");
});

test("detectGit never throws and returns a sane object", () => {
  // The contract is: never throws, returns { repo?, commit? }.
  const meta = detectGit();
  assert.equal(typeof meta, "object");
  assert.ok(meta.repo === undefined || typeof meta.repo === "string");
  assert.ok(meta.commit === undefined || typeof meta.commit === "string");
  // In this repo (a git checkout with no remote) commit should be detectable;
  // repo falls back to the directory name when there is no origin remote.
  assert.ok(!meta.commit || meta.commit.length > 0);
});