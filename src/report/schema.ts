import { z } from "zod";
import { FindingSchema } from "../findings/schema.ts";
import { RunFinishedStatusSchema } from "../timeline/events.ts";

/**
 * `RunFinishedStatusSchema` is reused (not duplicated) from
 * timeline/events.ts — it already exists precisely to mirror
 * `FlowRunStatus` (src/engine/flow-runner.ts) without a circular import,
 * and report/schema.ts has no reason to import from flow-runner.ts
 * either (report generation must operate only on structured data).
 */
export const ReportRunSchema = z.object({
  runId: z.string().min(1),
  flowName: z.string().min(1),
  status: RunFinishedStatusSchema,
  startedAt: z.string().min(1),
  finishedAt: z.string().min(1),
  durationMs: z.number().nonnegative(),
  completedSteps: z.number().int().nonnegative(),
  evidencePath: z.string().min(1)
});

export type ReportRun = z.infer<typeof ReportRunSchema>;

export const ReportSummarySchema = z.object({
  findings: z.number().int().nonnegative(),
  confirmed: z.number().int().nonnegative(),
  likely: z.number().int().nonnegative(),
  warnings: z.number().int().nonnegative()
});

export type ReportSummary = z.infer<typeof ReportSummarySchema>;

export const WebCheckReportSchema = z.object({
  schemaVersion: z.literal(1),
  run: ReportRunSchema,
  summary: ReportSummarySchema,
  findings: z.array(FindingSchema),
  /** Short, deterministic, currently-true constraints only — never generic disclaimers. See src/report/build.ts's REPORT_LIMITATIONS. */
  limitations: z.array(z.string())
});

export type WebCheckReport = z.infer<typeof WebCheckReportSchema>;
