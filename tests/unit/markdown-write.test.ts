import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MarkdownWriteError, writeMarkdownReport } from "../../src/report/write-markdown.ts";

describe("writeMarkdownReport", () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), "webcheck-markdown-write-test-"));
  });

  afterEach(async () => {
    await fs.rm(runDir, { recursive: true, force: true });
  });

  it("14. writes a UTF-8 report.md file with the given content at <runDir>/report.md", async () => {
    const markdown = "# WebCheck Report\n\nsome unicode: café ✅\n";
    const reportPath = await writeMarkdownReport(runDir, markdown);
    expect(reportPath).toBe(path.join(runDir, "report.md"));

    const raw = await fs.readFile(reportPath, "utf-8");
    expect(raw).toBe(markdown);
  });

  it("leaves no temp file behind after a successful write", async () => {
    await writeMarkdownReport(runDir, "# WebCheck Report\n");
    const entries = await fs.readdir(runDir);
    expect(entries).toEqual(["report.md"]);
  });

  it("overwrites an existing report.md atomically", async () => {
    await fs.writeFile(path.join(runDir, "report.md"), "OLD CONTENT", "utf-8");
    await writeMarkdownReport(runDir, "# WebCheck Report\n");
    const raw = await fs.readFile(path.join(runDir, "report.md"), "utf-8");
    expect(raw).not.toBe("OLD CONTENT");
    expect(raw).toBe("# WebCheck Report\n");
  });

  it("15. throws MarkdownWriteError and leaves no report.md or temp file when the target directory does not exist", async () => {
    const missingDir = path.join(runDir, "does-not-exist");
    await expect(writeMarkdownReport(missingDir, "# WebCheck Report\n")).rejects.toThrow(MarkdownWriteError);

    const parentEntries = await fs.readdir(runDir);
    expect(parentEntries).toEqual([]);
  });

  it("15b. does not corrupt a pre-existing report.md when a later write fails", async () => {
    await writeMarkdownReport(runDir, "# WebCheck Report\n\nfirst\n");
    const before = await fs.readFile(path.join(runDir, "report.md"), "utf-8");

    const missingDir = path.join(runDir, "nested", "missing");
    await expect(writeMarkdownReport(missingDir, "# WebCheck Report\n\nsecond\n")).rejects.toThrow(MarkdownWriteError);

    const after = await fs.readFile(path.join(runDir, "report.md"), "utf-8");
    expect(after).toBe(before);
  });
});
