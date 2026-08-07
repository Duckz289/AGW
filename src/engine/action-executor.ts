import type { Page } from "playwright";
import type { BrowserAction } from "../schemas/action.ts";
import { resolveTarget, TargetResolutionError } from "./target-resolver.ts";
import { assertUrlPolicy } from "./url-policy.ts";

export type ActionFailureKind =
  | "target_not_found"
  | "action_timeout"
  | "policy_denied"
  | "action_failure";

export interface ActionResult {
  ok: boolean;
  type: BrowserAction["type"];
  failureKind?: ActionFailureKind;
  error?: string;
}

function classifyError(err: unknown): { kind: ActionFailureKind; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof TargetResolutionError) {
    return { kind: "target_not_found", message };
  }
  if (/Timeout .* exceeded/.test(message)) {
    return { kind: "action_timeout", message };
  }
  if (/URL policy denial/.test(message)) {
    return { kind: "policy_denied", message };
  }
  return { kind: "action_failure", message };
}

/**
 * Executes exactly one BrowserAction against the given page. Does not
 * observe before/after — that is BrowserSession's job. Assumes the caller
 * has already validated the action against BrowserActionSchema (required
 * target/value/url combinations) and checked snapshot freshness.
 */
export async function executeAction(page: Page, action: BrowserAction): Promise<ActionResult> {
  try {
    switch (action.type) {
      case "click": {
        if (!action.target) {
          throw new TargetResolutionError("click requires a target");
        }
        const locator = resolveTarget(page, action.target);
        await locator.click({ timeout: action.timeoutMs });
        return { ok: true, type: action.type };
      }

      case "fill": {
        if (!action.target) {
          throw new TargetResolutionError("fill requires a target");
        }
        if (action.value === undefined) {
          throw new Error("fill requires a value");
        }
        const locator = resolveTarget(page, action.target);
        await locator.fill(action.value, { timeout: action.timeoutMs });
        return { ok: true, type: action.type };
      }

      case "navigate": {
        if (action.url === undefined) {
          throw new Error("navigate requires a url");
        }
        assertUrlPolicy(action.url);
        await page.goto(action.url, { timeout: action.timeoutMs });
        return { ok: true, type: action.type };
      }
    }
  } catch (err) {
    const { kind, message } = classifyError(err);
    return { ok: false, type: action.type, failureKind: kind, error: message };
  }
}
