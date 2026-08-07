import type { TimelineEvent } from "../timeline/events.ts";
import type { CheckerContext, CheckerFn, CheckerResult } from "./types.ts";

export const NW_HTTP_ERROR_RULE_ID = "NW-HTTP-ERROR";
export const NW_TRANSPORT_FAILURE_RULE_ID = "NW-TRANSPORT-FAILURE";

// Intentionally minimal (CURRENT_TASK.md names exactly this one form):
// "avoid flagging obvious cancellation strings such as net::ERR_ABORTED
// unless future evidence gives a reason." Not a general abort-classifier.
const CANCELLATION_FAILURE_TEXTS: readonly string[] = ["net::ERR_ABORTED"];

function isCancellation(failureText: string | undefined): boolean {
  if (failureText === undefined) return false;
  return CANCELLATION_FAILURE_TEXTS.some((text) => failureText.includes(text));
}

/**
 * Finds a failed verification correlated to `actionId` — the *only*
 * correlation this module uses for the confirmed-upgrade path
 * (CURRENT_TASK.md: "Use actionId as the primary correlation key... Do
 * not correlate unrelated events based only on temporal closeness.").
 */
function findFailedVerificationForAction(events: TimelineEvent[], actionId: string): TimelineEvent | undefined {
  return events.find((event) => event.type === "verification" && event.actionId === actionId && !event.payload.passed);
}

/**
 * Triggers on any `network_response` with status >= 400 (4xx and 5xx
 * both produce a result — CURRENT_TASK.md does not distinguish them for
 * this rule). `likely` by default: an HTTP error is evidence, not proof
 * of a frontend bug on its own. Upgraded to `confirmed` only when the
 * *same actionId* also has a failed verification — a simple, explicit,
 * deterministic signal that the error visibly affected the flow, not an
 * inferred cross-action causal chain.
 *
 * Dedup: one result per requestId (a request's response and its later
 * `network_finished` echo of the same status never produce two results).
 */
export const checkNetworkErrors: CheckerFn = (context: CheckerContext): CheckerResult[] => {
  const { events } = context;
  const results: CheckerResult[] = [];
  const seenRequestIds = new Set<string>();

  for (const event of events) {
    if (event.type !== "network_response") continue;
    if (event.payload.status < 400) continue;

    const requestId = event.payload.requestId;
    if (seenRequestIds.has(requestId)) continue;
    seenRequestIds.add(requestId);

    const requestEvent = events.find((e) => e.type === "network_request" && e.payload.requestId === requestId);
    const evidenceSeqs = [requestEvent?.seq, event.seq].filter((seq): seq is number => seq !== undefined);

    let status: CheckerResult["status"] = "likely";
    if (event.actionId !== undefined) {
      const failedVerification = findFailedVerificationForAction(events, event.actionId);
      if (failedVerification) {
        status = "confirmed";
        evidenceSeqs.push(failedVerification.seq);
      }
    }

    results.push({
      ruleId: NW_HTTP_ERROR_RULE_ID,
      status,
      title: `HTTP ${event.payload.status} response`,
      summary: `Request to ${event.payload.url} returned HTTP ${event.payload.status}.`,
      ...(event.actionId !== undefined ? { actionId: event.actionId } : {}),
      evidenceSeqs: evidenceSeqs.sort((a, b) => a - b),
      observed: `HTTP ${event.payload.status}${event.payload.statusText ? ` ${event.payload.statusText}` : ""}`,
      expected: "HTTP status below 400"
    });
  }

  return results;
};

/**
 * Triggers on `network_failed`, excluding obvious cancellations (see
 * CANCELLATION_FAILURE_TEXTS). `likely` by default; upgraded to
 * `confirmed` only when the failure has an actionId *and* that same
 * action has a failed verification — identical correlation discipline to
 * checkNetworkErrors.
 *
 * Dedup: one result per requestId.
 */
export const checkTransportFailures: CheckerFn = (context: CheckerContext): CheckerResult[] => {
  const { events } = context;
  const results: CheckerResult[] = [];
  const seenRequestIds = new Set<string>();

  for (const event of events) {
    if (event.type !== "network_failed") continue;
    if (isCancellation(event.payload.failureText)) continue;

    const requestId = event.payload.requestId;
    if (seenRequestIds.has(requestId)) continue;
    seenRequestIds.add(requestId);

    const evidenceSeqs = [event.seq];
    let status: CheckerResult["status"] = "likely";
    if (event.actionId !== undefined) {
      const failedVerification = findFailedVerificationForAction(events, event.actionId);
      if (failedVerification) {
        status = "confirmed";
        evidenceSeqs.push(failedVerification.seq);
      }
    }

    results.push({
      ruleId: NW_TRANSPORT_FAILURE_RULE_ID,
      status,
      title: "Network transport failure",
      summary: `Request to ${event.payload.url} failed at the transport level${
        event.payload.failureText ? ` (${event.payload.failureText})` : ""
      }.`,
      ...(event.actionId !== undefined ? { actionId: event.actionId } : {}),
      evidenceSeqs: evidenceSeqs.sort((a, b) => a - b),
      observed: event.payload.failureText ?? "transport failure",
      expected: "no transport-level failure"
    });
  }

  return results;
};
