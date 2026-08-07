import { describe, expect, it } from "vitest";
import type { CheckerResult } from "../../src/checkers/types.ts";
import { buildReport, REPORT_LIMITATIONS, type BuildReportInput } from "../../src/report/build.ts";
import { renderMarkdownReport } from "../../src/report/markdown.ts";
import type { WebCheckReport } from "../../src/report/schema.ts";
import { ev } from "../helpers/synthetic-events.ts";

function baseInput(overrides: Partial<BuildReportInput> = {}): BuildReportInput {
  return {
    runId: "test-run",
    flowName: "test-flow",
    status: "passed",
    startedAt: "2024-01-01T00:00:00.000Z",
    finishedAt: "2024-01-01T00:00:01.000Z",
    durationMs: 1234,
    completedSteps: 2,
    evidencePath: "events.ndjson",
    events: [],
    checkerResults: [],
    ...overrides
  };
}

function headingLines(markdown: string): string[] {
  return markdown.split("\n").filter((line) => /^#{1,6} /.test(line));
}

describe("renderMarkdownReport", () => {
  it("1. renders the expected top-level headings for a clean report", () => {
    const report = buildReport(baseInput());
    const markdown = renderMarkdownReport(report);
    expect(markdown).toContain("# WebCheck Report");
    expect(markdown).toContain("## Run Summary");
    expect(markdown).toContain("## Findings");
    expect(markdown).toContain("## Limitations");
    expect(markdown).toContain("## Artifact References");
  });

  it("2. renders 'No findings detected.' for zero findings", () => {
    const report = buildReport(baseInput());
    const markdown = renderMarkdownReport(report);
    expect(markdown).toContain("No findings detected.");
  });

  it("3. renders finding fields (rule, summary, observed, expected) correctly", () => {
    const events = [ev(1, "runtime_error", { message: "boom" })];
    const checkerResults: CheckerResult[] = [
      {
        ruleId: "RT-EXCEPTION",
        status: "confirmed",
        title: "Uncaught runtime exception",
        summary: "An uncaught exception occurred: boom",
        evidenceSeqs: [1],
        observed: "boom",
        expected: "no uncaught runtime exception"
      }
    ];
    const report = buildReport(baseInput({ events, checkerResults }));
    const markdown = renderMarkdownReport(report);

    expect(markdown).toContain("finding-0001 — Uncaught runtime exception");
    expect(markdown).toContain("Rule: `RT-EXCEPTION`");
    expect(markdown).toContain("An uncaught exception occurred: boom");
    expect(markdown).toContain("boom");
    expect(markdown).toContain("no uncaught runtime exception");
  });

  it("4. renders classification and category correctly", () => {
    const events = [ev(1, "runtime_error", { message: "boom" })];
    const checkerResults: CheckerResult[] = [
      {
        ruleId: "RT-EXCEPTION",
        status: "likely",
        title: "t",
        summary: "s",
        evidenceSeqs: [1],
        observed: "o",
        expected: "e"
      }
    ];
    const report = buildReport(baseInput({ events, checkerResults }));
    const markdown = renderMarkdownReport(report);

    expect(markdown).toContain("Classification: likely");
    expect(markdown).toContain("Category: runtime");
  });

  it("5. omits Action ID when the finding has none", () => {
    const events = [ev(1, "network_failed", { requestId: "req-000001", url: "http://x", method: "GET", failureText: "boom" })];
    const checkerResults: CheckerResult[] = [
      {
        ruleId: "NW-TRANSPORT-FAILURE",
        status: "confirmed",
        title: "t",
        summary: "s",
        evidenceSeqs: [1],
        observed: "o",
        expected: "e"
        // no actionId
      }
    ];
    const report = buildReport(baseInput({ events, checkerResults }));
    const markdown = renderMarkdownReport(report);

    expect(report.findings[0]?.actionId).toBeUndefined();
    expect(markdown).not.toContain("Action ID:");
  });

  it("6. renders evidence seq and type", () => {
    const events = [ev(1, "runtime_error", { message: "boom" })];
    const checkerResults: CheckerResult[] = [
      { ruleId: "RT-EXCEPTION", status: "confirmed", title: "t", summary: "s", evidenceSeqs: [1], observed: "o", expected: "e" }
    ];
    const report = buildReport(baseInput({ events, checkerResults }));
    const markdown = renderMarkdownReport(report);

    expect(markdown).toContain("seq 1, type `runtime_error`");
  });

  it("7. renders requestId when present on an evidence ref", () => {
    const events = [ev(1, "network_response", { requestId: "req-000042", url: "http://x/a", status: 500 })];
    const checkerResults: CheckerResult[] = [
      { ruleId: "NW-HTTP-ERROR", status: "likely", title: "t", summary: "s", evidenceSeqs: [1], observed: "o", expected: "e" }
    ];
    const report = buildReport(baseInput({ events, checkerResults }));
    const markdown = renderMarkdownReport(report);

    expect(markdown).toContain("requestId `req-000042`");
  });

  it("8. renders screenshot path when present on an evidence ref", () => {
    const events = [ev(1, "screenshot", { path: "screenshots/0001-verification-failed.png", reason: "verification_failed" })];
    const checkerResults: CheckerResult[] = [
      { ruleId: "RT-EXCEPTION", status: "warning", title: "t", summary: "s", evidenceSeqs: [1], observed: "o", expected: "e" }
    ];
    const report = buildReport(baseInput({ events, checkerResults }));
    const markdown = renderMarkdownReport(report);

    expect(markdown).toContain("screenshot `screenshots/0001-verification-failed.png`");
    expect(markdown).toContain("- Screenshots: `screenshots/`");
  });

  it("9. renders reproduction info when present", () => {
    const events = [ev(1, "runtime_error", { message: "boom" })];
    const checkerResults: CheckerResult[] = [
      { ruleId: "RT-EXCEPTION", status: "confirmed", title: "t", summary: "s", evidenceSeqs: [1], observed: "o", expected: "e" }
    ];
    const report = buildReport(
      baseInput({ status: "failed", failedStepIndex: 2, failedStepType: "click", events, checkerResults })
    );
    const markdown = renderMarkdownReport(report);

    expect(markdown).toContain("Reproduction:");
    expect(markdown).toContain("- Flow: test-flow");
    expect(markdown).toContain("- Failed step index: 2");
    expect(markdown).toContain("- Failed step type: click");
  });

  it("10. renders limitations exactly as structured report data", () => {
    const report = buildReport(baseInput());
    const markdown = renderMarkdownReport(report);
    for (const limitation of REPORT_LIMITATIONS) {
      expect(markdown).toContain(`- ${limitation}`);
    }
  });

  it("11. produces deterministic (byte-identical) output for the same input", () => {
    const events = [ev(1, "runtime_error", { message: "boom" })];
    const checkerResults: CheckerResult[] = [
      { ruleId: "RT-EXCEPTION", status: "confirmed", title: "t", summary: "s", evidenceSeqs: [1], observed: "o", expected: "e" }
    ];
    const report = buildReport(baseInput({ events, checkerResults }));

    const first = renderMarkdownReport(report);
    const second = renderMarkdownReport(report);
    expect(second).toBe(first);
  });

  it("12. does not mutate the input report object", () => {
    const events = [ev(1, "runtime_error", { message: "boom" })];
    const checkerResults: CheckerResult[] = [
      { ruleId: "RT-EXCEPTION", status: "confirmed", title: "t", summary: "s", evidenceSeqs: [1], observed: "o", expected: "e" }
    ];
    const report = buildReport(baseInput({ events, checkerResults }));
    const clone: WebCheckReport = JSON.parse(JSON.stringify(report));

    renderMarkdownReport(report);

    expect(report).toEqual(clone);
  });

  it("13a. embedded newlines in a finding title cannot inject a fake heading line", () => {
    const events = [ev(1, "runtime_error", { message: "boom" })];
    const checkerResults: CheckerResult[] = [
      {
        ruleId: "RT-EXCEPTION",
        status: "confirmed",
        title: "Weird\n### Fake Heading\nMore",
        summary: "s",
        evidenceSeqs: [1],
        observed: "o",
        expected: "e"
      }
    ];
    const report = buildReport(baseInput({ events, checkerResults }));
    const markdown = renderMarkdownReport(report);

    // Exactly the legitimate structural headings: 1 title, 4 sections,
    // 1 finding heading, 1 Evidence subheading — never an 8th from the
    // injected "### Fake Heading" line, which was flattened into the
    // middle of the finding's own heading line, not a line start.
    expect(headingLines(markdown)).toHaveLength(7);
    expect(markdown).not.toContain("\n### Fake Heading\n");
  });

  it("13b. a backtick run inside free text is fenced with a longer fence so it cannot close the block early", () => {
    const observed = "before\n```\nafter\n# not a real heading\n| col1 | col2 |\nend";
    const events = [ev(1, "runtime_error", { message: "boom" })];
    const checkerResults: CheckerResult[] = [
      { ruleId: "RT-EXCEPTION", status: "confirmed", title: "t", summary: "s", evidenceSeqs: [1], observed, expected: "e" }
    ];
    const report = buildReport(baseInput({ events, checkerResults }));
    const markdown = renderMarkdownReport(report);

    expect(markdown).toContain(`\`\`\`\`\n${observed}\n\`\`\`\``);
  });

  it("13c. extremely long free text is truncated with a visible marker", () => {
    const longText = "x".repeat(10000);
    const events = [ev(1, "runtime_error", { message: "boom" })];
    const checkerResults: CheckerResult[] = [
      { ruleId: "RT-EXCEPTION", status: "confirmed", title: "t", summary: "s", evidenceSeqs: [1], observed: longText, expected: "e" }
    ];
    const report = buildReport(baseInput({ events, checkerResults }));
    const markdown = renderMarkdownReport(report);

    expect(markdown).not.toContain(longText);
    expect(markdown).toContain("truncated");
  });
});
