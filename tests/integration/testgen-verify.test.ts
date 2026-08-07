import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyGeneratedTest } from "../../src/testgen/verify.ts";

/**
 * Phase 4A.1: proves `verifyGeneratedTest()` structurally distinguishes
 * "the runner/environment could not even produce a pass/fail report"
 * from a normal, expected regression-test outcome. None of these cases
 * launch a real browser — the failure happens before Playwright Test
 * ever gets to running the test body, so these run fast and
 * deterministically without a fixture server.
 */
describe("verifyGeneratedTest — runner/environment failures are distinct from a normal failed assertion", () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), "webcheck-verify-failure-test-"));
  });

  afterEach(async () => {
    await fs.rm(runDir, { recursive: true, force: true });
  });

  it("a nonexistent spec file: executed=false, reason='no_tests_found', never an exitCode/outcome field", async () => {
    const missingPath = path.join(runDir, "does-not-exist.spec.ts");
    const outcome = await verifyGeneratedTest(missingPath);

    expect(outcome.executed).toBe(false);
    if (outcome.executed) throw new Error("expected executed=false");
    expect(outcome.reason).toBe("no_tests_found");
    expect(outcome).not.toHaveProperty("exitCode");
    expect(outcome).not.toHaveProperty("outcome");
  }, 30_000);

  it("a spec file with invalid TypeScript syntax: executed=false, reason='load_error'", async () => {
    const specPath = path.join(runDir, "broken-syntax.spec.ts");
    await fs.writeFile(
      specPath,
      'import { test, expect } from "@playwright/test";\n\ntest("broken", async ({ page }) => {\n  await page.goto(<<<not valid typescript;\n});\n',
      "utf-8"
    );

    const outcome = await verifyGeneratedTest(specPath);

    expect(outcome.executed).toBe(false);
    if (outcome.executed) throw new Error("expected executed=false");
    expect(outcome.reason).toBe("load_error");
  }, 30_000);

  it("a spec file importing a nonexistent module: executed=false, reason='module_resolution_failure'", async () => {
    const specPath = path.join(runDir, "bad-import.spec.ts");
    await fs.writeFile(
      specPath,
      'import { test, expect } from "@playwright/test";\nimport { nothingHere } from "totally-not-a-real-package-xyz";\n\ntest("broken", async ({ page }) => {\n  void nothingHere;\n  await page.goto("http://example.com");\n});\n',
      "utf-8"
    );

    const outcome = await verifyGeneratedTest(specPath);

    expect(outcome.executed).toBe(false);
    if (outcome.executed) throw new Error("expected executed=false");
    expect(outcome.reason).toBe("module_resolution_failure");
  }, 30_000);

  it("distinguishes a genuine runner failure from a normal executed-and-failed result at the type level", async () => {
    const missingPath = path.join(runDir, "does-not-exist-2.spec.ts");
    const outcome = await verifyGeneratedTest(missingPath);

    // A real executed-and-failed outcome always carries exitCode/outcome/
    // durationMs; a runner failure never does — these are structurally
    // disjoint shapes, not just a different boolean flag.
    expect("exitCode" in outcome).toBe(false);
    expect("outcome" in outcome).toBe(false);
    expect("durationMs" in outcome).toBe(false);
    expect("reason" in outcome).toBe(true);
    expect("message" in outcome).toBe(true);
  }, 30_000);
});
