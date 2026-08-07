import type { FlowChecksConfig } from "../schemas/flow.ts";
import type { TimelineEvent } from "../timeline/events.ts";

/**
 * Read-only input to every checker. Checkers must not mutate `events`,
 * must not touch the filesystem, and must not access the browser or
 * Playwright — they are pure functions over an already-redacted,
 * already-persisted timeline (CURRENT_TASK.md "Checker engine").
 */
export interface CheckerContext {
  events: TimelineEvent[];
}

export type CheckerStatus = "confirmed" | "likely" | "warning";

/**
 * Deliberately NOT named `Finding` — that model (severity/confidence
 * scoring, source-area suggestions, etc.) belongs to a later milestone.
 * This is the smallest shape that lets a rule point back at exact
 * evidence.
 */
export interface CheckerResult {
  ruleId: string;
  status: CheckerStatus;
  title: string;
  summary: string;
  actionId?: string;
  /** Exact `seq` numbers from the timeline this result is based on — never a copy of the raw event payloads. */
  evidenceSeqs: number[];
  observed: string;
  expected: string;
}

export type RunCheckersConfig = FlowChecksConfig;

export type CheckerFn = (context: CheckerContext, config?: RunCheckersConfig) => CheckerResult[];
