import { describe, expect, it } from "vitest";
import { exportTestExitCode, formatExportTestOutput } from "../../src/cli/index.ts";
import type { GeneratedTestResult } from "../../src/testgen/types.ts";

const CWD = "C:\\project";

describe("formatExportTestOutput / exportTestExitCode", () => {
  it("generated only (no --verify): no Verification lines at all, exit 0", () => {
    const result: GeneratedTestResult = {
      status: "generated",
      findingId: "finding-0001",
      ruleId: "RT-EXCEPTION",
      outputPath: "C:\\project\\.webcheck\\runs\\r1\\generated-tests\\finding-0001.spec.ts"
    };
    const lines = formatExportTestOutput(result, CWD);
    expect(lines).toEqual([
      "Finding: finding-0001",
      "Rule: RT-EXCEPTION",
      "Status: generated",
      "Test: .webcheck\\runs\\r1\\generated-tests\\finding-0001.spec.ts"
    ]);
    expect(exportTestExitCode(result.status)).toBe(0);
  });

  it("verification executed, outcome passed: prints executed/outcome/exit code, exit 0", () => {
    const result: GeneratedTestResult = {
      status: "generated",
      findingId: "finding-0001",
      ruleId: "NW-HTTP-ERROR",
      outputPath: "C:\\project\\.webcheck\\runs\\r1\\generated-tests\\finding-0001.spec.ts",
      verification: { executed: true, outcome: "passed", exitCode: 0, durationMs: 1200, output: "1 passed" }
    };
    const lines = formatExportTestOutput(result, CWD);
    expect(lines).toContain("Verification executed: yes");
    expect(lines).toContain("Verification outcome: passed");
    expect(lines).toContain("Exit code: 0");
    expect(lines.some((l) => l.startsWith("Verification reason"))).toBe(false);
    expect(exportTestExitCode(result.status)).toBe(0);
  });

  it("verification executed, outcome failed (bug still reproduces): status stays 'generated', exit 0 — not treated as a WebCheck failure", () => {
    const result: GeneratedTestResult = {
      status: "generated",
      findingId: "finding-0001",
      ruleId: "NW-HTTP-ERROR",
      outputPath: "C:\\project\\.webcheck\\runs\\r1\\generated-tests\\finding-0001.spec.ts",
      verification: { executed: true, outcome: "failed", exitCode: 1, durationMs: 1500, output: "1 failed" }
    };
    const lines = formatExportTestOutput(result, CWD);
    expect(lines).toContain("Status: generated");
    expect(lines).toContain("Verification executed: yes");
    expect(lines).toContain("Verification outcome: failed");
    expect(lines).toContain("Exit code: 1");
    expect(exportTestExitCode(result.status)).toBe(0);
  });

  it("verification could not execute: prints executed=no and a reason, never an outcome/exit code line, exit 2", () => {
    const result: GeneratedTestResult = {
      status: "verification_failed",
      findingId: "finding-0001",
      ruleId: "NW-HTTP-ERROR",
      outputPath: "C:\\project\\.webcheck\\runs\\r1\\generated-tests\\finding-0001.spec.ts",
      verification: {
        executed: false,
        reason: "module_resolution_failure",
        message: "Cannot find module '@playwright/test'",
        output: "Error: Cannot find module '@playwright/test'"
      }
    };
    const lines = formatExportTestOutput(result, CWD);
    expect(lines).toContain("Status: verification_failed");
    expect(lines).toContain("Verification executed: no");
    expect(lines).toContain("Verification reason: module_resolution_failure");
    expect(lines.some((l) => l.startsWith("Verification outcome:"))).toBe(false);
    expect(lines.some((l) => l.startsWith("Exit code:"))).toBe(false);
    expect(exportTestExitCode(result.status)).toBe(2);
  });

  it("unsupported: prints reason, no Test/Verification lines, exit 1", () => {
    const result: GeneratedTestResult = {
      status: "unsupported",
      findingId: "finding-0002",
      ruleId: "ST-INFINITE-LOADING",
      reason: "rule \"ST-INFINITE-LOADING\" is not a Phase 4A-supported Finding class"
    };
    const lines = formatExportTestOutput(result, CWD);
    expect(lines).toEqual([
      "Finding: finding-0002",
      "Rule: ST-INFINITE-LOADING",
      "Status: unsupported",
      'Reason: rule "ST-INFINITE-LOADING" is not a Phase 4A-supported Finding class'
    ]);
    expect(exportTestExitCode(result.status)).toBe(1);
  });

  it("insufficient_evidence: exit 1", () => {
    const result: GeneratedTestResult = {
      status: "insufficient_evidence",
      findingId: "finding-0003",
      ruleId: "NW-HTTP-ERROR",
      reason: "finding has no network_request or network_failed evidence"
    };
    expect(exportTestExitCode(result.status)).toBe(1);
  });

  it("the four cases (generated/passed, generated/failed, verification_failed, unsupported) are mutually distinguishable from output alone", () => {
    const generatedOnly = formatExportTestOutput(
      { status: "generated", findingId: "f", ruleId: "RT-EXCEPTION", outputPath: "C:\\x\\f.spec.ts" },
      CWD
    );
    const passed = formatExportTestOutput(
      {
        status: "generated",
        findingId: "f",
        ruleId: "RT-EXCEPTION",
        outputPath: "C:\\x\\f.spec.ts",
        verification: { executed: true, outcome: "passed", exitCode: 0, durationMs: 1, output: "" }
      },
      CWD
    );
    const failedAssertion = formatExportTestOutput(
      {
        status: "generated",
        findingId: "f",
        ruleId: "RT-EXCEPTION",
        outputPath: "C:\\x\\f.spec.ts",
        verification: { executed: true, outcome: "failed", exitCode: 1, durationMs: 1, output: "" }
      },
      CWD
    );
    const couldNotExecute = formatExportTestOutput(
      {
        status: "verification_failed",
        findingId: "f",
        ruleId: "RT-EXCEPTION",
        outputPath: "C:\\x\\f.spec.ts",
        verification: { executed: false, reason: "spawn_error", message: "ENOENT", output: "" }
      },
      CWD
    );

    const serialized = [generatedOnly, passed, failedAssertion, couldNotExecute].map((l) => l.join("\n"));
    expect(new Set(serialized).size).toBe(4);
  });
});
