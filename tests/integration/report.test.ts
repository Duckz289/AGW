import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFixtureServer, type FixtureServerHandle } from "../../fixtures/server.ts";
import { checkerResultToFinding } from "../../src/findings/from-checker.ts";
import { buildReport, ReportBuildError } from "../../src/report/build.ts";
import { WebCheckReportSchema } from "../../src/report/schema.ts";
import { readTimelineEvents } from "../../src/timeline/read.ts";
import { runFlow } from "../../src/engine/flow-runner.ts";
import type { ScriptedFlow } from "../../src/schemas/flow.ts";

const SENTINEL_PASSWORD = "WEBCHECK_TEST_PASSWORD_7f4a";
const SENTINEL_TOKEN = "WEBCHECK_TEST_TOKEN_91ce";
const SENTINEL_APIKEY = "WEBCHECK_TEST_APIKEY_a273";

describe("Phase 3A report.json over the real evidence + checker pipeline", () => {
  let fixture: FixtureServerHandle;
  let artifactRoot: string;

  beforeEach(async () => {
    fixture = await startFixtureServer();
    artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "webcheck-report-test-"));
  });

  afterEach(async () => {
    await fixture.close();
    await fs.rm(artifactRoot, { recursive: true, force: true });
  });

  async function readReport(reportPath: string): Promise<{
    schemaVersion: number;
    run: Record<string, unknown>;
    summary: { findings: number; confirmed: number; likely: number; warnings: number };
    findings: Array<Record<string, unknown>>;
    limitations: string[];
  }> {
    const raw = await fs.readFile(reportPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    const result = WebCheckReportSchema.safeParse(parsed);
    expect(result.success, result.success ? "" : JSON.stringify((result as { error?: unknown }).error)).toBe(true);
    return parsed as never;
  }

  it("clean flow: report.json exists, 0 findings, an all-zero summary", async () => {
    const flow: ScriptedFlow = {
      name: "report-clean-flow",
      startUrl: fixture.url,
      steps: [
        { type: "fill", target: { label: "Email" }, value: "test@example.com" },
        { type: "fill", target: { label: "Password" }, value: "correct-password" },
        { type: "click", target: { role: "button", name: "Login" } },
        { type: "expect", expected: { kind: "element_visible", role: "heading", name: "Dashboard" } }
      ]
    };
    const result = await runFlow(flow, { artifactRoot });
    expect(result.status).toBe("passed");
    expect(result.evidence.reportPath).not.toBe("");

    const report = await readReport(result.evidence.reportPath);
    expect(report.schemaVersion).toBe(1);
    expect(report.findings).toEqual([]);
    expect(report.summary).toEqual({ findings: 0, confirmed: 0, likely: 0, warnings: 0 });
  });

  it("runtime exception: report contains a confirmed RT-EXCEPTION finding whose evidence points to a real runtime_error seq", async () => {
    const flow: ScriptedFlow = {
      name: "report-runtime-exception",
      startUrl: fixture.url,
      steps: [{ type: "click", target: { testId: "throw-error-button" } }]
    };
    const result = await runFlow(flow, { artifactRoot });
    expect(result.status).toBe("passed");

    const report = await readReport(result.evidence.reportPath);
    const finding = report.findings.find((f) => f["ruleId"] === "RT-EXCEPTION");
    expect(finding).toBeDefined();
    expect(finding?.["classification"]).toBe("confirmed");

    const events = await readTimelineEvents(result.evidence.eventsPath);
    const evidence = finding?.["evidence"] as Array<{ seq: number; type: string }>;
    expect(evidence.length).toBeGreaterThan(0);
    for (const ref of evidence) {
      const realEvent = events.find((e) => e.seq === ref.seq);
      expect(realEvent).toBeDefined();
      expect(realEvent?.type).toBe(ref.type);
    }
    expect(events.some((e) => e.type === "runtime_error" && e.seq === evidence[0]?.seq)).toBe(true);
  });

  it("HTTP 500: report contains NW-HTTP-ERROR whose evidence includes the real network_response seq and requestId", async () => {
    const flow: ScriptedFlow = {
      name: "report-http-500",
      startUrl: fixture.url,
      steps: [
        { type: "fill", target: { label: "Email" }, value: "test@example.com" },
        { type: "fill", target: { label: "Password" }, value: "correct-password" },
        { type: "click", target: { testId: "force-error-checkbox" } },
        { type: "click", target: { role: "button", name: "Login" } }
      ]
    };
    const result = await runFlow(flow, { artifactRoot });
    expect(result.status).toBe("passed");

    const report = await readReport(result.evidence.reportPath);
    const finding = report.findings.find((f) => f["ruleId"] === "NW-HTTP-ERROR");
    expect(finding).toBeDefined();

    const events = await readTimelineEvents(result.evidence.eventsPath);
    const realResponse = events.find(
      (e) => e.type === "network_response" && e.payload.url.includes("/api/login") && e.payload.status === 500
    );
    expect(realResponse).toBeDefined();

    const evidence = finding?.["evidence"] as Array<{ seq: number; requestId?: string }>;
    const responseRef = evidence.find((ref) => ref.seq === realResponse?.seq);
    expect(responseRef).toBeDefined();
    expect(responseRef?.requestId).toBe(realResponse && realResponse.type === "network_response" ? realResponse.payload.requestId : undefined);
  });

  it("transport failure: report contains NW-TRANSPORT-FAILURE whose evidence points to the real network_failed event", async () => {
    const flow: ScriptedFlow = {
      name: "report-transport-failure",
      startUrl: fixture.url,
      steps: [{ type: "click", target: { testId: "transport-fail-button" } }]
    };
    const result = await runFlow(flow, { artifactRoot });
    expect(result.status).toBe("passed");

    const report = await readReport(result.evidence.reportPath);
    const finding = report.findings.find((f) => f["ruleId"] === "NW-TRANSPORT-FAILURE");
    expect(finding).toBeDefined();

    const events = await readTimelineEvents(result.evidence.eventsPath);
    const realFailed = events.find((e) => e.type === "network_failed");
    expect(realFailed).toBeDefined();

    const evidence = finding?.["evidence"] as Array<{ seq: number; type: string }>;
    expect(evidence.some((ref) => ref.seq === realFailed?.seq && ref.type === "network_failed")).toBe(true);
  });

  it("screenshot evidence: resolving a real screenshot seq from a real failing-verification run extracts screenshotPath correctly", async () => {
    const flow: ScriptedFlow = {
      name: "report-screenshot-evidence",
      startUrl: fixture.url,
      steps: [
        {
          type: "expect",
          expected: { kind: "element_visible", role: "heading", name: "Nonexistent Heading" },
          timeoutMs: 300
        }
      ]
    };
    const result = await runFlow(flow, { artifactRoot });
    expect(result.status).toBe("failed");

    const events = await readTimelineEvents(result.evidence.eventsPath);
    const screenshotEvent = events.find((e) => e.type === "screenshot");
    expect(screenshotEvent).toBeDefined();

    // No Phase 2B rule currently references a screenshot seq in its own
    // evidenceSeqs — this proves the *resolution* mechanism against real
    // pipeline output without fabricating a checker association that
    // does not exist (CURRENT_TASK.md).
    const finding = checkerResultToFinding(
      {
        ruleId: "RT-EXCEPTION",
        status: "warning",
        title: "synthetic screenshot-evidence probe",
        summary: "probe",
        evidenceSeqs: [screenshotEvent!.seq],
        observed: "probe",
        expected: "probe"
      },
      0,
      events,
      { flowName: flow.name }
    );

    expect(finding.evidence[0]?.screenshotPath).toBe(
      screenshotEvent!.type === "screenshot" ? screenshotEvent!.payload.path : undefined
    );
  });

  it("secret scan: raw events.ndjson and raw report.json both contain no sentinel secrets", async () => {
    const flow: ScriptedFlow = {
      name: "report-secret-scan",
      startUrl: fixture.url,
      steps: [
        { type: "click", target: { testId: "log-sensitive-button" } },
        { type: "click", target: { testId: "sensitive-request-button" } },
        { type: "expect", expected: { kind: "text_present", text: "WebCheck Fixture" } }
      ]
    };
    const result = await runFlow(flow, { artifactRoot });
    expect(result.status).toBe("passed");

    const rawEvents = await fs.readFile(result.evidence.eventsPath, "utf-8");
    const rawReport = await fs.readFile(result.evidence.reportPath, "utf-8");

    for (const sentinel of [SENTINEL_PASSWORD, SENTINEL_TOKEN, SENTINEL_APIKEY]) {
      expect(rawEvents).not.toContain(sentinel);
      expect(rawReport).not.toContain(sentinel);
    }
  });

  it("report-generation failure: a broken build never corrupts an already-written good report.json", async () => {
    const flow: ScriptedFlow = {
      name: "report-generation-failure-probe",
      startUrl: fixture.url,
      steps: [{ type: "click", target: { testId: "console-log-button" } }]
    };
    const result = await runFlow(flow, { artifactRoot });
    expect(result.status).toBe("passed");
    expect(result.evidence.reportPath).not.toBe("");

    const before = await fs.readFile(result.evidence.reportPath, "utf-8");

    const events = await readTimelineEvents(result.evidence.eventsPath);
    expect(() =>
      buildReport({
        runId: result.runId,
        flowName: flow.name,
        status: "passed",
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
        durationMs: result.durationMs,
        completedSteps: result.completedSteps,
        evidencePath: result.evidence.eventsPath,
        events,
        checkerResults: [
          {
            ruleId: "RT-EXCEPTION",
            status: "confirmed",
            title: "broken",
            summary: "broken",
            evidenceSeqs: [999999],
            observed: "broken",
            expected: "broken"
          }
        ]
      })
    ).toThrow(ReportBuildError);

    const after = await fs.readFile(result.evidence.reportPath, "utf-8");
    expect(after).toBe(before);
    expect(() => JSON.parse(after)).not.toThrow();
  });
});
