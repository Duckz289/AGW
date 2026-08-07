import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFixtureServer, type FixtureServerHandle } from "../../fixtures/server.ts";
import { getClosedLoopbackPort } from "../helpers/closed-port.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, "..", "..");
const CLI_ENTRY = path.join(PROJECT_ROOT, "src", "cli", "index.ts");
// Spawn tsx's CLI entry directly with the current node binary rather than
// via `npm run`/`npx`, for the same Windows process-cleanup reason
// documented in src/mcp/test-client.ts and README.md "Known limitations".
const TSX_CLI = path.join(PROJECT_ROOT, "node_modules", "tsx", "dist", "cli.mjs");

interface CliRunResult {
  code: number | null;
  stdout: string;
}

function runCli(args: string[]): Promise<CliRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX_CLI, CLI_ENTRY, ...args], { cwd: PROJECT_ROOT });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout }));
  });
}

describe("CLI exit codes", () => {
  let fixture: FixtureServerHandle;
  let tmpDir: string;

  beforeEach(async () => {
    fixture = await startFixtureServer();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "webcheck-cli-test-"));
  });

  afterEach(async () => {
    await fixture.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeFlow(name: string, overrides: Record<string, unknown> = {}): Promise<string> {
    const flowPath = path.join(tmpDir, `${name}.json`);
    const flow = {
      name,
      startUrl: fixture.url,
      steps: [
        { type: "fill", target: { label: "Email" }, value: "test@example.com" },
        { type: "fill", target: { label: "Password" }, value: "correct-password" },
        { type: "click", target: { role: "button", name: "Login" } },
        { type: "expect", expected: { kind: "element_visible", role: "heading", name: "Dashboard" } }
      ],
      ...overrides
    };
    await fs.writeFile(flowPath, JSON.stringify(flow, null, 2), "utf-8");
    return flowPath;
  }

  it("exits 0 and prints PASS on a successful flow", async () => {
    const flowPath = await writeFlow("cli-success");
    const { code, stdout } = await runCli(["run", "--flow", flowPath]);
    expect(code).toBe(0);
    expect(stdout).toContain("Result: PASS");
  }, 30000);

  it("exits 1 and prints FAIL when a step fails", async () => {
    const flowPath = await writeFlow("cli-failure", {
      steps: [{ type: "expect", expected: { kind: "text_present", text: "Not on this page" }, timeoutMs: 300 }]
    });
    const { code, stdout } = await runCli(["run", "--flow", flowPath]);
    expect(code).toBe(1);
    expect(stdout).toContain("Result: FAIL");
    expect(stdout).toContain("Verification failed:");
  }, 30000);

  it("exits 2 and prints ERROR for a missing flow file", async () => {
    const missingPath = path.join(tmpDir, "does-not-exist.json");
    const { code, stdout } = await runCli(["run", "--flow", missingPath]);
    expect(code).toBe(2);
    expect(stdout).toContain("Result: ERROR");
  }, 30000);

  it("exits 2 for a flow whose startUrl is outside the loopback allowlist", async () => {
    const flowPath = await writeFlow("cli-policy-denied", {
      startUrl: "https://example.com",
      steps: [{ type: "expect", expected: { kind: "text_present", text: "x" } }]
    });
    const { code, stdout } = await runCli(["run", "--flow", flowPath]);
    expect(code).toBe(2);
    expect(stdout).toContain("Result: ERROR");
  }, 30000);

  it("exits 2 and labels an environment error for a deterministically unreachable loopback target", async () => {
    const closedPort = await getClosedLoopbackPort();
    const flowPath = await writeFlow("cli-environment-error", {
      startUrl: `http://127.0.0.1:${closedPort}`,
      steps: [{ type: "expect", expected: { kind: "text_present", text: "x" } }]
    });
    const { code, stdout } = await runCli(["run", "--flow", flowPath]);
    expect(code).toBe(2);
    expect(stdout).toContain("Result: ERROR");
    expect(stdout).toContain("Environment error:");
  }, 30000);
});
