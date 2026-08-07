import { describe, expect, it } from "vitest";
import { checkServerErrorNotShown } from "../../src/checkers/form.ts";
import { ev } from "../helpers/synthetic-events.ts";

const ERROR_INDICATOR = { role: "alert", name: "Server error, please try again." };

describe("FM-SERVER-ERROR-NOT-SHOWN", () => {
  it("does nothing without explicit config", () => {
    const events = [
      ev(1, "network_response", { requestId: "req-000001", url: "http://x/api/login", status: 500 }, "action-0001"),
      ev(2, "action_finished", { actionId: "action-0001", stepIndex: 2, stepType: "click", ok: true, durationMs: 10 }, "action-0001"),
      ev(3, "verification", { passed: false, kind: "element_visible", elapsedMs: 5, observed: "not visible" })
    ];
    expect(checkServerErrorNotShown({ events })).toHaveLength(0);
  });

  it("triggers confirmed for a 500 whose action completed, no error indicator shown, and a verification failed", () => {
    const events = [
      ev(1, "network_response", { requestId: "req-000001", url: "http://x/api/login", status: 500 }, "action-0001"),
      ev(2, "action_finished", { actionId: "action-0001", stepIndex: 2, stepType: "click", ok: true, durationMs: 10 }, "action-0001"),
      ev(3, "verification", { passed: false, kind: "element_visible", elapsedMs: 5, observed: 'element with role "heading" and name "Dashboard" did not become visible within 300ms' })
    ];
    const results = checkServerErrorNotShown({ events }, { errorIndicator: ERROR_INDICATOR });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ruleId: "FM-SERVER-ERROR-NOT-SHOWN", status: "confirmed", actionId: "action-0001" });
    expect(results[0]?.evidenceSeqs).toEqual([1, 2]);
  });

  it("does not trigger when the configured error indicator was correctly shown", () => {
    const events = [
      ev(1, "network_response", { requestId: "req-000001", url: "http://x/api/login", status: 500 }, "action-0001"),
      ev(2, "action_finished", { actionId: "action-0001", stepIndex: 2, stepType: "click", ok: true, durationMs: 10 }, "action-0001"),
      ev(3, "verification", { passed: true, kind: "element_visible", elapsedMs: 5, observed: 'element with role "alert" and name "Server error, please try again." is visible' })
    ];
    expect(checkServerErrorNotShown({ events }, { errorIndicator: ERROR_INDICATOR })).toHaveLength(0);
  });

  it("does not trigger for a background 500 with no actionId", () => {
    const events = [
      ev(1, "network_response", { requestId: "req-000001", url: "http://x/api/background", status: 500 }),
      ev(2, "verification", { passed: false, kind: "element_visible", elapsedMs: 5, observed: "not visible" })
    ];
    expect(checkServerErrorNotShown({ events }, { errorIndicator: ERROR_INDICATOR })).toHaveLength(0);
  });

  it("does not trigger if the action never completed", () => {
    const events = [
      ev(1, "network_response", { requestId: "req-000001", url: "http://x/api/login", status: 500 }, "action-0001"),
      ev(2, "verification", { passed: false, kind: "element_visible", elapsedMs: 5, observed: "not visible" })
    ];
    expect(checkServerErrorNotShown({ events }, { errorIndicator: ERROR_INDICATOR })).toHaveLength(0);
  });

  it("does not trigger if nothing in the run ever failed verification", () => {
    const events = [
      ev(1, "network_response", { requestId: "req-000001", url: "http://x/api/login", status: 500 }, "action-0001"),
      ev(2, "action_finished", { actionId: "action-0001", stepIndex: 2, stepType: "click", ok: true, durationMs: 10 }, "action-0001")
    ];
    expect(checkServerErrorNotShown({ events }, { errorIndicator: ERROR_INDICATOR })).toHaveLength(0);
  });
});
