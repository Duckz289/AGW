import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFixtureServer, type FixtureServerHandle } from "../../fixtures/server.ts";
import { runFlow } from "../../src/engine/flow-runner.ts";
import type { ScriptedFlow } from "../../src/schemas/flow.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, "..", "..");
const CLI_ENTRY = path.join(PROJECT_ROOT, "src", "cli", "index.ts");
// Same Windows `.cmd`-wrapper-avoidance pattern as tests/integration/cli.test.ts.
const TSX_CLI = path.join(PROJECT_ROOT, "node_modules", "tsx", "dist", "cli.mjs");

interface CliRunResult {
  code: number | null;
  stdout: string;
}

function runCli(args: string[], env: Record<string, string> = {}): Promise<CliRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX_CLI, CLI_ENTRY, ...args], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...env }
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout }));
  });
}

/**
 * Phase 4A.1: proves `webcheck export-test ... --verify`'s real, spawned
 * CLI output unambiguously distinguishes "generated only", "verification
 * passed", and "verification failed" (a still-buggy target — expected,
 * not a WebCheck error). Uses the project's own default `.webcheck/runs/`
 * artifact root (export-test has no `--artifact-root` override), so the
 * run directory this test creates is removed in `afterEach`.
 */
describe("export-test CLI output (real subprocess)", () => {
  let fixture: FixtureServerHandle;
  let runId: string | undefined;

  beforeEach(async () => {
    fixture = await startFixtureServer(0, { mode: "buggy" });
  });

  afterEach(async () => {
    await fixture.close();
    if (runId) {
      await fs.rm(path.join(PROJECT_ROOT, ".webcheck", "runs", runId), { recursive: true, force: true });
    }
  });

  async function generateRtExceptionRun(): Promise<{ runId: string; findingId: string }> {
    const flow: ScriptedFlow = {
      name: "export-test-cli-rt-exception",
      startUrl: fixture.url,
      steps: [{ type: "click", target: { testId: "throw-error-button" } }]
    };
    const result = await runFlow(flow); // default artifactRoot: <PROJECT_ROOT>/.webcheck/runs
    expect(result.status).toBe("passed");
    runId = result.runId;

    const report: { findings: Array<{ id: string; ruleId: string }> } = JSON.parse(
      await fs.readFile(result.evidence.reportPath, "utf-8")
    );
    const finding = report.findings.find((f) => f.ruleId === "RT-EXCEPTION");
    expect(finding).toBeDefined();
    return { runId: result.runId, findingId: finding!.id };
  }

  it(
    "generated only (no --verify): prints Status: generated, no Verification lines",
    async () => {
      const { runId: rid, findingId } = await generateRtExceptionRun();
      const { code, stdout } = await runCli(["export-test", rid, findingId]);

      expect(code).toBe(0);
      expect(stdout).toContain("Status: generated");
      expect(stdout).not.toContain("Verification executed");
    },
    30_000
  );

  it(
    "--verify against a buggy target: prints executed=yes, outcome=failed, a nonzero exit code, and CLI exit 0",
    async () => {
      const { runId: rid, findingId } = await generateRtExceptionRun();
      const { code, stdout } = await runCli(["export-test", rid, findingId, "--verify"], {
        WEBCHECK_BASE_URL: fixture.url
      });

      expect(stdout).toContain("Status: generated");
      expect(stdout).toContain("Verification executed: yes");
      expect(stdout).toContain("Verification outcome: failed");
      expect(stdout).toMatch(/Exit code: [1-9]\d*/);
      // A failing regression assertion is success for export-test itself
      // (the generator found the defect) — not a WebCheck internal error.
      expect(code).toBe(0);
    },
    30_000
  );

  it(
    "--verify against a fixed target: prints executed=yes, outcome=passed, exit code 0",
    async () => {
      const { runId: rid, findingId } = await generateRtExceptionRun();
      const fixedFixture = await startFixtureServer(0, { mode: "fixed" });
      try {
        const { code, stdout } = await runCli(["export-test", rid, findingId, "--verify"], {
          WEBCHECK_BASE_URL: fixedFixture.url
        });

        expect(stdout).toContain("Status: generated");
        expect(stdout).toContain("Verification executed: yes");
        expect(stdout).toContain("Verification outcome: passed");
        expect(stdout).toContain("Exit code: 0");
        expect(code).toBe(0);
      } finally {
        await fixedFixture.close();
      }
    },
    30_000
  );
});
