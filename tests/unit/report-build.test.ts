import { describe, expect, it } from "vitest";
import type { CheckerResult } from "../../src/checkers/types.ts";
import { MissingEvidenceError } from "../../src/findings/from-checker.ts";
import { ReportBuildError, buildReport, type BuildReportInput } from "../../src/report/build.ts";
import { ev } from "../helpers/synthetic-events.ts";

function baseInput(overrides: Partial<BuildReportInput> = {}): BuildReportInput {
  return {
    runId: "test-run",
    flowName: "test-flow",
    status: "passed",
    startedAt: "2024-01-01T00:00:00.000Z",
    finishedAt: "2024-01-01T00:00:01.000Z",
    durationMs: 1000,
    completedSteps: 3,
    evidencePath: "events.ndjson",
    events: [],
    checkerResults: [],
    ...overrides
  };
}

describe("buildReport", () => {
  it("computes summary counts correctly across mixed classifications", () => {
    const events = [
      ev(1, "runtime_error", { message: "a" }),
      ev(2, "network_response", { requestId: "req-000001", url: "http://x/a", status: 500 }),
      ev(3, "network_response", { requestId: "req-000002", url: "http://x/b", status: 404 })
    ];
    const checkerResults: CheckerResult[] = [
      { ruleId: "RT-EXCEPTION", status: "confirmed", title: "t", summary: "s", evidenceSeqs: [1], observed: "o", expected: "e" },
      { ruleId: "NW-HTTP-ERROR", status: "likely", title: "t", summary: "s", evidenceSeqs: [2], observed: "o", expected: "e" },
      { ruleId: "NW-HTTP-ERROR", status: "likely", title: "t", summary: "s", evidenceSeqs: [3], observed: "o", expected: "e" }
    ];

    const report = buildReport(baseInput({ events, checkerResults }));
    expect(report.summary).toEqual({ findings: 3, confirmed: 1, likely: 2, warnings: 0 });
    expect(report.findings).toHaveLength(3);
  });

  it("is deterministic: identical input produces an identical report", () => {
    const events = [ev(1, "runtime_error", { message: "a" })];
    const checkerResults: CheckerResult[] = [
      { ruleId: "RT-EXCEPTION", status: "confirmed", title: "t", summary: "s", evidenceSeqs: [1], observed: "o", expected: "e" }
    ];
    const input = baseInput({ events, checkerResults });

    const first = buildReport(input);
    const second = buildReport(input);
    expect(second).toEqual(first);
  });

  it("has schemaVersion 1", () => {
    expect(buildReport(baseInput()).schemaVersion).toBe(1);
  });

  it("produces zero findings and an all-zero summary for an empty checkerResults array", () => {
    const report = buildReport(baseInput());
    expect(report.findings).toEqual([]);
    expect(report.summary).toEqual({ findings: 0, confirmed: 0, likely: 0, warnings: 0 });
  });

  it("throws ReportBuildError (wrapping MissingEvidenceError) when a checker result references a nonexistent seq", () => {
    const checkerResults: CheckerResult[] = [
      { ruleId: "RT-EXCEPTION", status: "confirmed", title: "t", summary: "s", evidenceSeqs: [999], observed: "o", expected: "e" }
    ];
    const input = baseInput({ events: [], checkerResults });

    expect(() => buildReport(input)).toThrow(ReportBuildError);
    try {
      buildReport(input);
      expect.fail("expected buildReport to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ReportBuildError);
      expect((err as ReportBuildError).cause).toBeInstanceOf(MissingEvidenceError);
    }
  });

  it("omits failedStepIndex/failedStepType from reproduction when not provided", () => {
    const report = buildReport(baseInput());
    // No findings in this case, but exercised via the reproduction
    // builder indirectly through a finding-bearing report below.
    const withFinding = buildReport(
      baseInput({
        events: [ev(1, "runtime_error", { message: "a" })],
        checkerResults: [
          { ruleId: "RT-EXCEPTION", status: "confirmed", title: "t", summary: "s", evidenceSeqs: [1], observed: "o", expected: "e" }
        ]
      })
    );
    expect(withFinding.findings[0]?.reproduction).toEqual({ flowName: "test-flow" });
    expect(report.findings).toEqual([]);
  });

  it("includes failedStepIndex/failedStepType in reproduction when the run failed on a real step", () => {
    const report = buildReport(
      baseInput({
        status: "failed",
        failedStepIndex: 2,
        failedStepType: "click",
        events: [ev(1, "runtime_error", { message: "a" })],
        checkerResults: [
          { ruleId: "RT-EXCEPTION", status: "confirmed", title: "t", summary: "s", evidenceSeqs: [1], observed: "o", expected: "e" }
        ]
      })
    );
    expect(report.findings[0]?.reproduction).toEqual({
      flowName: "test-flow",
      failedStepIndex: 2,
      failedStepType: "click"
    });
  });
});
