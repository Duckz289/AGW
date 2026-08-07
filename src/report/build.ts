import type { CheckerResult } from "../checkers/types.ts";
import { checkerResultToFinding } from "../findings/from-checker.ts";
import type { TimelineEvent } from "../timeline/events.ts";
import type { ReportRun, WebCheckReport } from "./schema.ts";
import { WebCheckReportSchema } from "./schema.ts";

export class ReportBuildError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "ReportBuildError";
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/**
 * Short, deterministic, and only currently-true (CURRENT_TASK.md:
 * "Populate report limitations with actual current known constraints
 * only... Do not invent generic disclaimers"). A fixed constant, not
 * derived from run data, so report output stays deterministic.
 */
export const REPORT_LIMITATIONS: readonly string[] = [
  "MCP-driven sessions do not produce evidence or a report in this milestone.",
  "NW-HTTP-ERROR and NW-TRANSPORT-FAILURE only upgrade to confirmed via an inline expectation on the same action; a later separate expect step never upgrades them.",
  "ST-INFINITE-LOADING and FM-SERVER-ERROR-NOT-SHOWN require explicit flow.checks configuration and produce no findings without it.",
  "Only five checker rules exist; there is no accessibility, responsive, performance, hydration, session-loss, or duplicate-request rule yet."
];

export interface BuildReportInput {
  runId: string;
  flowName: string;
  status: ReportRun["status"];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  completedSteps: number;
  evidencePath: string;
  failedStepIndex?: number;
  failedStepType?: string;
  events: TimelineEvent[];
  checkerResults: CheckerResult[];
}

/**
 * Pure, structured-data-only report builder (CURRENT_TASK.md: "Do not
 * make report generation depend on browser/Playwright access"). Any
 * failure — most notably a checker result referencing a `seq` absent
 * from `events` (`MissingEvidenceError`, thrown by
 * `checkerResultToFinding`) — is wrapped in `ReportBuildError` with the
 * original error preserved as `cause`, giving the caller one error type
 * to catch while still allowing `instanceof MissingEvidenceError` on the
 * cause for more specific handling.
 */
export function buildReport(input: BuildReportInput): WebCheckReport {
  try {
    const reproduction = {
      flowName: input.flowName,
      ...(input.failedStepIndex !== undefined ? { failedStepIndex: input.failedStepIndex } : {}),
      ...(input.failedStepType !== undefined ? { failedStepType: input.failedStepType } : {})
    };

    const findings = input.checkerResults.map((result, index) =>
      checkerResultToFinding(result, index, input.events, reproduction)
    );

    const summary = {
      findings: findings.length,
      confirmed: findings.filter((f) => f.classification === "confirmed").length,
      likely: findings.filter((f) => f.classification === "likely").length,
      warnings: findings.filter((f) => f.classification === "warning").length
    };

    const report = {
      schemaVersion: 1 as const,
      run: {
        runId: input.runId,
        flowName: input.flowName,
        status: input.status,
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
        durationMs: input.durationMs,
        completedSteps: input.completedSteps,
        evidencePath: input.evidencePath
      },
      summary,
      findings,
      limitations: [...REPORT_LIMITATIONS]
    };

    const parsed = WebCheckReportSchema.safeParse(report);
    if (!parsed.success) {
      throw new ReportBuildError(`built report failed schema validation: ${parsed.error.message}`);
    }
    return parsed.data;
  } catch (err) {
    if (err instanceof ReportBuildError) throw err;
    throw new ReportBuildError(`failed to build report: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err
    });
  }
}
