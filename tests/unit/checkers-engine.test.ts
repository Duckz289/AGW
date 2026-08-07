import { describe, expect, it } from "vitest";
import { CheckerError, runCheckers } from "../../src/checkers/engine.ts";
import type { TimelineEvent } from "../../src/timeline/events.ts";
import { ev } from "../helpers/synthetic-events.ts";

describe("runCheckers engine", () => {
  it("runs rules in a fixed, stable order regardless of event order", () => {
    const events = [
      ev(1, "network_response", { requestId: "req-000001", url: "http://x/a", status: 500 }),
      ev(2, "runtime_error", { message: "boom" })
    ];
    const results = runCheckers(events);
    expect(results.map((r) => r.ruleId)).toEqual(["RT-EXCEPTION", "NW-HTTP-ERROR"]);
  });

  it("is deterministic: identical input produces identical output across repeated calls", () => {
    const events = [
      ev(1, "runtime_error", { message: "boom" }),
      ev(2, "network_response", { requestId: "req-000001", url: "http://x/a", status: 500 }),
      ev(3, "network_response", { requestId: "req-000002", url: "http://x/b", status: 404 })
    ];
    const first = runCheckers(events);
    const second = runCheckers(events);
    expect(second).toEqual(first);
  });

  it("does not mutate the input events array", () => {
    const events = [ev(1, "runtime_error", { message: "boom" })];
    const snapshot = JSON.parse(JSON.stringify(events));
    runCheckers(events);
    expect(events).toEqual(snapshot);
  });

  it("produces zero results for a clean event list", () => {
    const events = [
      ev(1, "run_started", { runId: "test-run", flowName: "clean", startUrl: "http://x", startedAt: "now" }),
      ev(2, "network_response", { requestId: "req-000001", url: "http://x/", status: 200 }),
      ev(3, "verification", { passed: true, kind: "element_visible", elapsedMs: 5, observed: "visible" }),
      ev(4, "run_finished", { status: "passed", completedSteps: 1, durationMs: 10 })
    ];
    expect(runCheckers(events)).toEqual([]);
  });

  it("wraps an unexpected checker exception in CheckerError, identifying the failing rule, instead of skipping it silently", () => {
    // Deliberately malformed: passes the TimelineEvent type via a cast
    // (bypassing normal construction) to force RT-EXCEPTION's own field
    // access to throw, proving the engine boundary does not swallow it.
    const malformed = { version: 1, seq: 1, runId: "test-run", timestampWallMs: 1, timestampMonoMs: 1, type: "runtime_error" } as unknown as TimelineEvent;

    expect(() => runCheckers([malformed])).toThrow(CheckerError);
    try {
      runCheckers([malformed]);
      expect.fail("expected runCheckers to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CheckerError);
      expect((err as CheckerError).ruleId).toBe("RT-EXCEPTION");
    }
  });
});
