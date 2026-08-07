import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CheckerResult } from "../../src/checkers/types.ts";
import { buildReport } from "../../src/report/build.ts";
import { ev } from "../helpers/synthetic-events.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = path.join(__dirname, "__fixtures__", "report-golden.json");

/**
 * Proves report shape stability. All "nondeterministic in production"
 * fields (runId, timestamps, durationMs, evidencePath) are fixed,
 * deterministic literals here — buildReport() is a pure function of its
 * input, so there is nothing to normalize after the fact; feeding it
 * fixed input already produces a fixed, comparable output. evidencePath
 * is a plain relative-looking string, not a real absolute path.
 */
describe("report golden fixture", () => {
  it("matches tests/unit/__fixtures__/report-golden.json exactly", async () => {
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

    const golden: unknown = JSON.parse(await fs.readFile(GOLDEN_PATH, "utf-8"));
    expect(report).toEqual(golden);
  });
});
