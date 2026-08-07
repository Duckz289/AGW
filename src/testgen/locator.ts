import type { SemanticTarget } from "../schemas/action.ts";
import type { LocatorPlan } from "./types.ts";

/**
 * Resolves a Playwright locator expression from a flow step's own
 * `SemanticTarget`, in the same priority order as `docs/decisions/
 * 0001-element-targeting.md`: testId -> role+name -> label -> placeholder.
 * `role` alone (without `name`) is not specific enough to reliably locate
 * a unique element and is treated as absent, not guessed at. A "5th tier"
 * exact-text fallback is not implemented: `SemanticTargetSchema` never
 * carries free text and its own `refine` guarantees at least one of the
 * four fields above is present whenever a target exists at all, so an
 * exact-text tier would be structurally unreachable code.
 *
 * Returns `undefined` when none of the four fields are usable — callers
 * must treat that as `insufficient_evidence`, never fall back to a
 * coordinate click or a guessed CSS selector.
 */
export function resolveLocatorPlan(target: SemanticTarget): LocatorPlan | undefined {
  if (target.testId !== undefined) {
    return { kind: "testId", code: `page.getByTestId(${JSON.stringify(target.testId)})` };
  }
  if (target.role !== undefined && target.name !== undefined) {
    return {
      kind: "role",
      code: `page.getByRole(${JSON.stringify(target.role)}, { name: ${JSON.stringify(target.name)} })`
    };
  }
  if (target.label !== undefined) {
    return { kind: "label", code: `page.getByLabel(${JSON.stringify(target.label)})` };
  }
  if (target.placeholder !== undefined) {
    return { kind: "placeholder", code: `page.getByPlaceholder(${JSON.stringify(target.placeholder)})` };
  }
  return undefined;
}
