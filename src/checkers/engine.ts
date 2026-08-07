import type { TimelineEvent } from "../timeline/events.ts";
import { checkServerErrorNotShown } from "./form.ts";
import { checkNetworkErrors, checkTransportFailures } from "./network.ts";
import { checkRuntimeExceptions } from "./runtime.ts";
import { checkInfiniteLoading } from "./state.ts";
import type { CheckerContext, CheckerFn, CheckerResult, RunCheckersConfig } from "./types.ts";

export class CheckerError extends Error {
  readonly ruleId: string;

  constructor(ruleId: string, cause: unknown) {
    super(`checker "${ruleId}" threw unexpectedly: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "CheckerError";
    this.ruleId = ruleId;
  }
}

interface NamedChecker {
  ruleId: string;
  run: CheckerFn;
}

// Fixed, stable rule order — this array's order *is* the ordering
// contract for runCheckers()'s output; each rule's own results are
// pushed in the event order it scans them in, so the overall output is
// fully deterministic for a given input.
const CHECKERS: readonly NamedChecker[] = [
  { ruleId: "RT-EXCEPTION", run: checkRuntimeExceptions },
  { ruleId: "NW-HTTP-ERROR", run: checkNetworkErrors },
  { ruleId: "NW-TRANSPORT-FAILURE", run: checkTransportFailures },
  { ruleId: "ST-INFINITE-LOADING", run: checkInfiniteLoading },
  { ruleId: "FM-SERVER-ERROR-NOT-SHOWN", run: checkServerErrorNotShown }
];

/**
 * Deterministic rule engine: consumes an already-redacted, already-
 * persisted timeline and produces `CheckerResult[]` in a fixed rule
 * order. No LLM, no filesystem writes, no browser/Playwright access; no
 * checker mutates `events`.
 *
 * A checker that throws is not silently skipped — it is wrapped in
 * `CheckerError` (identifying which rule failed) and rethrown, so the
 * caller can surface a structured `internal_error` rather than
 * pretending checking succeeded (CURRENT_TASK.md "Error handling"). The
 * caller is responsible for making sure the evidence artifact itself is
 * unaffected — this function never writes to it.
 */
export function runCheckers(events: TimelineEvent[], config?: RunCheckersConfig): CheckerResult[] {
  const context: CheckerContext = { events };
  const results: CheckerResult[] = [];

  for (const checker of CHECKERS) {
    let checkerResults: CheckerResult[];
    try {
      checkerResults = checker.run(context, config);
    } catch (err) {
      throw new CheckerError(checker.ruleId, err);
    }
    results.push(...checkerResults);
  }

  return results;
}
