import type { CheckerResult } from "../checkers/types.ts";
import { redactText } from "../security/redactor.ts";
import type { TimelineEvent } from "../timeline/events.ts";
import type { EvidenceRef, Finding, FindingCategory } from "./schema.ts";

export class MissingEvidenceError extends Error {
  readonly seq: number;

  constructor(seq: number) {
    super(`checker result references seq ${seq}, which does not exist in the timeline`);
    this.name = "MissingEvidenceError";
    this.seq = seq;
  }
}

/**
 * Resolves one `seq` to an `EvidenceRef` by finding the *exact* matching
 * timeline event — never the closest one, never inferred from neighbors
 * (CURRENT_TASK.md: "Do not infer evidence from neighboring events. Do
 * not replace missing seq with a 'closest' event."). A seq with no
 * matching event is a hard error, not a silently-dropped reference.
 */
export function resolveEvidenceRef(events: readonly TimelineEvent[], seq: number): EvidenceRef {
  const event = events.find((e) => e.seq === seq);
  if (!event) {
    throw new MissingEvidenceError(seq);
  }

  const ref: EvidenceRef = { seq: event.seq, type: event.type };
  if (event.actionId !== undefined) ref.actionId = event.actionId;

  switch (event.type) {
    case "network_request":
    case "network_response":
    case "network_failed":
    case "network_finished":
      ref.requestId = event.payload.requestId;
      break;
    case "screenshot":
      ref.screenshotPath = event.payload.path;
      break;
    default:
      break;
  }

  return ref;
}

/**
 * Deterministic by rule-name prefix — no per-rule Finding shape (
 * CURRENT_TASK.md: "Do not let every checker invent its own Finding
 * shape"). Unknown/future prefixes fall back to "other" rather than
 * throwing, so a not-yet-existing rule (NAV-*, A11Y-*, RESP-*, PERF-*)
 * does not break report generation the day it is added.
 */
export function categoryForRuleId(ruleId: string): FindingCategory {
  if (ruleId.startsWith("RT-")) return "runtime";
  if (ruleId.startsWith("NW-")) return "network";
  if (ruleId.startsWith("ST-")) return "state";
  if (ruleId.startsWith("FM-")) return "form";
  if (ruleId.startsWith("NAV-")) return "navigation";
  if (ruleId.startsWith("A11Y-")) return "accessibility";
  if (ruleId.startsWith("RESP-")) return "responsive";
  if (ruleId.startsWith("PERF-")) return "performance";
  return "other";
}

export interface ReproductionContext {
  flowName: string;
  failedStepIndex?: number;
  failedStepType?: string;
}

function buildReproduction(context: ReproductionContext): Finding["reproduction"] {
  return {
    flowName: context.flowName,
    ...(context.failedStepIndex !== undefined ? { failedStepIndex: context.failedStepIndex } : {}),
    ...(context.failedStepType !== undefined ? { failedStepType: context.failedStepType } : {})
  };
}

/**
 * Converts one `CheckerResult` to one `Finding`. `index` determines the
 * deterministic id (`finding-0001`, ...) — callers must pass the result's
 * position in the already-deterministic `runCheckers()` output, not
 * re-sort by anything else. `events` must be the same timeline the
 * checker itself was given, so every evidenceSeq resolves.
 *
 * `summary`/`observed`/`expected` are redacted again here even though
 * checker inputs are already-redacted timeline text: a checker's own
 * generated prose (e.g. interpolating a URL or observed value into a
 * sentence) is a new string, not guaranteed to have passed through
 * redaction on its own path to this point, so treating it as untrusted
 * one more time is cheap and safe (CURRENT_TASK.md: "Ensure Finding
 * summary/observed/expected are safe for persistence").
 */
export function checkerResultToFinding(
  result: CheckerResult,
  index: number,
  events: readonly TimelineEvent[],
  reproduction: ReproductionContext
): Finding {
  const evidence = result.evidenceSeqs.map((seq) => resolveEvidenceRef(events, seq));

  return {
    id: `finding-${String(index + 1).padStart(4, "0")}`,
    ruleId: result.ruleId,
    title: result.title,
    classification: result.status,
    category: categoryForRuleId(result.ruleId),
    summary: redactText(result.summary),
    observed: redactText(result.observed),
    expected: redactText(result.expected),
    ...(result.actionId !== undefined ? { actionId: result.actionId } : {}),
    evidence,
    reproduction: buildReproduction(reproduction)
  };
}
