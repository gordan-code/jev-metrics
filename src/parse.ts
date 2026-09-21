import type { Evaluation } from "./types.js";

/**
 * Extract an Evaluation from the many shapes a caller might hand us:
 *   - a bare Evaluation            { metrics, priorities, ... }
 *   - a metadata wrapper           { metadata, evaluation, context }
 *   - a jev_review MCP response    { content: [...], structuredContent: { ...Evaluation } }
 *   - a jev_review MCP response where structuredContent itself is a wrapper
 *
 * Returns the Evaluation, or undefined if it cannot be located.
 */
export function extractEvaluation(input: unknown): Evaluation | undefined {
  if (!isRecord(input)) return undefined;

  // 1) Already an Evaluation? It must have a `metrics` object.
  if (isRecord(input.metrics)) {
    return input as unknown as Evaluation;
  }

  // 2) MCP response with structuredContent.
  if (input.structuredContent !== undefined) {
    const sc = input.structuredContent;
    if (isRecord(sc)) {
      if (isRecord(sc.evaluation)) return sc.evaluation as unknown as Evaluation;
      if (isRecord(sc.metrics)) return sc as unknown as Evaluation;
    }
  }

  // 3) Metadata wrapper.
  if (isRecord(input.evaluation)) {
    return input.evaluation as unknown as Evaluation;
  }

  return undefined;
}

/** Extract optional caller context from a metadata wrapper or MCP response. */
export function extractContext(input: unknown): Record<string, unknown> | undefined {
  if (!isRecord(input)) return undefined;
  if (isRecord(input.context)) return input.context as Record<string, unknown>;
  return undefined;
}

/** Extract a key hint from either a wrapper (metadata.key) or nothing. */
export function extractKeyHint(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  if (isRecord(input.metadata)) {
    const k = input.metadata.key;
    if (typeof k === "string" && k.length > 0) return k;
  }
  return undefined;
}

/** Extract a `kind` hint from a metadata wrapper, else undefined. */
export function extractKindHint(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  if (isRecord(input.metadata)) {
    const k = input.metadata.kind;
    if (typeof k === "string" && k.length > 0) return k;
  }
  return undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}