import { describe, expect, it } from "vitest";
import type { CheckerResult } from "../../src/checkers/types.ts";
import {
  MissingEvidenceError,
  categoryForRuleId,
  checkerResultToFinding,
  resolveEvidenceRef
} from "../../src/findings/from-checker.ts";
import { ev } from "../helpers/synthetic-events.ts";

function baseResult(overrides: Partial<CheckerResult> = {}): CheckerResult {
  return {
    ruleId: "RT-EXCEPTION",
    status: "confirmed",
    title: "Uncaught runtime exception",
    summary: "An uncaught exception occurred: boom",
    evidenceSeqs: [1],
    observed: "boom",
    expected: "no uncaught runtime exception",
    ...overrides
  };
}

describe("categoryForRuleId", () => {
  it.each([
    ["RT-EXCEPTION", "runtime"],
    ["NW-HTTP-ERROR", "network"],
    ["NW-TRANSPORT-FAILURE", "network"],
    ["ST-INFINITE-LOADING", "state"],
    ["FM-SERVER-ERROR-NOT-SHOWN", "form"],
    ["NAV-BROKEN-LINK", "navigation"],
    ["A11Y-MISSING-LABEL", "accessibility"],
    ["RESP-LAYOUT-SHIFT", "responsive"],
    ["PERF-SLOW-RESPONSE", "performance"],
    ["SOMETHING-UNKNOWN", "other"]
  ])("%s -> %s", (ruleId, expected) => {
    expect(categoryForRuleId(ruleId)).toBe(expected);
  });
});

describe("resolveEvidenceRef", () => {
  it("resolves the exact matching event by seq", () => {
    const events = [ev(1, "runtime_error", { message: "boom" }, "action-0001")];
    const ref = resolveEvidenceRef(events, 1);
    expect(ref).toEqual({ seq: 1, type: "runtime_error", actionId: "action-0001" });
  });

  it("extracts requestId from a network event", () => {
    const events = [ev(5, "network_response", { requestId: "req-000002", url: "http://x/a", status: 500 })];
    const ref = resolveEvidenceRef(events, 5);
    expect(ref.requestId).toBe("req-000002");
  });

  it("extracts screenshotPath from a screenshot event", () => {
    const events = [ev(9, "screenshot", { path: "screenshots/0001-action-failed.png", reason: "action_failed" })];
    const ref = resolveEvidenceRef(events, 9);
    expect(ref.screenshotPath).toBe("screenshots/0001-action-failed.png");
  });

  it("does not attach requestId or screenshotPath to unrelated event types", () => {
    const events = [ev(2, "console", { level: "log", text: "hi" })];
    const ref = resolveEvidenceRef(events, 2);
    expect(ref.requestId).toBeUndefined();
    expect(ref.screenshotPath).toBeUndefined();
  });

  it("throws MissingEvidenceError for a seq that does not exist, rather than picking the closest event", () => {
    const events = [ev(1, "runtime_error", { message: "boom" }), ev(3, "runtime_error", { message: "boom2" })];
    expect(() => resolveEvidenceRef(events, 2)).toThrow(MissingEvidenceError);
    try {
      resolveEvidenceRef(events, 2);
      expect.fail("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MissingEvidenceError);
      expect((err as MissingEvidenceError).seq).toBe(2);
    }
  });
});

describe("checkerResultToFinding", () => {
  const events = [ev(1, "runtime_error", { name: "Error", message: "boom" }, "action-0001")];

  it("maps a CheckerResult to a Finding with the documented field mapping", () => {
    const result = baseResult({ actionId: "action-0001" });
    const finding = checkerResultToFinding(result, 0, events, { flowName: "test-flow" });

    expect(finding.ruleId).toBe(result.ruleId);
    expect(finding.classification).toBe(result.status);
    expect(finding.title).toBe(result.title);
    expect(finding.summary).toBe(result.summary);
    expect(finding.observed).toBe(result.observed);
    expect(finding.expected).toBe(result.expected);
    expect(finding.actionId).toBe(result.actionId);
    expect(finding.category).toBe("runtime");
    expect(finding.evidence).toEqual([{ seq: 1, type: "runtime_error", actionId: "action-0001" }]);
    expect(finding.reproduction).toEqual({ flowName: "test-flow" });
  });

  it("assigns deterministic, zero-padded, index-based ids", () => {
    const results = [baseResult(), baseResult({ ruleId: "NW-HTTP-ERROR", evidenceSeqs: [] })];
    const findings = results.map((r, i) => checkerResultToFinding(r, i, events, { flowName: "test-flow" }));
    expect(findings.map((f) => f.id)).toEqual(["finding-0001", "finding-0002"]);
  });

  it("includes failedStepIndex/failedStepType in reproduction when provided", () => {
    const finding = checkerResultToFinding(baseResult(), 0, events, {
      flowName: "test-flow",
      failedStepIndex: 2,
      failedStepType: "click"
    });
    expect(finding.reproduction).toEqual({ flowName: "test-flow", failedStepIndex: 2, failedStepType: "click" });
  });

  it("redacts sensitive text in summary/observed/expected before persistence", () => {
    const result = baseResult({
      summary: "auth failed for token=WEBCHECK_TEST_TOKEN_91ce",
      observed: "password=WEBCHECK_TEST_PASSWORD_7f4a",
      expected: "no leak"
    });
    const finding = checkerResultToFinding(result, 0, events, { flowName: "test-flow" });
    expect(finding.summary).not.toContain("WEBCHECK_TEST_TOKEN_91ce");
    expect(finding.observed).not.toContain("WEBCHECK_TEST_PASSWORD_7f4a");
  });

  it("propagates MissingEvidenceError when an evidenceSeq is not in the given events", () => {
    const result = baseResult({ evidenceSeqs: [999] });
    expect(() => checkerResultToFinding(result, 0, events, { flowName: "test-flow" })).toThrow(MissingEvidenceError);
  });
});
