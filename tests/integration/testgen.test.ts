import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFixtureServer, type FixtureServerHandle } from "../../fixtures/server.ts";
import { runFlow } from "../../src/engine/flow-runner.ts";
import { WebCheckReportSchema, type WebCheckReport } from "../../src/report/schema.ts";
import { ScriptedFlowSchema, type ScriptedFlow } from "../../src/schemas/flow.ts";
import { generateTest } from "../../src/testgen/generator.ts";
import type { TestVerificationResult, VerificationOutcome } from "../../src/testgen/types.ts";
import { verifyGeneratedTest } from "../../src/testgen/verify.ts";
import { readTimelineEvents } from "../../src/timeline/read.ts";

function expectExecuted(outcome: VerificationOutcome): TestVerificationResult {
  if (!outcome.executed) {
    throw new Error(`expected the generated test to execute, but it did not: ${outcome.reason} — ${outcome.message}`);
  }
  return outcome;
}

const SENTINEL_PASSWORD = "WEBCHECK_TEST_PASSWORD_7f4a";
const SENTINEL_TOKEN = "WEBCHECK_TEST_TOKEN_91ce";
const SENTINEL_APIKEY = "WEBCHECK_TEST_APIKEY_a273";

async function readReport(reportPath: string): Promise<WebCheckReport> {
  const raw = await fs.readFile(reportPath, "utf-8");
  const parsed = WebCheckReportSchema.safeParse(JSON.parse(raw));
  expect(parsed.success, parsed.success ? "" : JSON.stringify((parsed as { error?: unknown }).error)).toBe(true);
  return (parsed as { success: true; data: WebCheckReport }).data;
}

async function readFlowArtifact(flowPath: string): Promise<ScriptedFlow> {
  const raw = await fs.readFile(flowPath, "utf-8");
  const parsed = ScriptedFlowSchema.safeParse(JSON.parse(raw));
  expect(parsed.success, parsed.success ? "" : JSON.stringify((parsed as { error?: unknown }).error)).toBe(true);
  return (parsed as { success: true; data: ScriptedFlow }).data;
}

describe("Phase 4A regression test generation over the real pipeline", () => {
  let buggyFixture: FixtureServerHandle;
  let artifactRoot: string;

  // Only the buggy fixture runs during runFlow() itself in every test —
  // deliberately not started concurrently with a second server, which
  // was found (empirically) to add enough scheduling pressure to
  // reliably trigger the *already-documented* README limitation ("the
  // very last network-triggering action's trailing network event can
  // race with run teardown and be absent"). The fixed-mode fixture is
  // started later, only once runFlow()+generation have already
  // completed and read back a stable events.ndjson, so it never
  // contends with that window.
  beforeEach(async () => {
    buggyFixture = await startFixtureServer(0, { mode: "buggy" });
    artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "webcheck-testgen-integration-"));
  });

  afterEach(async () => {
    await buggyFixture.close();
    await fs.rm(artifactRoot, { recursive: true, force: true });
  });

  async function generateFromRealRun(flow: ScriptedFlow, ruleId: string): Promise<{ outputPath: string }> {
    const result = await runFlow(flow, { artifactRoot });
    expect(result.evidence.reportPath).not.toBe("");

    const report = await readReport(result.evidence.reportPath);
    const persistedFlow = await readFlowArtifact(path.join(result.evidence.runDir, "flow.json"));
    const events = await readTimelineEvents(result.evidence.eventsPath);

    const finding = report.findings.find((f) => f.ruleId === ruleId);
    expect(finding, `expected a ${ruleId} finding in report.findings`).toBeDefined();

    const genResult = await generateTest({
      report,
      flow: persistedFlow,
      events,
      findingId: finding!.id,
      runId: result.runId,
      runDir: result.evidence.runDir
    });

    expect(genResult.status).toBe("generated");
    expect(genResult.outputPath).toBeDefined();
    return { outputPath: genResult.outputPath! };
  }

  async function verifyAgainstFixedFixture(outputPath: string): Promise<void> {
    const fixedFixture = await startFixtureServer(0, { mode: "fixed" });
    try {
      const outcome = expectExecuted(await verifyGeneratedTest(outputPath, { baseUrl: fixedFixture.url }));
      expect(outcome.outcome).toBe("passed");
      expect(outcome.exitCode).toBe(0);
    } finally {
      await fixedFixture.close();
    }
  }

  it(
    "RT-EXCEPTION: generated test fails against the buggy fixture and passes against the fixed fixture",
    async () => {
      const flow: ScriptedFlow = {
        name: "testgen-rt-exception",
        startUrl: buggyFixture.url,
        steps: [{ type: "click", target: { testId: "throw-error-button" } }]
      };

      const { outputPath } = await generateFromRealRun(flow, "RT-EXCEPTION");

      const buggyOutcome = expectExecuted(await verifyGeneratedTest(outputPath, { baseUrl: buggyFixture.url }));
      expect(buggyOutcome.outcome).toBe("failed");
      expect(buggyOutcome.exitCode).not.toBe(0);

      await verifyAgainstFixedFixture(outputPath);
    },
    30_000
  );

  it(
    "NW-HTTP-ERROR: generated test fails against the buggy fixture and passes against the fixed fixture",
    async () => {
      const flow: ScriptedFlow = {
        name: "testgen-nw-http-error",
        startUrl: buggyFixture.url,
        steps: [
          { type: "fill", target: { label: "Email" }, value: "test@example.com" },
          { type: "fill", target: { label: "Password" }, value: "correct-password" },
          { type: "click", target: { testId: "force-error-checkbox" } },
          {
            type: "click",
            target: { role: "button", name: "Login" },
            // Inline expectation only to give the async fetch() response
            // time to land before finalize() reads events.ndjson back —
            // see README's documented "very last network-triggering
            // action" evidence-collection race; the generator itself
            // never reads this expectation.
            expected: { kind: "element_visible", role: "heading", name: "Dashboard" },
            timeoutMs: 800
          }
        ]
      };

      const { outputPath } = await generateFromRealRun(flow, "NW-HTTP-ERROR");

      const buggyOutcome = expectExecuted(await verifyGeneratedTest(outputPath, { baseUrl: buggyFixture.url }));
      expect(buggyOutcome.outcome).toBe("failed");
      expect(buggyOutcome.exitCode).not.toBe(0);

      await verifyAgainstFixedFixture(outputPath);
    },
    30_000
  );

  it(
    "NW-TRANSPORT-FAILURE: generated test fails against the buggy fixture and passes against the fixed fixture",
    async () => {
      const flow: ScriptedFlow = {
        name: "testgen-nw-transport-failure",
        startUrl: buggyFixture.url,
        steps: [{ type: "click", target: { testId: "transport-fail-button" } }]
      };

      const { outputPath } = await generateFromRealRun(flow, "NW-TRANSPORT-FAILURE");

      const buggyOutcome = expectExecuted(await verifyGeneratedTest(outputPath, { baseUrl: buggyFixture.url }));
      expect(buggyOutcome.outcome).toBe("failed");
      expect(buggyOutcome.exitCode).not.toBe(0);

      await verifyAgainstFixedFixture(outputPath);
    },
    30_000
  );

  it("unsupported finding (ST-INFINITE-LOADING): no file is generated, structured unsupported result returned", async () => {
    const flow: ScriptedFlow = {
      name: "testgen-unsupported",
      startUrl: buggyFixture.url,
      checks: { loadingIndicator: { role: "status", name: "Loading" } },
      steps: [
        { type: "click", target: { testId: "infinite-loading-button" } },
        { type: "expect", expected: { kind: "element_visible", role: "status", name: "Loading" } },
        { type: "expect", expected: { kind: "element_visible", role: "heading", name: "Dashboard" }, timeoutMs: 300 }
      ]
    };

    const result = await runFlow(flow, { artifactRoot });
    const report = await readReport(result.evidence.reportPath);
    const persistedFlow = await readFlowArtifact(path.join(result.evidence.runDir, "flow.json"));
    const events = await readTimelineEvents(result.evidence.eventsPath);

    const finding = report.findings.find((f) => f.ruleId === "ST-INFINITE-LOADING");
    expect(finding).toBeDefined();

    const genResult = await generateTest({
      report,
      flow: persistedFlow,
      events,
      findingId: finding!.id,
      runId: result.runId,
      runDir: result.evidence.runDir
    });

    expect(genResult.status).toBe("unsupported");
    expect(genResult.outputPath).toBeUndefined();

    const generatedTestsDir = path.join(result.evidence.runDir, "generated-tests");
    await expect(fs.access(generatedTestsDir)).rejects.toThrow();
  });

  it("secret scan: raw bytes of a generated .spec.ts contain no sentinel secrets", async () => {
    // The only vectors for a secret to reach a generated NW-HTTP-ERROR
    // test are replayed fill/navigate values from flow.json — a
    // password-labeled field is the realistic, deterministically-caught
    // case (src/engine/flow-persist.ts's targetLooksSensitive), matching
    // this codebase's established sentinel convention.
    const flow: ScriptedFlow = {
      name: "testgen-secret-scan",
      startUrl: buggyFixture.url,
      steps: [
        { type: "fill", target: { label: "Email" }, value: "test@example.com" },
        { type: "fill", target: { label: "Password" }, value: SENTINEL_PASSWORD },
        { type: "click", target: { testId: "force-error-checkbox" } },
        {
          type: "click",
          target: { role: "button", name: "Login" },
          expected: { kind: "element_visible", role: "heading", name: "Dashboard" },
          timeoutMs: 800
        }
      ]
    };

    const { outputPath } = await generateFromRealRun(flow, "NW-HTTP-ERROR");
    const rawSource = await fs.readFile(outputPath, "utf-8");

    for (const sentinel of [SENTINEL_PASSWORD, SENTINEL_TOKEN, SENTINEL_APIKEY]) {
      expect(rawSource).not.toContain(sentinel);
    }
  });
});
