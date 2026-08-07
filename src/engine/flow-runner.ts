import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { runCheckers } from "../checkers/engine.ts";
import type { CheckerResult } from "../checkers/types.ts";
import { buildReport } from "../report/build.ts";
import { renderMarkdownReport } from "../report/markdown.ts";
import { writeReport } from "../report/write.ts";
import { writeMarkdownReport } from "../report/write-markdown.ts";
import { redactText } from "../security/redactor.ts";
import { BrowserActionSchema, type BrowserAction } from "../schemas/action.ts";
import { ScriptedFlowSchema, type FlowStep, type ScriptedFlow } from "../schemas/flow.ts";
import type { TimelineEvent } from "../timeline/events.ts";
import { readTimelineEvents } from "../timeline/read.ts";
import { TimelineStore } from "../timeline/store.ts";
import { BrowserSession, StaleSnapshotError } from "./browser-session.ts";
import { writeFlowArtifact } from "./flow-persist.ts";
import type { VerificationResult } from "./verification.ts";

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * `environment_error` is reserved for failures caused by the execution
 * environment (browser launch failure, target server unreachable, required
 * environment unavailable to start the run). `internal_error` is the
 * distinct, separate category for an unexpected exception originating from
 * WebCheck's own engine/runtime — one that is not an ordinary action
 * failure, verification failure, stale-snapshot rejection, config problem,
 * or environment problem. See CURRENT_TASK.md's classification table.
 */
export type FlowRunStatus = "passed" | "failed" | "config_error" | "environment_error" | "internal_error";

export interface StepResult {
  index: number;
  type: FlowStep["type"];
  status: "passed" | "failed";
  durationMs: number;
  verification?: VerificationResult;
}

export interface FlowRunEvidence {
  /** Path to the run's append-only NDJSON evidence file. Empty string if evidence infrastructure itself failed to initialize. */
  eventsPath: string;
  /** Directory containing events.ndjson and screenshots/. Empty string in the same case as eventsPath. */
  runDir: string;
  /** Path to the run's report.json. Empty string if evidence infrastructure failed to initialize, or if report generation itself never successfully completed. */
  reportPath: string;
  /** Path to the run's report.md. Empty string if report.json itself never completed, or if Markdown rendering/writing failed after a valid report.json was already written. */
  markdownReportPath: string;
}

export interface FlowRunResult {
  flowName: string;
  runId: string;
  status: FlowRunStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  completedSteps: number;
  steps: StepResult[];
  evidence: FlowRunEvidence;
  /** Phase 2B deterministic checker output over this run's own timeline. Always present (possibly empty), never undefined. */
  checkerResults: CheckerResult[];
  failure?: {
    stepIndex: number;
    stepType: string;
    code: string;
    message: string;
  };
}

export type LoadFlowResult = { ok: true; flow: ScriptedFlow } | { ok: false; message: string };

/**
 * Loads and validates a flow JSON file. YAML is intentionally not
 * supported in Phase 1A (CURRENT_TASK.md: "Do not add a YAML parser
 * solely for this milestone").
 */
export async function loadFlow(filePath: string): Promise<LoadFlowResult> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err) {
    return {
      ok: false,
      message: `cannot read flow file "${filePath}": ${err instanceof Error ? err.message : String(err)}`
    };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      message: `flow file "${filePath}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    };
  }

  const result = ScriptedFlowSchema.safeParse(parsedJson);
  if (!result.success) {
    return { ok: false, message: `flow "${filePath}" failed schema validation: ${result.error.message}` };
  }

  return { ok: true, flow: result.data };
}

/**
 * Classifies a BrowserSession.start() (or evidence-init) failure. URL
 * policy denial is a recognized configuration problem; browser launch
 * failure and target unreachability are recognized environment problems
 * (Playwright does not export typed error classes for these, so a
 * narrow, documented message-pattern boundary is the most reasonable
 * mechanism available for *those two specific, previously-verified
 * cases*). Anything else is an *unrecognized* startup failure: it is not
 * safe to assume it is a config problem, so it is classified as
 * internal_error rather than defaulting to config_error.
 */
function classifySessionStartError(
  err: unknown
): { status: "config_error" | "environment_error" | "internal_error"; code: string; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  if (/URL policy denial/.test(message)) {
    return { status: "config_error", code: "POLICY_DENIED", message };
  }
  if (/browserType\.launch|Executable doesn't exist/.test(message)) {
    return { status: "environment_error", code: "BROWSER_LAUNCH_FAILURE", message };
  }
  if (/net::ERR_|page\.goto|Timeout.*exceeded/.test(message)) {
    return { status: "environment_error", code: "ENV_FAILURE", message };
  }
  return { status: "internal_error", code: "INTERNAL_ERROR", message };
}

function toBrowserAction(
  step: Extract<FlowStep, { type: "navigate" | "fill" | "click" }>,
  snapshotId: string,
  defaultTimeoutMs: number
): BrowserAction {
  const timeoutMs = step.timeoutMs ?? defaultTimeoutMs;
  if (step.type === "fill") {
    return BrowserActionSchema.parse({ snapshotId, type: "fill", target: step.target, value: step.value, timeoutMs });
  }
  if (step.type === "click") {
    return BrowserActionSchema.parse({ snapshotId, type: "click", target: step.target, timeoutMs });
  }
  return BrowserActionSchema.parse({ snapshotId, type: "navigate", url: step.url, timeoutMs });
}

/** Redacts the free-text `observed` field before it reaches the timeline — for `url_matches` this is the raw current page URL. */
function toVerificationPayload(v: VerificationResult): {
  passed: boolean;
  kind: string;
  elapsedMs: number;
  observed: string;
  errorCode?: string;
} {
  return {
    passed: v.passed,
    kind: v.kind,
    elapsedMs: v.elapsedMs,
    observed: redactText(v.observed),
    ...(v.errorCode !== undefined ? { errorCode: v.errorCode } : {})
  };
}

async function captureFailureScreenshot(
  session: BrowserSession,
  timeline: TimelineStore,
  reason: "action_failed" | "verification_failed",
  actionId?: string
): Promise<void> {
  let relativePath: string;
  try {
    const seq = timeline.nextScreenshotSeq();
    const suffix = reason === "action_failed" ? "action-failed" : "verification-failed";
    const fileName = `${String(seq).padStart(4, "0")}-${suffix}.png`;
    await session.screenshot(path.join(timeline.screenshotsDir, fileName));
    relativePath = path.posix.join("screenshots", fileName);
  } catch {
    // Best-effort: the page/browser may already be in a bad state
    // precisely because the action/verification failed. A missing
    // screenshot must not mask (or be conflated with) the real failure
    // that triggered this capture attempt.
    return;
  }

  // Unlike the screenshot capture above, a failure appending the
  // "screenshot" timeline event itself is a genuine evidence
  // write-integrity failure and is intentionally allowed to propagate.
  await timeline.append("screenshot", { path: relativePath, reason }, actionId !== undefined ? { actionId } : {});
}

export interface RunFlowOptions {
  headless?: boolean;
  /** Overrides where `<runId>/events.ndjson` is created. Defaults to `<cwd>/.webcheck/runs`. Primarily for test isolation. */
  artifactRoot?: string;
  /**
   * Test-only hook invoked with the live session immediately before
   * cleanup, so tests can inspect final page state (e.g. to prove a step
   * after a failure never ran) without weakening session encapsulation for
   * production callers (CLI/MCP never pass this).
   */
  onBeforeCleanup?: (session: BrowserSession) => Promise<void> | void;
  /**
   * Test-only hook invoked immediately before each step executes, inside
   * the same try/catch boundary as the step itself. A thrown error from
   * this hook is indistinguishable, by design, from a genuine unexpected
   * engine exception — it is the narrow seam used to exercise the
   * internal_error path without a fake production failure flag. CLI/MCP
   * never pass this.
   */
  onBeforeStep?: (session: BrowserSession, step: FlowStep, index: number) => Promise<void> | void;
}

/**
 * Executes a validated ScriptedFlow to completion or first failure,
 * producing both the existing Phase 1A FlowRunResult and a Phase 2A
 * append-only evidence timeline for it. Steps run strictly in order, one
 * browser action per observation cycle (AGENT.MD §"Browser action
 * rules"), stale-snapshot protection is inherited unmodified from
 * BrowserSession.act(), and a step failure or verification failure stops
 * the flow immediately — no later step runs. Browser and timeline
 * cleanup always happen in `finally`.
 */
export async function runFlow(flow: ScriptedFlow, options: RunFlowOptions = {}): Promise<FlowRunResult> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const steps: StepResult[] = [];

  let timeline: TimelineStore;
  try {
    timeline = await TimelineStore.create(
      options.artifactRoot !== undefined ? { artifactRoot: options.artifactRoot } : {}
    );
  } catch (err) {
    // Evidence infrastructure itself failed to initialize (e.g. cannot
    // create the run artifact directory) — no store exists to write
    // run_finished into, so this terminal result is built by hand.
    const message = err instanceof Error ? err.message : String(err);
    return {
      flowName: flow.name,
      runId: randomUUID(),
      status: "internal_error",
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - t0,
      completedSteps: 0,
      steps: [],
      evidence: { eventsPath: "", runDir: "", reportPath: "", markdownReportPath: "" },
      checkerResults: [],
      failure: { stepIndex: -1, stepType: "navigate", code: "EVIDENCE_INIT_FAILURE", message }
    };
  }

  let session: BrowserSession | undefined;

  async function finalize(status: FlowRunStatus, failure?: FlowRunResult["failure"]): Promise<FlowRunResult> {
    // Phase 4A.1: the final evidence boundary. Every exit path from the
    // run (early failure, stale snapshot, internal error, or a full
    // pass) funnels through this one function, and this is the single
    // place the network-settle wait belongs — it must happen after the
    // last action/verification but strictly *before* events.ndjson is
    // read back for checkers below. The previous placement (a
    // `waitForNetworkSettle()` call in runFlow()'s own `finally` block)
    // ran *after* finalize() had already read the timeline and computed
    // checkerResults, so a flow whose last step triggers a network
    // request with no later verification could reach checker execution
    // before that request's network_response/network_failed event had
    // landed — reliably reproduced (not assumed), see
    // tests/integration/final-evidence-boundary.test.ts. `session` is
    // undefined when finalize() runs before any browser session was
    // created (e.g. a URL-policy or browser-launch failure), where there
    // is no network activity to wait for.
    if (session) {
      await session.waitForNetworkSettle();
    }

    const completedSteps = steps.filter((s) => s.status === "passed").length;
    const durationMs = Date.now() - t0;

    let finalStatus = status;
    let finalFailure = failure;
    try {
      await timeline.append("run_finished", { status, completedSteps, durationMs });
    } catch (err) {
      // Write integrity beats pretending the run succeeded
      // (CURRENT_TASK.md "Write integrity"): if we cannot even record
      // that the run finished, the result must say so, overriding
      // whatever the "real" outcome would otherwise have been.
      finalStatus = "internal_error";
      finalFailure = {
        stepIndex: failure?.stepIndex ?? -1,
        stepType: failure?.stepType ?? "navigate",
        code: "EVIDENCE_WRITE_FAILURE",
        message: `failed to write run_finished evidence: ${err instanceof Error ? err.message : String(err)}`
      };
    }

    // Phase 2B: run the deterministic checkers over this run's own
    // persisted timeline (the artifact, read back — not a parallel
    // in-memory mirror, per Phase 2A's own architecture decision). A
    // checker throwing unexpectedly is not silently skipped: it
    // overrides the result to internal_error, same as an evidence write
    // failure above — but the evidence artifact itself is untouched
    // either way, since checking is read-only and runs after every write
    // it could possibly analyze has already completed.
    let checkerResults: CheckerResult[] = [];
    let persistedEvents: TimelineEvent[] = [];
    try {
      persistedEvents = await readTimelineEvents(timeline.eventsPath);
      checkerResults = runCheckers(persistedEvents, flow.checks);
    } catch (err) {
      finalStatus = "internal_error";
      finalFailure = {
        stepIndex: finalFailure?.stepIndex ?? -1,
        stepType: finalFailure?.stepType ?? "navigate",
        code: "CHECKER_FAILURE",
        message: `checker execution failed: ${err instanceof Error ? err.message : String(err)}`
      };
    }

    const finishedAt = new Date().toISOString();

    // Phase 3A: convert checkerResults into a structured, Zod-validated
    // report.json alongside events.ndjson. Read-only + write-once, after
    // every other write this run could produce — a build or write
    // failure here is classified internal_error the same way as the
    // steps above, and never leaves a partially-written report.json
    // (src/report/write.ts's write-temp-then-rename pattern) or touches
    // the already-complete events.ndjson.
    let reportPath = "";
    let markdownReportPath = "";
    try {
      // stepIndex -1 is the sentinel for "failed before any step ran"
      // (config/environment/evidence-init failures) — not a real step,
      // so it is deliberately excluded here: ReproductionRefSchema's
      // failedStepIndex is nonnegative, and claiming step type
      // "navigate" (the bootstrap placeholder) failed would misrepresent
      // what actually happened.
      const report = buildReport({
        runId: timeline.runId,
        flowName: flow.name,
        status: finalStatus,
        startedAt,
        finishedAt,
        durationMs,
        completedSteps,
        evidencePath: timeline.eventsPath,
        ...(finalFailure !== undefined && finalFailure.stepIndex >= 0
          ? { failedStepIndex: finalFailure.stepIndex, failedStepType: finalFailure.stepType }
          : {}),
        events: persistedEvents,
        checkerResults
      });
      reportPath = await writeReport(report, timeline.runDir);

      // Phase 3B: render Markdown from the same in-memory, already-
      // validated report object — never re-read report.json from disk,
      // never rebuild findings independently. A failure here is
      // classified separately from REPORT_FAILURE above: report.json
      // (and events.ndjson) are already durably written by this point and
      // stay exactly as they are, since Markdown is a presentation layer
      // over an already-complete artifact, not a dependency of it.
      try {
        const markdown = renderMarkdownReport(report);
        markdownReportPath = await writeMarkdownReport(timeline.runDir, markdown);
      } catch (err) {
        finalStatus = "internal_error";
        finalFailure = {
          stepIndex: finalFailure?.stepIndex ?? -1,
          stepType: finalFailure?.stepType ?? "navigate",
          code: "MARKDOWN_REPORT_FAILURE",
          message: `markdown report generation failed: ${err instanceof Error ? err.message : String(err)}`
        };
      }
    } catch (err) {
      finalStatus = "internal_error";
      finalFailure = {
        stepIndex: finalFailure?.stepIndex ?? -1,
        stepType: finalFailure?.stepType ?? "navigate",
        code: "REPORT_FAILURE",
        message: `report generation failed: ${err instanceof Error ? err.message : String(err)}`
      };
    }

    const result: FlowRunResult = {
      flowName: flow.name,
      runId: timeline.runId,
      status: finalStatus,
      startedAt,
      finishedAt,
      durationMs,
      completedSteps,
      steps,
      checkerResults,
      evidence: { eventsPath: timeline.eventsPath, runDir: timeline.runDir, reportPath, markdownReportPath }
    };
    if (finalFailure) result.failure = finalFailure;
    return result;
  }

  // Phase 4A: persist the validated, redacted original flow as
  // flow.json — the structured reproduction source regression-test
  // generation reads back later. Written up front (the flow is known
  // before any step runs and does not depend on the run's outcome), so
  // it exists even for a run that later fails or hits internal_error.
  // A write failure here is a genuine artifact-integrity problem, so it
  // short-circuits straight to finalize() the same way an evidence-init
  // failure would, before any browser session is ever created.
  try {
    await writeFlowArtifact(flow, timeline.runDir);
  } catch (err) {
    return await finalize("internal_error", {
      stepIndex: -1,
      stepType: "navigate",
      code: "FLOW_ARTIFACT_FAILURE",
      message: `failed to persist flow.json: ${err instanceof Error ? err.message : String(err)}`
    });
  }

  try {
    await timeline.append("run_started", {
      runId: timeline.runId,
      flowName: flow.name,
      startUrl: flow.startUrl,
      startedAt
    });

    let activeSession: BrowserSession;
    let currentSnapshotId: string;
    try {
      const started = await BrowserSession.start(flow.startUrl, {
        ...(options.headless !== undefined ? { headless: options.headless } : {}),
        timeline
      });
      session = started.session;
      activeSession = started.session;
      currentSnapshotId = started.snapshot.snapshotId;
    } catch (err) {
      const classified = classifySessionStartError(err);
      return await finalize(classified.status, {
        stepIndex: -1,
        stepType: "navigate",
        code: classified.code,
        message: classified.message
      });
    }

    for (let i = 0; i < flow.steps.length; i++) {
      const step = flow.steps[i];
      if (!step) continue;

      try {
        await options.onBeforeStep?.(activeSession, step, i);

        const stepStart = Date.now();

        if (step.type === "expect") {
          const timeoutMs = step.timeoutMs ?? DEFAULT_TIMEOUT_MS;
          const verification = await activeSession.verify(step.expected, timeoutMs);
          const durationMs = Date.now() - stepStart;

          // No actionId: a pure expect step is not a browser action —
          // "step identity without inventing a fake browser action" per
          // CURRENT_TASK.md.
          await timeline.append("verification", toVerificationPayload(verification));

          if (!verification.passed) {
            await captureFailureScreenshot(activeSession, timeline, "verification_failed");
            steps.push({ index: i, type: step.type, status: "failed", durationMs, verification });
            return await finalize("failed", {
              stepIndex: i,
              stepType: step.type,
              code: verification.errorCode ?? "verification_failed",
              message: verification.observed
            });
          }

          steps.push({ index: i, type: step.type, status: "passed", durationMs, verification });
          continue;
        }

        // Action step (navigate/fill/click): action_started -> set
        // action context -> execute -> optional inline verification
        // (still under the same action context) -> action_finished ->
        // clear action context, per CURRENT_TASK.md's required sequence.
        const actionId = activeSession.nextActionId();
        await timeline.append("action_started", { actionId, stepIndex: i, stepType: step.type }, { actionId });
        activeSession.beginAction(actionId);

        let actionOk: boolean;
        let actionFailure: { code: string; message: string } | undefined;
        let verification: VerificationResult | undefined;
        try {
          const action = toBrowserAction(step, currentSnapshotId, DEFAULT_TIMEOUT_MS);
          const outcome = await activeSession.act(action);
          currentSnapshotId = outcome.snapshot.snapshotId;
          actionOk = outcome.result.ok;
          if (!actionOk) {
            actionFailure = {
              code: outcome.result.failureKind ?? "action_failure",
              message: outcome.result.error ?? "action failed"
            };
          } else if (step.expected) {
            const timeoutMs = step.timeoutMs ?? DEFAULT_TIMEOUT_MS;
            verification = await activeSession.verify(step.expected, timeoutMs);
            await timeline.append("verification", toVerificationPayload(verification), { actionId });
          }
        } finally {
          activeSession.endAction();
        }

        const durationMs = Date.now() - stepStart;
        const ok = actionOk && (verification?.passed ?? true);
        await timeline.append("action_finished", { actionId, stepIndex: i, stepType: step.type, ok, durationMs }, { actionId });

        if (!actionOk) {
          await captureFailureScreenshot(activeSession, timeline, "action_failed", actionId);
          steps.push({ index: i, type: step.type, status: "failed", durationMs });
          return await finalize("failed", {
            stepIndex: i,
            stepType: step.type,
            code: actionFailure?.code ?? "action_failure",
            message: actionFailure?.message ?? "action failed"
          });
        }

        if (verification && !verification.passed) {
          await captureFailureScreenshot(activeSession, timeline, "verification_failed", actionId);
          steps.push({ index: i, type: step.type, status: "failed", durationMs, verification });
          return await finalize("failed", {
            stepIndex: i,
            stepType: step.type,
            code: verification.errorCode ?? "verification_failed",
            message: verification.observed
          });
        }

        steps.push({ index: i, type: step.type, status: "passed", durationMs, ...(verification ? { verification } : {}) });
      } catch (err) {
        // Stale-snapshot rejection is a structured, expected outcome of
        // BrowserSession.act()'s own contract (docs/decisions/
        // 0001-element-targeting.md) — an ordinary flow failure, not an
        // unexpected engine exception, even though it currently reaches
        // this boundary as a thrown error rather than a return value.
        if (err instanceof StaleSnapshotError) {
          return await finalize("failed", {
            stepIndex: i,
            stepType: step.type,
            code: "stale_snapshot",
            message: err.message
          });
        }

        // Anything else reaching this boundary is, by construction,
        // unexpected: executeAction() and verify() already catch every
        // failure mode they know about and return structured results
        // instead of throwing, and timeline.append() failures here (a
        // genuine evidence write-integrity problem) are exactly the kind
        // of unexpected engine/runtime exception internal_error exists
        // for (CURRENT_TASK.md: "If timeline infrastructure itself
        // unexpectedly fails, classify that as internal_error").
        const message = err instanceof Error ? err.message : String(err);
        return await finalize("internal_error", {
          stepIndex: i,
          stepType: step.type,
          code: "INTERNAL_ERROR",
          message
        });
      }
    }

    return await finalize("passed");
  } finally {
    if (session) {
      // The network-settle wait now happens inside finalize() itself
      // (above), strictly before checker execution — every code path
      // above this point has already gone through finalize() by
      // construction (every early-return calls `await finalize(...)`),
      // so a second wait here would be redundant with what already
      // happened before the timeline was read for checkers, and this
      // patch deliberately does not call `waitForNetworkSettle()`
      // (bounded `networkidle`) more than once per run — see
      // CURRENT_TASK.md "Final evidence boundary".
      await options.onBeforeCleanup?.(session);
      await session.close();
    }
    await timeline.close();
  }
}
