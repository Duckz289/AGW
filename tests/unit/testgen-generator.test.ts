import { describe, expect, it } from "vitest";
import { planGeneratedTest } from "../../src/testgen/generator.ts";
import { networkErrorScenario, rtExceptionScenario, transportFailureScenario } from "../helpers/testgen-scenarios.ts";

describe("planGeneratedTest", () => {
  it("1. recognizes a supported rule (RT-EXCEPTION) and plans a test", () => {
    const scenario = rtExceptionScenario();
    const outcome = planGeneratedTest({ ...scenario, findingId: "finding-0001" });
    expect(outcome.status).toBe("planned");
    expect(outcome.ruleId).toBe("RT-EXCEPTION");
  });

  it("recognizes NW-HTTP-ERROR as supported and plans a test", () => {
    const scenario = networkErrorScenario();
    const outcome = planGeneratedTest({ ...scenario, findingId: "finding-0001" });
    expect(outcome.status).toBe("planned");
    expect(outcome.ruleId).toBe("NW-HTTP-ERROR");
  });

  it("recognizes NW-TRANSPORT-FAILURE as supported and plans a test", () => {
    const scenario = transportFailureScenario();
    const outcome = planGeneratedTest({ ...scenario, findingId: "finding-0001" });
    expect(outcome.status).toBe("planned");
    expect(outcome.ruleId).toBe("NW-TRANSPORT-FAILURE");
  });

  it("2. returns 'unsupported' for a rule outside the Phase 4A set (ST-INFINITE-LOADING)", () => {
    const scenario = rtExceptionScenario();
    const report = {
      ...scenario.report,
      findings: [
        {
          id: "finding-0001",
          ruleId: "ST-INFINITE-LOADING",
          title: "t",
          classification: "confirmed" as const,
          category: "state" as const,
          summary: "s",
          observed: "o",
          expected: "e",
          evidence: []
        }
      ]
    };
    const outcome = planGeneratedTest({ ...scenario, report, findingId: "finding-0001" });
    expect(outcome.status).toBe("unsupported");
    expect(outcome.ruleId).toBe("ST-INFINITE-LOADING");
    if (outcome.status === "planned") throw new Error("expected unsupported");
    expect(outcome.reason).toMatch(/not a Phase 4A-supported/);
  });

  it("does not throw for an unknown findingId — returns insufficient_evidence", () => {
    const scenario = rtExceptionScenario();
    const outcome = planGeneratedTest({ ...scenario, findingId: "finding-9999" });
    expect(outcome.status).toBe("insufficient_evidence");
  });

  it("7. returns insufficient_evidence when the triggering step's target has no usable locator", () => {
    const scenario = rtExceptionScenario();
    const flow = { ...scenario.flow, steps: [{ type: "click" as const, target: { role: "button" } }] };
    const outcome = planGeneratedTest({ ...scenario, flow, findingId: "finding-0001" });
    expect(outcome.status).toBe("insufficient_evidence");
    if (outcome.status === "planned") throw new Error("expected insufficient_evidence");
    expect(outcome.reason).toMatch(/semantic locator/);
  });

  it("returns insufficient_evidence when the finding has no actionId", () => {
    const scenario = rtExceptionScenario();
    const report = {
      ...scenario.report,
      findings: scenario.report.findings.map((f) => ({
        id: f.id,
        ruleId: f.ruleId,
        title: f.title,
        classification: f.classification,
        category: f.category,
        summary: f.summary,
        observed: f.observed,
        expected: f.expected,
        evidence: f.evidence
      }))
    };
    const outcome = planGeneratedTest({ ...scenario, report, findingId: "finding-0001" });
    expect(outcome.status).toBe("insufficient_evidence");
    if (outcome.status === "planned") throw new Error("expected insufficient_evidence");
    expect(outcome.reason).toMatch(/actionId/);
  });

  it("returns insufficient_evidence when no action_started event matches the finding's actionId", () => {
    const scenario = rtExceptionScenario();
    const events = scenario.events.filter((e) => e.type !== "action_started");
    const outcome = planGeneratedTest({ ...scenario, events, findingId: "finding-0001" });
    expect(outcome.status).toBe("insufficient_evidence");
    if (outcome.status === "planned") throw new Error("expected insufficient_evidence");
    expect(outcome.reason).toMatch(/action_started/);
  });

  it("4. produces a deterministic plan for identical input", () => {
    const scenario = rtExceptionScenario();
    const first = planGeneratedTest({ ...scenario, findingId: "finding-0001" });
    const second = planGeneratedTest({ ...scenario, findingId: "finding-0001" });
    expect(second).toEqual(first);
  });

  it("builds a prefix that skips expect steps and stops before the trigger step", () => {
    const scenario = networkErrorScenario();
    const outcome = planGeneratedTest({ ...scenario, findingId: "finding-0001" });
    expect(outcome.status).toBe("planned");
    if (outcome.status !== "planned") return;
    expect(outcome.plan.prefixSteps).toHaveLength(3); // fill, fill, click(force-error) — trigger is the 4th step
    expect(outcome.plan.triggerStep.kind).toBe("click");
  });
});
