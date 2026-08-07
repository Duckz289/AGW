import type { Finding } from "../findings/schema.ts";
import type { FlowStep, ScriptedFlow } from "../schemas/flow.ts";
import type { TimelineEvent } from "../timeline/events.ts";
import { resolveLocatorPlan } from "./locator.ts";
import { renderGeneratedTest } from "./render.ts";
import {
  SUPPORTED_RULE_IDS,
  type GenerateTestInput,
  type GeneratedTestResult,
  type GenerationPlan,
  type PlanOutcome,
  type ReplayStepPlan,
  type SupportedRuleId
} from "./types.ts";
import { writeGeneratedTest } from "./write.ts";

function isSupportedRuleId(ruleId: string): ruleId is SupportedRuleId {
  return (SUPPORTED_RULE_IDS as readonly string[]).includes(ruleId);
}

/**
 * The only correlation mechanism used: the exact `action_started` event
 * for this Finding's own `actionId`, read back from its `stepIndex`
 * payload field — never inferred from action counting or timing. This is
 * authoritative because `flow-runner.ts` itself writes this exact
 * mapping when the action ran.
 */
function findTriggerStepIndex(events: readonly TimelineEvent[], actionId: string): number | undefined {
  const event = events.find((e) => e.type === "action_started" && e.actionId === actionId);
  if (!event || event.type !== "action_started") return undefined;
  return event.payload.stepIndex;
}

function toReplayStep(step: FlowStep): ReplayStepPlan | undefined {
  if (step.type === "navigate") return { kind: "navigate", url: step.url };
  if (step.type === "fill") {
    const locator = resolveLocatorPlan(step.target);
    if (!locator) return undefined;
    return { kind: "fill", locator, value: step.value };
  }
  if (step.type === "click") {
    const locator = resolveLocatorPlan(step.target);
    if (!locator) return undefined;
    return { kind: "click", locator };
  }
  return undefined;
}

/**
 * Replays steps `[0, stepIndex)` — the minimum prefix required to reach
 * the triggering action (CURRENT_TASK.md: "acceptable to replay the full
 * flow up to the failing action"). `expect` steps are skipped: they are
 * verification, not actions, and are not needed to reproduce the defect
 * itself. Returns `"insufficient"` if any replayed action step lacks a
 * usable semantic locator.
 */
function buildReplayPrefix(flow: ScriptedFlow, stepIndex: number): ReplayStepPlan[] | "insufficient" {
  const result: ReplayStepPlan[] = [];
  for (let i = 0; i < stepIndex; i++) {
    const step = flow.steps[i];
    if (!step) return "insufficient";
    if (step.type === "expect") continue;
    const replay = toReplayStep(step);
    if (!replay) return "insufficient";
    result.push(replay);
  }
  return result;
}

/**
 * Reconstructs the original request's method + URL from whichever
 * evidence ref actually carries it: `NW-HTTP-ERROR` findings reference a
 * `network_request` event, while `NW-TRANSPORT-FAILURE` findings
 * reference only `network_failed` (src/checkers/network.ts never adds a
 * `network_request` seq to a transport-failure result) — `network_failed`
 * carries `url`/`method` directly on its own payload, so both cases are
 * covered without guessing.
 */
function findRequestIdentity(
  finding: Finding,
  events: readonly TimelineEvent[]
): { method: string; url: string } | undefined {
  for (const ref of finding.evidence) {
    if (ref.type !== "network_request" && ref.type !== "network_failed") continue;
    const event = events.find((e) => e.seq === ref.seq);
    if (event?.type === "network_request" || event?.type === "network_failed") {
      return { method: event.payload.method, url: event.payload.url };
    }
  }
  return undefined;
}

function urlPathOf(rawUrl: string): string | undefined {
  try {
    return new URL(rawUrl).pathname;
  } catch {
    return undefined;
  }
}

/**
 * Resolves a Finding into a `GenerationPlan` — pure structured data, no
 * rendering, no filesystem access. Every input is already-structured data
 * (`report.json`'s Finding, `flow.json`'s ScriptedFlow, `events.ndjson`'s
 * TimelineEvent[]): no Markdown, no prose, no LLM (CURRENT_TASK.md's
 * "Core principle").
 */
export function planGeneratedTest(input: GenerateTestInput): PlanOutcome {
  const finding = input.report.findings.find((f) => f.id === input.findingId);
  if (!finding) {
    return {
      status: "insufficient_evidence",
      findingId: input.findingId,
      ruleId: "",
      reason: `no finding with id "${input.findingId}" in report.findings`
    };
  }

  if (!isSupportedRuleId(finding.ruleId)) {
    return {
      status: "unsupported",
      findingId: finding.id,
      ruleId: finding.ruleId,
      reason: `rule "${finding.ruleId}" is not a Phase 4A-supported Finding class (supported: ${SUPPORTED_RULE_IDS.join(", ")})`
    };
  }

  if (finding.actionId === undefined) {
    return {
      status: "insufficient_evidence",
      findingId: finding.id,
      ruleId: finding.ruleId,
      reason: "finding has no associated actionId, so its triggering flow step cannot be reconstructed"
    };
  }

  const stepIndex = findTriggerStepIndex(input.events, finding.actionId);
  if (stepIndex === undefined) {
    return {
      status: "insufficient_evidence",
      findingId: finding.id,
      ruleId: finding.ruleId,
      reason: `no action_started event found for actionId "${finding.actionId}"`
    };
  }

  const triggerStepSource = input.flow.steps[stepIndex];
  if (!triggerStepSource) {
    return {
      status: "insufficient_evidence",
      findingId: finding.id,
      ruleId: finding.ruleId,
      reason: `flow has no step at index ${stepIndex}`
    };
  }

  const prefix = buildReplayPrefix(input.flow, stepIndex);
  if (prefix === "insufficient") {
    return {
      status: "insufficient_evidence",
      findingId: finding.id,
      ruleId: finding.ruleId,
      reason: "a replayed step's target has no usable semantic locator (testId, role+name, label, or placeholder)"
    };
  }

  const triggerStep = toReplayStep(triggerStepSource);
  if (!triggerStep) {
    return {
      status: "insufficient_evidence",
      findingId: finding.id,
      ruleId: finding.ruleId,
      reason: "the triggering step's target has no usable semantic locator (testId, role+name, label, or placeholder)"
    };
  }

  const base = {
    findingId: finding.id,
    runId: input.runId,
    baseUrl: input.flow.startUrl,
    prefixSteps: prefix,
    triggerStep
  };

  if (finding.ruleId === "RT-EXCEPTION") {
    const plan: GenerationPlan = { ...base, ruleId: "RT-EXCEPTION", observedMessage: finding.observed };
    return { status: "planned", findingId: finding.id, ruleId: finding.ruleId, plan };
  }

  const request = findRequestIdentity(finding, input.events);
  if (!request) {
    return {
      status: "insufficient_evidence",
      findingId: finding.id,
      ruleId: finding.ruleId,
      reason: "finding has no network_request or network_failed evidence to reconstruct request identity (method + URL)"
    };
  }

  const path = urlPathOf(request.url);
  if (path === undefined) {
    return {
      status: "insufficient_evidence",
      findingId: finding.id,
      ruleId: finding.ruleId,
      reason: `original request URL "${request.url}" is not a parseable absolute URL`
    };
  }

  const plan: GenerationPlan = { ...base, ruleId: finding.ruleId, method: request.method, urlPath: path };
  return { status: "planned", findingId: finding.id, ruleId: finding.ruleId, plan };
}

/**
 * Orchestrates plan -> render -> write. A write failure propagates as a
 * thrown `TestWriteError` rather than being folded into
 * `TestGenerationStatus` — none of that enum's four values mean "the
 * plan was good but the file couldn't be written," so callers (the CLI)
 * handle that as a distinct, structured operational error.
 */
export async function generateTest(input: GenerateTestInput): Promise<GeneratedTestResult> {
  const outcome = planGeneratedTest(input);
  if (outcome.status !== "planned") {
    return { status: outcome.status, findingId: outcome.findingId, ruleId: outcome.ruleId, reason: outcome.reason };
  }

  const source = renderGeneratedTest(outcome.plan);
  const outputPath = await writeGeneratedTest(input.runDir, outcome.findingId, source);
  return { status: "generated", findingId: outcome.findingId, ruleId: outcome.ruleId, outputPath };
}
