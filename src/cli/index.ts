import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { loadFlow, runFlow } from "../engine/flow-runner.ts";
import { WebCheckReportSchema, type WebCheckReport } from "../report/schema.ts";
import { ScriptedFlowSchema, type Expectation, type FlowStep } from "../schemas/flow.ts";
import { generateTest } from "../testgen/generator.ts";
import type { GeneratedTestResult } from "../testgen/types.ts";
import { verifyGeneratedTest } from "../testgen/verify.ts";
import { readTimelineEvents } from "../timeline/read.ts";

interface TargetDescriptor {
  testId?: string | undefined;
  role?: string | undefined;
  name?: string | undefined;
  label?: string | undefined;
  placeholder?: string | undefined;
}

function describeTarget(target: TargetDescriptor): string {
  return target.label ?? target.name ?? target.testId ?? target.placeholder ?? target.role ?? "element";
}

function describeExpectation(expected: Expectation): string {
  switch (expected.kind) {
    case "url_matches":
      return `URL contains ${expected.pattern}`;
    case "element_visible":
      return `${expected.role} ${expected.name} visible`;
    case "element_hidden":
      return `${expected.role} ${expected.name} hidden`;
    case "text_present":
      return `text "${expected.text}" present`;
  }
}

function describeStep(step: FlowStep): string {
  switch (step.type) {
    case "navigate":
      return `navigate to ${step.url}`;
    case "fill":
      return `fill ${describeTarget(step.target)}`;
    case "click":
      return `click ${describeTarget(step.target)}`;
    case "expect":
      return `expect ${describeExpectation(step.expected)}`;
  }
}

async function runCommand(flowPath: string): Promise<number> {
  const loaded = await loadFlow(path.resolve(flowPath));
  if (!loaded.ok) {
    console.log(`WebCheck scripted flow: ${flowPath}`);
    console.log(`Config error: ${loaded.message}`);
    console.log("Result: ERROR");
    return 2;
  }

  const flow = loaded.flow;
  console.log(`WebCheck scripted flow: ${flow.name}`);

  const result = await runFlow(flow, { headless: true });

  for (const stepResult of result.steps) {
    const step = flow.steps[stepResult.index];
    const description = step ? describeStep(step) : stepResult.type;
    const mark = stepResult.status === "passed" ? "PASS" : "FAIL";
    console.log(`${mark}  ${stepResult.index + 1} ${description}`);
  }

  if (result.status === "environment_error" || result.status === "config_error" || result.status === "internal_error") {
    const label =
      result.status === "environment_error"
        ? "Environment error"
        : result.status === "config_error"
          ? "Config error"
          : "Internal WebCheck error";
    console.log(`${label}: ${result.failure?.message ?? "unknown error"}`);
  } else if (result.status === "failed" && result.failure) {
    const failedStep = flow.steps[result.failure.stepIndex];
    const expected = failedStep?.expected;
    if (expected) {
      console.log("Verification failed:");
      console.log(`Expected: ${describeExpectation(expected)}`);
      console.log(`Observed: ${result.failure.message}`);
    } else {
      console.log("Action failed:");
      console.log(result.failure.message);
    }
  }

  const resultLabel = result.status === "passed" ? "PASS" : result.status === "failed" ? "FAIL" : "ERROR";
  console.log(`Result: ${resultLabel}`);
  console.log(`Duration: ${result.durationMs} ms`);
  if (result.evidence.eventsPath) {
    console.log(`Evidence: ${path.relative(process.cwd(), result.evidence.eventsPath)}`);
  }
  if (result.evidence.reportPath) {
    console.log(`Report:   ${path.relative(process.cwd(), result.evidence.reportPath)}`);
  }
  if (result.evidence.markdownReportPath) {
    console.log(`Markdown: ${path.relative(process.cwd(), result.evidence.markdownReportPath)}`);
  }

  const confirmedCount = result.checkerResults.filter((r) => r.status === "confirmed").length;
  const likelyCount = result.checkerResults.filter((r) => r.status === "likely").length;
  const warningCount = result.checkerResults.filter((r) => r.status === "warning").length;
  console.log(`Checks: ${confirmedCount} confirmed, ${likelyCount} likely, ${warningCount} warnings`);

  if (result.status === "passed") return 0;
  if (result.status === "failed") return 1;
  return 2;
}

/**
 * Loads `<runId>`'s persisted artifacts by hand (not via `runFlow()` —
 * export-test operates on an *existing* run's artifacts, potentially in a
 * later process). `runId` is a CLI argument, so it is validated as a bare
 * path segment before ever being joined into a filesystem path (AGENT.MD
 * "Protect all artifact operations against path traversal").
 */
async function loadRunArtifacts(
  runId: string
): Promise<{ ok: true; report: WebCheckReport; flow: import("../schemas/flow.ts").ScriptedFlow; events: Awaited<ReturnType<typeof readTimelineEvents>>; runDir: string } | { ok: false; message: string }> {
  if (runId.length === 0 || path.basename(runId) !== runId) {
    return { ok: false, message: `invalid runId "${runId}"` };
  }

  const runDir = path.join(process.cwd(), ".webcheck", "runs", runId);

  try {
    const reportRaw: unknown = JSON.parse(await fs.readFile(path.join(runDir, "report.json"), "utf-8"));
    const reportParsed = WebCheckReportSchema.safeParse(reportRaw);
    if (!reportParsed.success) {
      return { ok: false, message: `report.json failed schema validation: ${reportParsed.error.message}` };
    }

    const flowRaw: unknown = JSON.parse(await fs.readFile(path.join(runDir, "flow.json"), "utf-8"));
    const flowParsed = ScriptedFlowSchema.safeParse(flowRaw);
    if (!flowParsed.success) {
      return { ok: false, message: `flow.json failed schema validation: ${flowParsed.error.message}` };
    }

    const events = await readTimelineEvents(path.join(runDir, "events.ndjson"));

    return { ok: true, report: reportParsed.data, flow: flowParsed.data, events, runDir };
  } catch (err) {
    return { ok: false, message: `failed to load run artifacts for "${runId}": ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Pure formatting for `export-test`'s output — separated from
 * `exportTestCommand()` so all four result shapes (generated without
 * `--verify`, verification passed, verification failed on assertion,
 * verification could not execute) can be asserted on directly without
 * needing to force a real subprocess failure just to check line
 * formatting (tests/unit/cli-export-test-output.test.ts).
 */
export function formatExportTestOutput(result: GeneratedTestResult, cwd: string): string[] {
  const lines: string[] = [];
  lines.push(`Finding: ${result.findingId}`);
  lines.push(`Rule: ${result.ruleId}`);
  lines.push(`Status: ${result.status}`);
  if (result.outputPath !== undefined) {
    lines.push(`Test: ${path.relative(cwd, result.outputPath)}`);
  }
  if (result.reason !== undefined) {
    lines.push(`Reason: ${result.reason}`);
  }
  if (result.verification !== undefined) {
    lines.push(`Verification executed: ${result.verification.executed ? "yes" : "no"}`);
    if (result.verification.executed) {
      lines.push(`Verification outcome: ${result.verification.outcome}`);
      lines.push(`Exit code: ${result.verification.exitCode}`);
    } else {
      lines.push(`Verification reason: ${result.verification.reason}`);
      lines.push(`Verification message: ${result.verification.message}`);
    }
  }
  return lines;
}

export function exportTestExitCode(status: GeneratedTestResult["status"]): number {
  if (status === "generated") return 0;
  if (status === "unsupported" || status === "insufficient_evidence") return 1;
  return 2;
}

async function exportTestCommand(runId: string, findingId: string, opts: { verify?: boolean }): Promise<number> {
  const loaded = await loadRunArtifacts(runId);
  if (!loaded.ok) {
    console.log(`Config error: ${loaded.message}`);
    console.log("Result: ERROR");
    return 2;
  }

  let result: GeneratedTestResult;
  try {
    result = await generateTest({
      report: loaded.report,
      flow: loaded.flow,
      events: loaded.events,
      findingId,
      runId,
      runDir: loaded.runDir
    });
  } catch (err) {
    console.log(`Error: failed to write generated test: ${err instanceof Error ? err.message : String(err)}`);
    console.log("Result: ERROR");
    return 2;
  }

  if (result.status === "generated" && opts.verify === true && result.outputPath !== undefined) {
    const baseUrl = process.env["WEBCHECK_BASE_URL"];
    const verification = await verifyGeneratedTest(result.outputPath, baseUrl !== undefined ? { baseUrl } : {});
    // A regression test that executed cleanly and whose assertion failed
    // found the defect it was generated for — that is success for
    // export-test itself, not a WebCheck failure, so `status` only
    // changes to "verification_failed" when the runner/environment never
    // produced a normal pass/fail report at all.
    result = { ...result, verification, status: verification.executed ? "generated" : "verification_failed" };
  }

  for (const line of formatExportTestOutput(result, process.cwd())) {
    console.log(line);
  }

  return exportTestExitCode(result.status);
}

function buildProgram(): Command {
  const program = new Command();
  program.name("webcheck").description("WebCheck Agent CLI");

  program
    .command("run")
    .description("Run a scripted flow and verify expectations")
    .requiredOption("--flow <path>", "path to a flow JSON file")
    .action(async (opts: { flow: string }) => {
      try {
        process.exitCode = await runCommand(opts.flow);
      } catch (err) {
        console.log(`Config error: ${err instanceof Error ? err.message : String(err)}`);
        console.log("Result: ERROR");
        process.exitCode = 2;
      }
    });

  program
    .command("export-test")
    .description("Generate a deterministic Playwright regression test for one report.json Finding")
    .argument("<runId>", "the run's ID (a subdirectory of .webcheck/runs)")
    .argument("<findingId>", "the Finding's id from report.json, e.g. finding-0001")
    .option("--verify", "execute the generated test immediately via the real Playwright Test runner")
    .action(async (runId: string, findingId: string, opts: { verify?: boolean }) => {
      try {
        process.exitCode = await exportTestCommand(runId, findingId, opts);
      } catch (err) {
        console.log(`Error: ${err instanceof Error ? err.message : String(err)}`);
        console.log("Result: ERROR");
        process.exitCode = 2;
      }
    });

  return program;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  void buildProgram().parseAsync(process.argv);
}
