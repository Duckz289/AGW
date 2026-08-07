import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CheckerResult } from "../../src/checkers/types.ts";
import { renderMarkdownReport } from "../../src/report/markdown.ts";
import { buildReport } from "../../src/report/build.ts";
import { ev } from "../helpers/synthetic-events.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = path.join(__dirname, "__fixtures__", "report-golden.md");

/**
 * Same fixed synthetic report as tests/unit/report-golden.test.ts's JSON
 * golden, fed through renderMarkdownReport() and compared byte-for-byte
 * against a checked-in Markdown fixture — proving Markdown output is
 * derived from the same report shape, not a separate logic path.
 */
describe("markdown golden fixture", () => {
  it("matches tests/unit/__fixtures__/report-golden.md exactly", async () => {
    const events = [
      ev(1, "run_started", {
        runId: "golden-run-id",
        flowName: "golden-flow",
        startUrl: "http://127.0.0.1:4300",
        startedAt: "2024-01-01T00:00:00.000Z"
      }),
      ev(2, "action_started", { actionId: "action-0001", stepIndex: 0, stepType: "click" }, "action-0001"),
      ev(3, "runtime_error", { name: "Error", message: "Fixture: simulated uncaught exception" }, "action-0001"),
      ev(
        4,
        "action_finished",
        { actionId: "action-0001", stepIndex: 0, stepType: "click", ok: true, durationMs: 50 },
        "action-0001"
      ),
      ev(5, "run_finished", { status: "passed", completedSteps: 1, durationMs: 1000 })
    ];

    const checkerResults: CheckerResult[] = [
      {
        ruleId: "RT-EXCEPTION",
        status: "confirmed",
        title: "Uncaught runtime exception",
        summary: "An uncaught exception occurred: Fixture: simulated uncaught exception",
        actionId: "action-0001",
        evidenceSeqs: [3],
        observed: "Fixture: simulated uncaught exception",
        expected: "no uncaught runtime exception"
      }
    ];

    const report = buildReport({
      runId: "golden-run-id",
      flowName: "golden-flow",
      status: "passed",
      startedAt: "2024-01-01T00:00:00.000Z",
      finishedAt: "2024-01-01T00:00:01.000Z",
      durationMs: 1000,
      completedSteps: 1,
      evidencePath: "events.ndjson",
      events,
      checkerResults
    });

    const markdown = renderMarkdownReport(report);
    const golden = await fs.readFile(GOLDEN_PATH, "utf-8");
    expect(markdown).toBe(golden);
  });
});
