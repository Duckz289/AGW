import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TestWriteError, writeGeneratedTest } from "../../src/testgen/write.ts";

describe("writeGeneratedTest", () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), "webcheck-testgen-write-test-"));
  });

  afterEach(async () => {
    await fs.rm(runDir, { recursive: true, force: true });
  });

  it("3. writes a deterministic path derived only from findingId (generated-tests/<findingId>.spec.ts)", async () => {
    const outputPath = await writeGeneratedTest(runDir, "finding-0001", "// content\n");
    expect(outputPath).toBe(path.join(runDir, "generated-tests", "finding-0001.spec.ts"));
  });

  it("creates generated-tests/ if it does not already exist", async () => {
    await writeGeneratedTest(runDir, "finding-0002", "// content\n");
    const entries = await fs.readdir(path.join(runDir, "generated-tests"));
    expect(entries).toEqual(["finding-0002.spec.ts"]);
  });

  it("leaves no temp file behind after a successful write", async () => {
    await writeGeneratedTest(runDir, "finding-0003", "// content\n");
    const entries = await fs.readdir(path.join(runDir, "generated-tests"));
    expect(entries).toEqual(["finding-0003.spec.ts"]);
  });

  it("writes UTF-8 content byte-identical to the given source", async () => {
    const source = "// content with unicode: café ✅\n";
    const outputPath = await writeGeneratedTest(runDir, "finding-0004", source);
    const raw = await fs.readFile(outputPath, "utf-8");
    expect(raw).toBe(source);
  });

  it("rejects a findingId that is not the deterministic finding-N shape (path-traversal guard)", async () => {
    await expect(writeGeneratedTest(runDir, "../../etc/passwd", "x")).rejects.toThrow(TestWriteError);
    await expect(writeGeneratedTest(runDir, "finding-0001.spec.ts", "x")).rejects.toThrow(TestWriteError);
  });

  it("does not corrupt a pre-existing generated test when a later write fails", async () => {
    await writeGeneratedTest(runDir, "finding-0005", "// original\n");
    const before = await fs.readFile(path.join(runDir, "generated-tests", "finding-0005.spec.ts"), "utf-8");

    // "blocked-file" is a regular file, not a directory — attempting to
    // create <blocked-file>/generated-tests fails with ENOTDIR, forcing a
    // genuine write failure unrelated to the original run's own artifact.
    const blockedRunDir = path.join(runDir, "blocked-file");
    await fs.writeFile(blockedRunDir, "x", "utf-8");
    await expect(writeGeneratedTest(blockedRunDir, "finding-0005", "// new")).rejects.toThrow(TestWriteError);

    const after = await fs.readFile(path.join(runDir, "generated-tests", "finding-0005.spec.ts"), "utf-8");
    expect(after).toBe(before);
  });
});
