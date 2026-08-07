import { extractRoleName, isVerificationEvent } from "./element-target.ts";
import type { CheckerContext, CheckerFn, CheckerResult, RunCheckersConfig } from "./types.ts";

export const FM_SERVER_ERROR_NOT_SHOWN_RULE_ID = "FM-SERVER-ERROR-NOT-SHOWN";

/**
 * Explicit-configuration only (CURRENT_TASK.md: "This checker MUST
 * require explicit configured UI error expectation or fixture
 * metadata"). Returns no results at all unless the flow declares
 * `checks.errorIndicator` — never infers "server error not shown" merely
 * because a 5xx occurred.
 *
 * Fires only under the full deterministic pattern: a `network_response`
 * with status >= 500 whose actionId has a matching `action_finished`
 * (the action completed) — background/unrelated requests with no
 * actionId are never flagged — and across the *whole* run, no passing
 * verification confirms the configured error indicator was shown, and at
 * least one verification failed (the flow did not reach its expected
 * state).
 *
 * Dedup: one result per actionId.
 */
export const checkServerErrorNotShown: CheckerFn = (
  context: CheckerContext,
  config?: RunCheckersConfig
): CheckerResult[] => {
  if (!config?.errorIndicator) return [];
  const { role, name } = config.errorIndicator;
  const { events } = context;

  const errorIndicatorShown = events.filter(isVerificationEvent).some((event) => {
    if (!event.payload.passed) return false;
    const target = extractRoleName(event.payload.observed);
    return target?.role === role && target.name === name;
  });
  if (errorIndicatorShown) return [];

  const anyVerificationFailed = events.some((event) => event.type === "verification" && !event.payload.passed);
  if (!anyVerificationFailed) return [];

  const results: CheckerResult[] = [];
  const seenActionIds = new Set<string>();

  for (const event of events) {
    if (event.type !== "network_response") continue;
    if (event.payload.status < 500) continue;
    if (event.actionId === undefined) continue; // background/unrelated request — never flagged
    if (seenActionIds.has(event.actionId)) continue;

    const actionFinished = events.find((e) => e.type === "action_finished" && e.actionId === event.actionId);
    if (!actionFinished) continue; // the action never completed — not this pattern

    seenActionIds.add(event.actionId);

    results.push({
      ruleId: FM_SERVER_ERROR_NOT_SHOWN_RULE_ID,
      status: "confirmed",
      title: "Server error not shown to user",
      summary: `Action ${event.actionId} received HTTP ${event.payload.status} from ${event.payload.url}, but the configured error indicator (${role} "${name}") was never shown and the flow did not reach its expected state.`,
      actionId: event.actionId,
      evidenceSeqs: [event.seq, actionFinished.seq].sort((a, b) => a - b),
      observed: `HTTP ${event.payload.status} with no visible ${role} "${name}"`,
      expected: `configured error indicator (${role} "${name}") to be shown`
    });
  }

  return results;
};
