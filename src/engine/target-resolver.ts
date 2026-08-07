import type { Locator, Page } from "playwright";
import type { SemanticTarget } from "../schemas/action.ts";

export class TargetResolutionError extends Error {}

type AriaRole = Parameters<Page["getByRole"]>[0];

/**
 * Resolves a SemanticTarget to a Playwright Locator using the priority
 * order decided in docs/decisions/0001-element-targeting.md:
 * testId > role(+name) > label > placeholder.
 *
 * getByText and a CSS last resort are part of the full MVP priority list
 * (MVP_PLAN.MD §6.3) but are deferred past Phase 0's minimal resolver.
 */
export function resolveTarget(page: Page, target: SemanticTarget): Locator {
  if (target.testId !== undefined) {
    return page.getByTestId(target.testId);
  }

  if (target.role !== undefined) {
    return page.getByRole(
      target.role as AriaRole,
      target.name !== undefined ? { name: target.name } : undefined
    );
  }

  if (target.label !== undefined) {
    return page.getByLabel(target.label);
  }

  if (target.placeholder !== undefined) {
    return page.getByPlaceholder(target.placeholder);
  }

  throw new TargetResolutionError(
    "target did not match any resolution strategy (testId, role, label, placeholder)"
  );
}
