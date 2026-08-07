import { extractRoleName, isVerificationEvent } from "./element-target.ts";
import type { CheckerContext, CheckerFn, CheckerResult, RunCheckersConfig } from "./types.ts";

export const ST_INFINITE_LOADING_RULE_ID = "ST-INFINITE-LOADING";

/**
 * Explicit-configuration only (CURRENT_TASK.md: "Do NOT scan arbitrary
 * text for words like 'Loading'... Implement only for an explicit
 * configured loading expectation"). Returns no results at all unless the
 * flow declares `checks.loadingIndicator`.
 *
 * Fires when a passing `element_visible` verification confirms the
 * configured loading indicator is visible, and the *next* verification
 * event in the run fails — i.e. the expected success state never
 * appeared while the loading indicator was the last confirmed state.
 * Deliberately requires the two verifications to be adjacent (no
 * intervening verification), so this never infers infinite loading over
 * an arbitrary, distant later failure.
 */
export const checkInfiniteLoading: CheckerFn = (
  context: CheckerContext,
  config?: RunCheckersConfig
): CheckerResult[] => {
  if (!config?.loadingIndicator) return [];
  const { role, name } = config.loadingIndicator;

  const verifications = context.events.filter(isVerificationEvent);
  const results: CheckerResult[] = [];

  for (let i = 0; i < verifications.length - 1; i++) {
    const current = verifications[i];
    const next = verifications[i + 1];
    if (!current || !next) continue;
    if (!current.payload.passed || current.payload.kind !== "element_visible") continue;

    const target = extractRoleName(current.payload.observed);
    if (!target || target.role !== role || target.name !== name) continue;
    if (next.payload.passed) continue;

    results.push({
      ruleId: ST_INFINITE_LOADING_RULE_ID,
      status: "confirmed",
      title: "Loading indicator never resolved",
      summary: `The configured loading indicator (${role} "${name}") became visible and the expected success state never appeared before the verification timed out.`,
      evidenceSeqs: [current.seq, next.seq].sort((a, b) => a - b),
      observed: `${current.payload.observed}; then: ${next.payload.observed}`,
      expected: "the expected success state to appear once the loading indicator resolves"
    });
  }

  return results;
};
