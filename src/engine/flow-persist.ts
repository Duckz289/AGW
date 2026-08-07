import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SemanticTarget } from "../schemas/action.ts";
import { ScriptedFlowSchema, type FlowStep, type ScriptedFlow } from "../schemas/flow.ts";
import { REDACTED_PLACEHOLDER, SENSITIVE_KEYS, redactText } from "../security/redactor.ts";

export class FlowWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlowWriteError";
  }
}

const SENSITIVE_KEY_SET = new Set(SENSITIVE_KEYS.map((key) => key.toLowerCase()));

/**
 * True when a fill step's own target (label/testId/placeholder/role/name)
 * names a conventionally sensitive field (password, token, ...) — a
 * best-effort, deterministic heuristic, not a general secret detector.
 * `ScriptedFlowSchema` has no `{{secret:...}}` placeholder mechanism yet
 * (MVP_PLAN.MD §11.3's vision, not implemented in this milestone's flow
 * schema), so a literal credential can otherwise sit directly in a fill
 * step's `value` — this is the only signal available to catch that before
 * `flow.json` (a new persisted artifact) is written.
 */
function targetLooksSensitive(target: SemanticTarget): boolean {
  const candidates = [target.testId, target.role, target.name, target.label, target.placeholder];
  return candidates.some(
    (candidate) => candidate !== undefined && [...SENSITIVE_KEY_SET].some((key) => candidate.toLowerCase().includes(key))
  );
}

/**
 * Redacts a flow for persistence: a sensitive-labeled fill value is
 * replaced outright (its exact content is never needed to reproduce a
 * Phase 4A-supported Finding — see CURRENT_TASK.md's flow-persistence
 * note), and every other free-text field is passed through `redactText()`
 * defensively in case a key=value-shaped secret is embedded in otherwise
 * ordinary text (e.g. a URL query string). Structure and non-sensitive
 * values are preserved exactly — this is not a general sanitizer.
 */
function redactStep(step: FlowStep): FlowStep {
  switch (step.type) {
    case "fill":
      return {
        ...step,
        value: targetLooksSensitive(step.target) ? REDACTED_PLACEHOLDER : redactText(step.value)
      };
    case "navigate":
      return { ...step, url: redactText(step.url) };
    case "click":
    case "expect":
      return step;
  }
}

function redactFlowForPersistence(flow: ScriptedFlow): ScriptedFlow {
  return { ...flow, steps: flow.steps.map(redactStep) };
}

/**
 * Writes the validated, redacted original flow as `flow.json` — the
 * structured reproduction source Phase 4A's regression-test generator
 * reads back (alongside `report.json`'s Finding data and `events.ndjson`'s
 * action->stepIndex mapping) instead of ever parsing `report.md` or prose.
 * Same atomic write pattern as `src/report/write.ts`: temp file in
 * `runDir`, then `rename`; no partial `flow.json` is ever left on failure.
 */
export async function writeFlowArtifact(flow: ScriptedFlow, runDir: string): Promise<string> {
  const redacted = redactFlowForPersistence(flow);
  const parsed = ScriptedFlowSchema.safeParse(redacted);
  if (!parsed.success) {
    throw new FlowWriteError(`redacted flow failed schema validation: ${parsed.error.message}`);
  }

  const finalPath = path.join(runDir, "flow.json");
  const tempPath = path.join(runDir, `.flow.json.tmp-${randomUUID()}`);
  const json = `${JSON.stringify(parsed.data, null, 2)}\n`;

  try {
    await writeFile(tempPath, json, "utf-8");
    await rename(tempPath, finalPath);
  } catch (err) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw new FlowWriteError(
      `failed to write flow.json to ${finalPath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return finalPath;
}
