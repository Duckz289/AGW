import type { Page } from "playwright";
import type { Expectation } from "../schemas/flow.ts";

export interface VerificationResult {
  passed: boolean;
  kind: Expectation["kind"];
  elapsedMs: number;
  observed: string;
  errorCode?: string;
}

type AriaRole = Parameters<Page["getByRole"]>[0];

const POLL_INTERVAL_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTimeoutError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /Timeout .* exceeded/.test(message);
}

interface Outcome {
  passed: boolean;
  observed: string;
  errorCode?: string;
}

/**
 * url_matches is a plain substring match against page.url(), not a regex —
 * see the comment on ExpectationSchema in src/schemas/flow.ts. Polled
 * rather than event-driven because navigation can complete asynchronously
 * relative to the action that triggered it.
 */
async function verifyUrlMatches(page: Page, pattern: string, timeoutMs: number): Promise<Outcome> {
  const deadline = Date.now() + timeoutMs;
  let observed = page.url();
  for (;;) {
    observed = page.url();
    if (observed.includes(pattern)) {
      return { passed: true, observed };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { passed: false, observed, errorCode: "url_mismatch" };
    }
    await sleep(Math.min(POLL_INTERVAL_MS, remaining));
  }
}

async function verifyElementVisible(page: Page, role: string, name: string, timeoutMs: number): Promise<Outcome> {
  const locator = page.getByRole(role as AriaRole, { name }).first();
  try {
    await locator.waitFor({ state: "visible", timeout: timeoutMs });
    return { passed: true, observed: `element with role "${role}" and name "${name}" is visible` };
  } catch (err) {
    if (isTimeoutError(err)) {
      return {
        passed: false,
        observed: `element with role "${role}" and name "${name}" did not become visible within ${timeoutMs}ms`,
        errorCode: "verification_timeout"
      };
    }
    return {
      passed: false,
      observed: `error resolving role "${role}" name "${name}": ${err instanceof Error ? err.message : String(err)}`,
      errorCode: "verification_error"
    };
  }
}

async function verifyElementHidden(page: Page, role: string, name: string, timeoutMs: number): Promise<Outcome> {
  const locator = page.getByRole(role as AriaRole, { name }).first();
  try {
    await locator.waitFor({ state: "hidden", timeout: timeoutMs });
    return { passed: true, observed: `element with role "${role}" and name "${name}" is hidden or absent` };
  } catch (err) {
    if (isTimeoutError(err)) {
      return {
        passed: false,
        observed: `element with role "${role}" and name "${name}" was still visible after ${timeoutMs}ms`,
        errorCode: "verification_timeout"
      };
    }
    return {
      passed: false,
      observed: `error resolving role "${role}" name "${name}": ${err instanceof Error ? err.message : String(err)}`,
      errorCode: "verification_error"
    };
  }
}

async function verifyTextPresent(page: Page, text: string, timeoutMs: number): Promise<Outcome> {
  const locator = page.getByText(text).first();
  try {
    await locator.waitFor({ state: "visible", timeout: timeoutMs });
    return { passed: true, observed: `text "${text}" is present` };
  } catch (err) {
    if (isTimeoutError(err)) {
      return {
        passed: false,
        observed: `text "${text}" did not appear within ${timeoutMs}ms`,
        errorCode: "verification_timeout"
      };
    }
    return {
      passed: false,
      observed: `error searching for text "${text}": ${err instanceof Error ? err.message : String(err)}`,
      errorCode: "verification_error"
    };
  }
}

/**
 * Deterministic verification engine: checks a typed Expectation against the
 * current page state within timeoutMs. Never throws — a timeout or
 * resolution failure is returned as a structured, failed VerificationResult
 * (see CURRENT_TASK.md "Timeout" requirement), not an uncaught exception.
 */
export async function verify(page: Page, expectation: Expectation, timeoutMs: number): Promise<VerificationResult> {
  const start = Date.now();

  let outcome: Outcome;
  switch (expectation.kind) {
    case "url_matches":
      outcome = await verifyUrlMatches(page, expectation.pattern, timeoutMs);
      break;
    case "element_visible":
      outcome = await verifyElementVisible(page, expectation.role, expectation.name, timeoutMs);
      break;
    case "element_hidden":
      outcome = await verifyElementHidden(page, expectation.role, expectation.name, timeoutMs);
      break;
    case "text_present":
      outcome = await verifyTextPresent(page, expectation.text, timeoutMs);
      break;
  }

  return {
    passed: outcome.passed,
    kind: expectation.kind,
    elapsedMs: Date.now() - start,
    observed: outcome.observed,
    ...(outcome.errorCode !== undefined ? { errorCode: outcome.errorCode } : {})
  };
}
