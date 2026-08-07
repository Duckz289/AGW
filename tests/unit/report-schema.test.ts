import { describe, expect, it } from "vitest";
import { FindingSchema } from "../../src/findings/schema.ts";
import { WebCheckReportSchema } from "../../src/report/schema.ts";

function validFinding(): unknown {
  return {
    id: "finding-0001",
    ruleId: "RT-EXCEPTION",
    title: "Uncaught runtime exception",
    classification: "confirmed",
    category: "runtime",
    summary: "An uncaught exception occurred: boom",
    observed: "boom",
    expected: "no uncaught runtime exception",
    evidence: [{ seq: 1, type: "runtime_error" }]
  };
}

function validReport(): unknown {
  return {
    schemaVersion: 1,
    run: {
      runId: "test-run",
      flowName: "test-flow",
      status: "passed",
      startedAt: "2024-01-01T00:00:00.000Z",
      finishedAt: "2024-01-01T00:00:01.000Z",
      durationMs: 1000,
      completedSteps: 1,
      evidencePath: "events.ndjson"
    },
    summary: { findings: 0, confirmed: 0, likely: 0, warnings: 0 },
    findings: [],
    limitations: []
  };
}

describe("FindingSchema", () => {
  it("accepts a well-formed finding", () => {
    expect(FindingSchema.safeParse(validFinding()).success).toBe(true);
  });

  it("rejects a malformed finding missing required fields", () => {
    const { id: _id, ...malformed } = validFinding() as Record<string, unknown>;
    expect(FindingSchema.safeParse(malformed).success).toBe(false);
  });

  it("rejects an invalid classification value", () => {
    const malformed = { ...(validFinding() as Record<string, unknown>), classification: "critical" };
    expect(FindingSchema.safeParse(malformed).success).toBe(false);
  });

  it("rejects an invalid category value", () => {
    const malformed = { ...(validFinding() as Record<string, unknown>), category: "security" };
    expect(FindingSchema.safeParse(malformed).success).toBe(false);
  });
});

describe("WebCheckReportSchema", () => {
  it("accepts a well-formed report", () => {
    expect(WebCheckReportSchema.safeParse(validReport()).success).toBe(true);
  });

  it("fixes schemaVersion at 1 and rejects any other value", () => {
    const malformed = { ...(validReport() as Record<string, unknown>), schemaVersion: 2 };
    expect(WebCheckReportSchema.safeParse(malformed).success).toBe(false);
  });

  it("rejects a report containing a malformed finding", () => {
    const { id: _id, ...brokenFinding } = validFinding() as Record<string, unknown>;
    const malformed = { ...(validReport() as Record<string, unknown>), findings: [brokenFinding] };
    expect(WebCheckReportSchema.safeParse(malformed).success).toBe(false);
  });

  it("rejects a report with an invalid run status", () => {
    const base = validReport() as { run: Record<string, unknown> } & Record<string, unknown>;
    const malformed = { ...base, run: { ...base.run, status: "unknown_status" } };
    expect(WebCheckReportSchema.safeParse(malformed).success).toBe(false);
  });
});
