import { describe, expect, it } from "vitest";
import { checkRuntimeExceptions } from "../../src/checkers/runtime.ts";
import { ev } from "../helpers/synthetic-events.ts";

describe("RT-EXCEPTION", () => {
  it("triggers confirmed on a runtime_error event, referencing its exact seq", () => {
    const events = [ev(3, "runtime_error", { name: "Error", message: "boom" }, "action-0001")];
    const results = checkRuntimeExceptions({ events });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      ruleId: "RT-EXCEPTION",
      status: "confirmed",
      actionId: "action-0001",
      evidenceSeqs: [3],
      observed: "boom"
    });
  });

  it("does not trigger on a console.error event alone", () => {
    const events = [ev(1, "console", { level: "error", text: "Fixture: simulated console error" })];
    const results = checkRuntimeExceptions({ events });
    expect(results).toHaveLength(0);
  });

  it("produces one result per runtime_error event (no merging)", () => {
    const events = [
      ev(1, "runtime_error", { message: "first" }),
      ev(2, "runtime_error", { message: "second" })
    ];
    const results = checkRuntimeExceptions({ events });
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.evidenceSeqs)).toEqual([[1], [2]]);
  });
});
