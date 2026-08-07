import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildReport } from "../../src/report/build.ts";
import { ReportWriteError, writeReport } from "../../src/report/write.ts";

describe("writeReport", () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), "webcheck-report-write-test-"));
  });

  afterEach(async () => {
    await fs.rm(runDir, { recursive: true, force: true });
  });

  function sampleReport() {
    return buildReport({
      runId: "test-run",
      flowName: "test-flow",
      status: "passed",
      startedAt: "2024-01-01T00:00:00.000Z",
      finishedAt: "2024-01-01T00:00:01.000Z",
      durationMs: 1000,
      completedSteps: 1,
      evidencePath: "events.ndjson",
      events: [],
      checkerResults: []
    });
  }

  it("writes valid, pretty-printed UTF-8 JSON at <runDir>/report.json", async () => {
    const reportPath = await writeReport(sampleReport(), runDir);
    expect(reportPath).toBe(path.join(runDir, "report.json"));

    const raw = await fs.readFile(reportPath, "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(raw).toContain("\n  "); // pretty-printed (indented), not minified
    const parsed = JSON.parse(raw) as { schemaVersion: number };
    expect(parsed.schemaVersion).toBe(1);
  });

  it("leaves no temp file behind after a successful write", async () => {
    await writeReport(sampleReport(), runDir);
    const entries = await fs.readdir(runDir);
    expect(entries).toEqual(["report.json"]);
  });

  it("overwrites an existing report.json atomically", async () => {
    await fs.writeFile(path.join(runDir, "report.json"), "OLD CONTENT", "utf-8");
    await writeReport(sampleReport(), runDir);
    const raw = await fs.readFile(path.join(runDir, "report.json"), "utf-8");
    expect(raw).not.toBe("OLD CONTENT");
    expect(JSON.parse(raw)).toMatchObject({ schemaVersion: 1 });
  });

  it("throws ReportWriteError and leaves no report.json or temp file when the target directory does not exist", async () => {
    const missingDir = path.join(runDir, "does-not-exist");
    await expect(writeReport(sampleReport(), missingDir)).rejects.toThrow(ReportWriteError);

    const parentEntries = await fs.readdir(runDir);
    expect(parentEntries).toEqual([]);
  });

  it("does not corrupt a pre-existing report.json when a later write fails", async () => {
    await writeReport(sampleReport(), runDir);
    const before = await fs.readFile(path.join(runDir, "report.json"), "utf-8");

    // Simulate a failing subsequent write by targeting a nonexistent
    // sibling directory — writeReport must never touch the *original*
    // runDir's report.json in the process.
    const missingDir = path.join(runDir, "nested", "missing");
    await expect(writeReport(sampleReport(), missingDir)).rejects.toThrow(ReportWriteError);

    const after = await fs.readFile(path.join(runDir, "report.json"), "utf-8");
    expect(after).toBe(before);
  });
});
