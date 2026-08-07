import type { WebCheckReport } from "../report/schema.ts";
import type { ScriptedFlow } from "../schemas/flow.ts";
import type { TimelineEvent } from "../timeline/events.ts";

/**
 * Phase 4A supports exactly these three Finding classes — the ones with a
 * single, unambiguous, replayable trigger action and a stable pass/fail
 * signal (an uncaught page error, an HTTP response, a transport failure).
 * ST-INFINITE-LOADING and FM-SERVER-ERROR-NOT-SHOWN, and any future NAV-/
 * A11Y-/RESP-/PERF- rule, are deliberately unsupported in this milestone
 * (CURRENT_TASK.md).
 */
export const SUPPORTED_RULE_IDS = ["RT-EXCEPTION", "NW-HTTP-ERROR", "NW-TRANSPORT-FAILURE"] as const;
export type SupportedRuleId = (typeof SUPPORTED_RULE_IDS)[number];

export type TestGenerationStatus = "generated" | "unsupported" | "insufficient_evidence" | "verification_failed";

/**
 * Why a verification attempt never reached a normal Playwright pass/fail
 * report — a genuine runner/environment problem, structurally distinct
 * from a regression test that ran fine and whose assertion failed
 * because the bug it targets still exists. Determined primarily from
 * process-level signals (spawn failure, exit semantics); text matching
 * is used only where exit code alone cannot distinguish these startup
 * failure modes from each other (src/testgen/verify.ts).
 */
export type VerificationFailureReason =
  | "spawn_error"
  | "module_resolution_failure"
  | "no_tests_found"
  | "load_error"
  | "timeout"
  | "unknown";

/**
 * The generated file was actually spawned through the real Playwright
 * Test runner and ran to a normal pass/fail report. `outcome: "failed"`
 * is an expected, correct result for a regression test executed against
 * a still-buggy target — it is never conflated with `executed: false`.
 */
export interface TestVerificationResult {
  executed: true;
  outcome: "passed" | "failed";
  exitCode: number;
  durationMs: number;
  output: string;
}

/** The Playwright Test runner never produced a normal pass/fail report — a runner/environment problem, not a regression-test outcome. */
export interface TestVerificationExecutionFailure {
  executed: false;
  reason: VerificationFailureReason;
  message: string;
  output: string;
}

export type VerificationOutcome = TestVerificationResult | TestVerificationExecutionFailure;

export interface GeneratedTestResult {
  status: TestGenerationStatus;
  findingId: string;
  ruleId: string;
  outputPath?: string;
  reason?: string;
  /** Present only when `--verify` (or equivalent) actually attempted execution. */
  verification?: VerificationOutcome;
}

export interface GenerateTestInput {
  report: WebCheckReport;
  flow: ScriptedFlow;
  events: TimelineEvent[];
  findingId: string;
  runId: string;
  runDir: string;
}

export interface LocatorPlan {
  kind: "testId" | "role" | "label" | "placeholder";
  /** A single Playwright locator expression, e.g. `page.getByTestId("login-button")`. */
  code: string;
}

export type ReplayStepPlan =
  | { kind: "navigate"; url: string }
  | { kind: "fill"; locator: LocatorPlan; value: string }
  | { kind: "click"; locator: LocatorPlan };

interface BaseGenerationPlan {
  findingId: string;
  runId: string;
  baseUrl: string;
  /** Steps 0..stepIndex-1 of the original flow (expect steps skipped) — replayed plainly before the trigger step. */
  prefixSteps: ReplayStepPlan[];
  /** The exact step whose action produced this Finding's evidence. */
  triggerStep: ReplayStepPlan;
}

export interface RtExceptionPlan extends BaseGenerationPlan {
  ruleId: "RT-EXCEPTION";
  observedMessage: string;
}

export interface NetworkErrorPlan extends BaseGenerationPlan {
  ruleId: "NW-HTTP-ERROR";
  method: string;
  urlPath: string;
}

export interface TransportFailurePlan extends BaseGenerationPlan {
  ruleId: "NW-TRANSPORT-FAILURE";
  method: string;
  urlPath: string;
}

export type GenerationPlan = RtExceptionPlan | NetworkErrorPlan | TransportFailurePlan;

export type PlanOutcome =
  | { status: "unsupported"; findingId: string; ruleId: string; reason: string }
  | { status: "insufficient_evidence"; findingId: string; ruleId: string; reason: string }
  | { status: "planned"; findingId: string; ruleId: string; plan: GenerationPlan };
