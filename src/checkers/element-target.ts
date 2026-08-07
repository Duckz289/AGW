import type { TimelineEvent } from "../timeline/events.ts";

/**
 * `VerificationPayloadSchema` intentionally has no structured role/name
 * field (Phase 2A: "Do not change verification semantics merely to fit
 * timeline storage") — role/name are only present inside the
 * human-readable `observed` string that src/engine/verification.ts
 * itself generates, in an exact, stable format:
 * `element with role "${role}" and name "${name}" is/was/did not ...`.
 * This regex is coupled to that exact wording on purpose, scoped to this
 * one file, rather than changing the persisted schema for two checkers'
 * benefit.
 */
const ELEMENT_OBSERVED_PATTERN = /role "([^"]+)" and name "([^"]+)"/;

export function extractRoleName(observed: string): { role: string; name: string } | undefined {
  const match = ELEMENT_OBSERVED_PATTERN.exec(observed);
  if (!match) return undefined;
  const [, role, name] = match;
  if (!role || !name) return undefined;
  return { role, name };
}

export function isVerificationEvent(event: TimelineEvent): event is Extract<TimelineEvent, { type: "verification" }> {
  return event.type === "verification";
}
