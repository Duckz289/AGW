import type { CheckerContext, CheckerFn, CheckerResult } from "./types.ts";

export const RT_EXCEPTION_RULE_ID = "RT-EXCEPTION";

/**
 * Triggers only on a genuine `runtime_error` timeline event (an uncaught
 * page exception, per the Phase 2A page-error collector) — never on a
 * `console` event, even `level: "error"`. Console and runtime errors are
 * captured as distinct event types by design; this rule only ever
 * inspects `runtime_error` (CURRENT_TASK.md: "Do not trigger from
 * console.error alone. Do not merge console errors into runtime
 * exceptions.").
 *
 * Dedup: one result per `runtime_error` event (1:1, no merging).
 */
export const checkRuntimeExceptions: CheckerFn = (context: CheckerContext): CheckerResult[] => {
  const results: CheckerResult[] = [];

  for (const event of context.events) {
    if (event.type !== "runtime_error") continue;

    results.push({
      ruleId: RT_EXCEPTION_RULE_ID,
      status: "confirmed",
      title: "Uncaught runtime exception",
      summary: `An uncaught exception occurred: ${event.payload.message}`,
      ...(event.actionId !== undefined ? { actionId: event.actionId } : {}),
      evidenceSeqs: [event.seq],
      observed: event.payload.message,
      expected: "no uncaught runtime exception"
    });
  }

  return results;
};
