import type { CheckerResult } from "../../src/checkers/types.ts";
import { buildReport } from "../../src/report/build.ts";
import type { WebCheckReport } from "../../src/report/schema.ts";
import type { ScriptedFlow } from "../../src/schemas/flow.ts";
import type { TimelineEvent } from "../../src/timeline/events.ts";
import type { GenerateTestInput } from "../../src/testgen/types.ts";
import { ev } from "./synthetic-events.ts";

/**
 * Fixed, deterministic scenarios for each Phase 4A-supported rule, used
 * across testgen's locator/generator/render/golden unit tests so they all
 * exercise the same realistic report+flow+events shape a real run would
 * produce, without depending on a real browser.
 */

export function rtExceptionScenario(): Omit<GenerateTestInput, "findingId"> {
  const flow: ScriptedFlow = {
    name: "rt-exception-flow",
    startUrl: "http://127.0.0.1:4300",
    steps: [{ type: "click", target: { testId: "throw-error-button" } }]
  };

  const events: TimelineEvent[] = [
    ev(1, "run_started", { runId: "run-rt-1", flowName: flow.name, startUrl: flow.startUrl, startedAt: "2024-01-01T00:00:00.000Z" }),
    ev(2, "action_started", { actionId: "action-0001", stepIndex: 0, stepType: "click" }, "action-0001"),
    ev(3, "runtime_error", { name: "Error", message: "Fixture: simulated uncaught exception" }, "action-0001"),
    ev(4, "action_finished", { actionId: "action-0001", stepIndex: 0, stepType: "click", ok: true, durationMs: 5 }, "action-0001"),
    ev(5, "run_finished", { status: "passed", completedSteps: 1, durationMs: 100 })
  ];

  const checkerResults: CheckerResult[] = [
    {
      ruleId: "RT-EXCEPTION",
      status: "confirmed",
      title: "Uncaught runtime exception",
      summary: "An uncaught exception occurred: Fixture: simulated uncaught exception",
      actionId: "action-0001",
      evidenceSeqs: [3],
      observed: "Fixture: simulated uncaught exception",
      expected: "no uncaught runtime exception"
    }
  ];

  const report: WebCheckReport = buildReport({
    runId: "run-rt-1",
    flowName: flow.name,
    status: "passed",
    startedAt: "2024-01-01T00:00:00.000Z",
    finishedAt: "2024-01-01T00:00:01.000Z",
    durationMs: 100,
    completedSteps: 1,
    evidencePath: "events.ndjson",
    events,
    checkerResults
  });

  return { report, flow, events, runId: "run-rt-1", runDir: "/tmp/run-rt-1" };
}

export function networkErrorScenario(): Omit<GenerateTestInput, "findingId"> {
  const flow: ScriptedFlow = {
    name: "http-500-flow",
    startUrl: "http://127.0.0.1:4300",
    steps: [
      { type: "fill", target: { label: "Email" }, value: "test@example.com" },
      { type: "fill", target: { label: "Password" }, value: "correct-password" },
      { type: "click", target: { testId: "force-error-checkbox" } },
      { type: "click", target: { role: "button", name: "Login" } }
    ]
  };

  const events: TimelineEvent[] = [
    ev(1, "run_started", { runId: "run-http-1", flowName: flow.name, startUrl: flow.startUrl, startedAt: "2024-01-01T00:00:00.000Z" }),
    ev(2, "action_started", { actionId: "action-0004", stepIndex: 3, stepType: "click" }, "action-0004"),
    ev(3, "network_request", { requestId: "req-000001", url: "http://127.0.0.1:4300/api/login", method: "POST", resourceType: "fetch" }, "action-0004"),
    ev(4, "network_response", { requestId: "req-000001", url: "http://127.0.0.1:4300/api/login", status: 500, statusText: "Internal Server Error" }, "action-0004"),
    ev(5, "action_finished", { actionId: "action-0004", stepIndex: 3, stepType: "click", ok: true, durationMs: 10 }, "action-0004"),
    ev(6, "run_finished", { status: "passed", completedSteps: 4, durationMs: 200 })
  ];

  const checkerResults: CheckerResult[] = [
    {
      ruleId: "NW-HTTP-ERROR",
      status: "likely",
      title: "HTTP 500 response",
      summary: "Request to http://127.0.0.1:4300/api/login returned HTTP 500.",
      actionId: "action-0004",
      evidenceSeqs: [3, 4],
      observed: "HTTP 500 Internal Server Error",
      expected: "HTTP status below 400"
    }
  ];

  const report: WebCheckReport = buildReport({
    runId: "run-http-1",
    flowName: flow.name,
    status: "passed",
    startedAt: "2024-01-01T00:00:00.000Z",
    finishedAt: "2024-01-01T00:00:01.000Z",
    durationMs: 200,
    completedSteps: 4,
    evidencePath: "events.ndjson",
    events,
    checkerResults
  });

  return { report, flow, events, runId: "run-http-1", runDir: "/tmp/run-http-1" };
}

export function transportFailureScenario(): Omit<GenerateTestInput, "findingId"> {
  const flow: ScriptedFlow = {
    name: "transport-failure-flow",
    startUrl: "http://127.0.0.1:4300",
    steps: [{ type: "click", target: { testId: "transport-fail-button" } }]
  };

  const events: TimelineEvent[] = [
    ev(1, "run_started", { runId: "run-transport-1", flowName: flow.name, startUrl: flow.startUrl, startedAt: "2024-01-01T00:00:00.000Z" }),
    ev(2, "action_started", { actionId: "action-0001", stepIndex: 0, stepType: "click" }, "action-0001"),
    ev(3, "network_failed", { requestId: "req-000001", url: "http://127.0.0.1:4300/api/transport-fail", method: "GET", failureText: "net::ERR_EMPTY_RESPONSE" }, "action-0001"),
    ev(4, "action_finished", { actionId: "action-0001", stepIndex: 0, stepType: "click", ok: true, durationMs: 10 }, "action-0001"),
    ev(5, "run_finished", { status: "passed", completedSteps: 1, durationMs: 100 })
  ];

  const checkerResults: CheckerResult[] = [
    {
      ruleId: "NW-TRANSPORT-FAILURE",
      status: "likely",
      title: "Network transport failure",
      summary: "Request to http://127.0.0.1:4300/api/transport-fail failed at the transport level (net::ERR_EMPTY_RESPONSE).",
      actionId: "action-0001",
      evidenceSeqs: [3],
      observed: "net::ERR_EMPTY_RESPONSE",
      expected: "no transport-level failure"
    }
  ];

  const report: WebCheckReport = buildReport({
    runId: "run-transport-1",
    flowName: flow.name,
    status: "passed",
    startedAt: "2024-01-01T00:00:00.000Z",
    finishedAt: "2024-01-01T00:00:01.000Z",
    durationMs: 100,
    completedSteps: 1,
    evidencePath: "events.ndjson",
    events,
    checkerResults
  });

  return { report, flow, events, runId: "run-transport-1", runDir: "/tmp/run-transport-1" };
}
