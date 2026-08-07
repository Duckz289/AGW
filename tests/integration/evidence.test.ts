import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFixtureServer, type FixtureServerHandle } from "../../fixtures/server.ts";
import { runFlow } from "../../src/engine/flow-runner.ts";
import type { ScriptedFlow } from "../../src/schemas/flow.ts";

interface TimelineEventRow {
  version: number;
  seq: number;
  runId: string;
  timestampWallMs: number;
  timestampMonoMs: number;
  type: string;
  actionId?: string;
  payload: Record<string, unknown>;
}

async function readEvents(eventsPath: string): Promise<TimelineEventRow[]> {
  const raw = await fs.readFile(eventsPath, "utf-8");
  return raw
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as TimelineEventRow);
}

describe("evidence pipeline", () => {
  let fixture: FixtureServerHandle;
  let artifactRoot: string;

  beforeEach(async () => {
    fixture = await startFixtureServer();
    artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "webcheck-evidence-test-"));
  });

  afterEach(async () => {
    await fixture.close();
    await fs.rm(artifactRoot, { recursive: true, force: true });
  });

  function loginFlow(overrides: Partial<ScriptedFlow> = {}): ScriptedFlow {
    return {
      name: "evidence-login-success",
      startUrl: fixture.url,
      steps: [
        { type: "fill", target: { label: "Email" }, value: "test@example.com" },
        { type: "fill", target: { label: "Password" }, value: "correct-password" },
        { type: "click", target: { role: "button", name: "Login" } },
        { type: "expect", expected: { kind: "url_matches", pattern: new URL(fixture.url).host } },
        { type: "expect", expected: { kind: "element_visible", role: "heading", name: "Dashboard" } }
      ],
      ...overrides
    };
  }

  it("happy flow: produces every core event type with strictly increasing, gapless seq", async () => {
    const result = await runFlow(loginFlow(), { artifactRoot });
    expect(result.status).toBe("passed");

    const events = await readEvents(result.evidence.eventsPath);
    expect(events.length).toBeGreaterThan(0);

    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual(Array.from({ length: events.length }, (_, i) => i + 1));

    const types = new Set(events.map((e) => e.type));
    expect(types.has("run_started")).toBe(true);
    expect(types.has("action_started")).toBe(true);
    expect(types.has("action_finished")).toBe(true);
    expect(types.has("network_request")).toBe(true);
    expect(types.has("network_response")).toBe(true);
    // BrowserSession.waitForNetworkSettle() (called before teardown)
    // gives even the very last action's trailing requestfinished a
    // chance to arrive — see CURRENT_TASK.md "Evidence limitations".
    expect(types.has("network_finished")).toBe(true);
    expect(types.has("verification")).toBe(true);
    expect(types.has("run_finished")).toBe(true);

    const runFinished = events.find((e) => e.type === "run_finished");
    expect(runFinished?.payload["status"]).toBe("passed");
    expect(runFinished?.payload["completedSteps"]).toBe(5);
  });

  it("console evidence: a triggered console.error is persisted with its level and correct actionId", async () => {
    const flow: ScriptedFlow = {
      name: "evidence-console-error",
      startUrl: fixture.url,
      steps: [{ type: "click", target: { testId: "console-error-button" } }]
    };
    const result = await runFlow(flow, { artifactRoot });
    expect(result.status).toBe("passed");

    const events = await readEvents(result.evidence.eventsPath);
    const consoleEvent = events.find((e) => e.type === "console" && e.payload["level"] === "error");
    expect(consoleEvent).toBeDefined();
    expect(consoleEvent?.payload["text"]).toContain("Fixture: simulated console error");

    const actionStarted = events.find((e) => e.type === "action_started");
    expect(consoleEvent?.actionId).toBe(actionStarted?.payload["actionId"]);
  });

  it("runtime error evidence: an uncaught exception is persisted as runtime_error, not flattened into console", async () => {
    const flow: ScriptedFlow = {
      name: "evidence-runtime-error",
      startUrl: fixture.url,
      steps: [{ type: "click", target: { testId: "throw-error-button" } }]
    };
    const result = await runFlow(flow, { artifactRoot });
    expect(result.status).toBe("passed");

    const events = await readEvents(result.evidence.eventsPath);
    const runtimeError = events.find((e) => e.type === "runtime_error");
    expect(runtimeError).toBeDefined();
    expect(runtimeError?.payload["message"]).toContain("Fixture: simulated uncaught exception");

    const consoleEvents = events.filter((e) => e.type === "console");
    expect(consoleEvents.some((e) => String(e.payload["text"]).includes("simulated uncaught exception"))).toBe(
      false
    );
  });

  it("HTTP 500 evidence: a 500 response is a network_response, never a network_failed, for that request", async () => {
    const flow: ScriptedFlow = {
      name: "evidence-http-500",
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

    const events = await readEvents(result.evidence.eventsPath);
    const loginResponse = events.find(
      (e) => e.type === "network_response" && String(e.payload["url"]).includes("/api/login")
    );
    expect(loginResponse).toBeDefined();
    expect(loginResponse?.payload["status"]).toBe(500);

    const requestId = loginResponse?.payload["requestId"];
    const failedForSameRequest = events.find((e) => e.type === "network_failed" && e.payload["requestId"] === requestId);
    expect(failedForSameRequest).toBeUndefined();
  });

  it("transport failure evidence: network_failed exists, correlated by requestId, with no network_response for it", async () => {
    const flow: ScriptedFlow = {
      name: "evidence-transport-failure",
      startUrl: fixture.url,
      steps: [{ type: "click", target: { testId: "transport-fail-button" } }]
    };
    const result = await runFlow(flow, { artifactRoot });
    expect(result.status).toBe("passed");

    const events = await readEvents(result.evidence.eventsPath);
    const failed = events.find(
      (e) => e.type === "network_failed" && String(e.payload["url"]).includes("/api/transport-fail")
    );
    expect(failed).toBeDefined();
    expect(typeof failed?.payload["failureText"]).toBe("string");

    const requestId = failed?.payload["requestId"];
    const responseForSameRequest = events.find(
      (e) => e.type === "network_response" && e.payload["requestId"] === requestId
    );
    expect(responseForSameRequest).toBeUndefined();
  });

  it("failed verification: captures a screenshot inside the run artifact directory and records a screenshot event", async () => {
    const flow = loginFlow({
      steps: [
        { type: "fill", target: { label: "Email" }, value: "test@example.com" },
        { type: "fill", target: { label: "Password" }, value: "correct-password" },
        { type: "click", target: { role: "button", name: "Login" } },
        {
          type: "expect",
          expected: { kind: "element_visible", role: "heading", name: "Nonexistent Heading" },
          timeoutMs: 300
        }
      ]
    });
    const result = await runFlow(flow, { artifactRoot });
    expect(result.status).toBe("failed");

    const events = await readEvents(result.evidence.eventsPath);
    const screenshotEvent = events.find((e) => e.type === "screenshot");
    expect(screenshotEvent).toBeDefined();
    expect(screenshotEvent?.payload["reason"]).toBe("verification_failed");

    const relativePath = screenshotEvent?.payload["path"] as string;
    expect(relativePath.startsWith("screenshots" + path.sep) || relativePath.startsWith("screenshots/")).toBe(true);

    const absolutePath = path.join(result.evidence.runDir, relativePath);
    expect(absolutePath.startsWith(result.evidence.runDir)).toBe(true);
    const stat = await fs.stat(absolutePath);
    expect(stat.size).toBeGreaterThan(0);
  });
});
