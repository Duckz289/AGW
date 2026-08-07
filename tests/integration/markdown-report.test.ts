import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFixtureServer, type FixtureServerHandle } from "../../fixtures/server.ts";
import { runFlow } from "../../src/engine/flow-runner.ts";
import { WebCheckReportSchema, type WebCheckReport } from "../../src/report/schema.ts";
import type { ScriptedFlow } from "../../src/schemas/flow.ts";

const SENTINEL_PASSWORD = "WEBCHECK_TEST_PASSWORD_7f4a";
const SENTINEL_TOKEN = "WEBCHECK_TEST_TOKEN_91ce";
const SENTINEL_APIKEY = "WEBCHECK_TEST_APIKEY_a273";

describe("Phase 3B report.md over the real evidence + checker + report pipeline", () => {
  let fixture: FixtureServerHandle;
  let artifactRoot: string;

  beforeEach(async () => {
    fixture = await startFixtureServer();
    artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "webcheck-markdown-report-test-"));
  });

  afterEach(async () => {
    await fixture.close();
    await fs.rm(artifactRoot, { recursive: true, force: true });
  });

  async function readReport(reportPath: string): Promise<WebCheckReport> {
    const raw = await fs.readFile(reportPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    const result = WebCheckReportSchema.safeParse(parsed);
    expect(result.success, result.success ? "" : JSON.stringify((result as { error?: unknown }).error)).toBe(true);
    return parsed as WebCheckReport;
  }

  it("clean flow: report.md exists, says no findings, and its summary counts match report.json", async () => {
    const flow: ScriptedFlow = {
      name: "markdown-clean-flow",
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
    expect(result.evidence.markdownReportPath).not.toBe("");

    const report = await readReport(result.evidence.reportPath);
    const markdown = await fs.readFile(result.evidence.markdownReportPath, "utf-8");

    expect(markdown).toContain("No findings detected.");
    expect(markdown).toContain(`- Findings: ${report.summary.findings}`);
    expect(markdown).toContain(`- Confirmed: ${report.summary.confirmed}`);
    expect(markdown).toContain(`- Likely: ${report.summary.likely}`);
    expect(markdown).toContain(`- Warnings: ${report.summary.warnings}`);
  });

  it("runtime exception: report.md's finding ID, classification, and evidence seq match report.json", async () => {
    const flow: ScriptedFlow = {
      name: "markdown-runtime-exception",
      startUrl: fixture.url,
      steps: [{ type: "click", target: { testId: "throw-error-button" } }]
    };
    const result = await runFlow(flow, { artifactRoot });
    expect(result.status).toBe("passed");

    const report = await readReport(result.evidence.reportPath);
    const markdown = await fs.readFile(result.evidence.markdownReportPath, "utf-8");

    const finding = report.findings.find((f) => f.ruleId === "RT-EXCEPTION");
    expect(finding).toBeDefined();
    expect(markdown).toContain(finding!.id);
    expect(markdown).toContain(`Classification: ${finding!.classification}`);
    for (const evidenceRef of finding!.evidence) {
      expect(markdown).toContain(`seq ${evidenceRef.seq}`);
    }
  });

  it("HTTP 500: report.md contains the NW-HTTP-ERROR finding in the same order as report.json.findings", async () => {
    const flow: ScriptedFlow = {
      name: "markdown-http-500",
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
    const markdown = await fs.readFile(result.evidence.markdownReportPath, "utf-8");

    const finding = report.findings.find((f) => f.ruleId === "NW-HTTP-ERROR");
    expect(finding).toBeDefined();
    expect(markdown).toContain(`### ${finding!.id}`);

    // Deterministic ordering: each finding.id appears in report.md in the
    // same relative order as report.findings.
    const positions = report.findings.map((f) => markdown.indexOf(`### ${f.id}`));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("transport failure: report.md references the real network_failed seq/requestId from report.json", async () => {
    const flow: ScriptedFlow = {
      name: "markdown-transport-failure",
      startUrl: fixture.url,
      steps: [{ type: "click", target: { testId: "transport-fail-button" } }]
    };
    const result = await runFlow(flow, { artifactRoot });
    expect(result.status).toBe("passed");

    const report = await readReport(result.evidence.reportPath);
    const markdown = await fs.readFile(result.evidence.markdownReportPath, "utf-8");

    const finding = report.findings.find((f) => f.ruleId === "NW-TRANSPORT-FAILURE");
    expect(finding).toBeDefined();
    for (const evidenceRef of finding!.evidence) {
      expect(markdown).toContain(`seq ${evidenceRef.seq}`);
      if (evidenceRef.requestId !== undefined) {
        expect(markdown).toContain(`requestId \`${evidenceRef.requestId}\``);
      }
    }
  });

  it("JSON<->Markdown consistency: every finding's id, ruleId, classification, and evidence seqs appear in report.md", async () => {
    const flow: ScriptedFlow = {
      name: "markdown-consistency-flow",
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
    const markdown = await fs.readFile(result.evidence.markdownReportPath, "utf-8");

    expect(report.findings.length).toBeGreaterThan(0);
    for (const finding of report.findings) {
      expect(markdown).toContain(finding.id);
      expect(markdown).toContain(finding.ruleId);
      expect(markdown).toContain(finding.classification);
      for (const evidenceRef of finding.evidence) {
        expect(markdown).toContain(`seq ${evidenceRef.seq}`);
      }
    }
  });

  it("secret scan: raw events.ndjson, report.json, AND report.md all contain no sentinel secrets", async () => {
    const flow: ScriptedFlow = {
      name: "markdown-secret-scan",
      startUrl: fixture.url,
      steps: [
        { type: "click", target: { testId: "log-sensitive-button" } },
        { type: "click", target: { testId: "sensitive-request-button" } },
        { type: "expect", expected: { kind: "text_present", text: "WebCheck Fixture" } }
      ]
    };
    const result = await runFlow(flow, { artifactRoot });
    expect(result.status).toBe("passed");
    expect(result.evidence.markdownReportPath).not.toBe("");

    const rawEvents = await fs.readFile(result.evidence.eventsPath, "utf-8");
    const rawReport = await fs.readFile(result.evidence.reportPath, "utf-8");
    const rawMarkdown = await fs.readFile(result.evidence.markdownReportPath, "utf-8");

    for (const sentinel of [SENTINEL_PASSWORD, SENTINEL_TOKEN, SENTINEL_APIKEY]) {
      expect(rawEvents).not.toContain(sentinel);
      expect(rawReport).not.toContain(sentinel);
      expect(rawMarkdown).not.toContain(sentinel);
    }
  });
});
