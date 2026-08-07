import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFixtureServer, type FixtureServerHandle } from "../../fixtures/server.ts";
import { runFlow } from "../../src/engine/flow-runner.ts";
import type { ScriptedFlow } from "../../src/schemas/flow.ts";
import { getClosedLoopbackPort } from "../helpers/closed-port.ts";

describe("flow runner", () => {
  let fixture: FixtureServerHandle;

  beforeEach(async () => {
    fixture = await startFixtureServer();
  });

  afterEach(async () => {
    await fixture.close();
  });

  function loginFlow(overrides: Partial<ScriptedFlow> = {}): ScriptedFlow {
    return {
      name: "test-login-success",
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

  it("runs the full login flow to completion and passes", async () => {
    const result = await runFlow(loginFlow());
    expect(result.status).toBe("passed");
    expect(result.completedSteps).toBe(5);
    expect(result.steps).toHaveLength(5);
    expect(result.steps.every((s) => s.status === "passed")).toBe(true);
    expect(result.failure).toBeUndefined();
  });

  it("fails at the exact step index on a wrong URL expectation and does not run later steps", async () => {
    const flow = loginFlow({
      steps: [
        { type: "fill", target: { label: "Email" }, value: "test@example.com" },
        { type: "fill", target: { label: "Password" }, value: "correct-password" },
        { type: "click", target: { role: "button", name: "Login" } },
        { type: "expect", expected: { kind: "url_matches", pattern: "/dashboard" }, timeoutMs: 300 },
        { type: "expect", expected: { kind: "element_visible", role: "heading", name: "Dashboard" } }
      ]
    });

    const result = await runFlow(flow);
    expect(result.status).toBe("failed");
    expect(result.failure?.stepIndex).toBe(3);
    expect(result.failure?.stepType).toBe("expect");
    // Steps 0..3 were attempted; step 4 (the heading check) never ran.
    expect(result.steps).toHaveLength(4);
    expect(result.completedSteps).toBe(3);
  });

  it("fails cleanly when an expected element does not exist", async () => {
    const flow = loginFlow({
      steps: [
        { type: "fill", target: { label: "Email" }, value: "test@example.com" },
        { type: "fill", target: { label: "Password" }, value: "correct-password" },
        { type: "click", target: { role: "button", name: "Login" } },
        {
          type: "expect",
          expected: { kind: "element_visible", role: "heading", name: "Profile" },
          timeoutMs: 300
        }
      ]
    });

    const result = await runFlow(flow);
    expect(result.status).toBe("failed");
    expect(result.failure?.stepIndex).toBe(3);
    expect(result.failure?.code).toBe("verification_timeout");
  });

  it("stops immediately on an early failure and never runs a later mutating step", async () => {
    const flow: ScriptedFlow = {
      name: "test-stop-on-failure",
      startUrl: fixture.url,
      steps: [
        {
          type: "expect",
          expected: { kind: "element_visible", role: "heading", name: "Nonexistent Heading" },
          timeoutMs: 300
        },
        { type: "click", target: { testId: "force-error-checkbox" } }
      ]
    };

    let ariaSnapshotBeforeClose = "";
    const result = await runFlow(flow, {
      onBeforeCleanup: async (session) => {
        const snapshot = await session.observeWithoutAdvancing();
        ariaSnapshotBeforeClose = snapshot.ariaSnapshot;
      }
    });

    expect(result.status).toBe("failed");
    expect(result.failure?.stepIndex).toBe(0);
    // Only the failed expect step was ever attempted; the click that would
    // have checked the checkbox never ran.
    expect(result.steps).toHaveLength(1);
    expect(result.completedSteps).toBe(0);
    expect(ariaSnapshotBeforeClose).toContain('checkbox "Force server error');
    expect(ariaSnapshotBeforeClose).not.toMatch(/checkbox "Force server error[^\n]*\[checked\]/);
  });

  it("returns a structured failure on a verification timeout instead of hanging or throwing", async () => {
    const flow: ScriptedFlow = {
      name: "test-timeout",
      startUrl: fixture.url,
      steps: [
        {
          type: "expect",
          expected: { kind: "element_visible", role: "heading", name: "Never Appears" },
          timeoutMs: 250
        }
      ]
    };

    const start = Date.now();
    const result = await runFlow(flow);
    const elapsed = Date.now() - start;

    expect(result.status).toBe("failed");
    expect(result.failure?.code).toBe("verification_timeout");
    expect(elapsed).toBeLessThan(5000);
  });

  it("cleans up the browser session after a successful flow", async () => {
    let closeObserved = false;
    await runFlow(loginFlow(), {
      onBeforeCleanup: () => {
        closeObserved = true;
      }
    });
    expect(closeObserved).toBe(true);
  });

  it("cleans up the browser session after an action failure", async () => {
    const flow = loginFlow({
      steps: [{ type: "click", target: { testId: "does-not-exist" }, timeoutMs: 300 }]
    });
    let closeObserved = false;
    const result = await runFlow(flow, {
      onBeforeCleanup: () => {
        closeObserved = true;
      }
    });
    expect(result.status).toBe("failed");
    expect(result.failure?.code).toBe("action_timeout");
    expect(closeObserved).toBe(true);
  });

  it("cleans up the browser session after a verification failure", async () => {
    const flow = loginFlow({
      steps: [{ type: "expect", expected: { kind: "text_present", text: "Not on page" }, timeoutMs: 300 }]
    });
    let closeObserved = false;
    const result = await runFlow(flow, {
      onBeforeCleanup: () => {
        closeObserved = true;
      }
    });
    expect(result.status).toBe("failed");
    expect(closeObserved).toBe(true);
  });

  it("returns config_error and never launches a browser for a disallowed startUrl", async () => {
    const flow: ScriptedFlow = {
      name: "test-invalid-url",
      startUrl: "https://example.com",
      steps: [{ type: "expect", expected: { kind: "text_present", text: "x" } }]
    };
    const result = await runFlow(flow);
    expect(result.status).toBe("config_error");
    expect(result.failure?.code).toBe("POLICY_DENIED");
    expect(result.steps).toHaveLength(0);
  });

  it("returns environment_error for a deterministically unreachable loopback target", async () => {
    // A freshly-closed ephemeral port: nothing listens on it, so the
    // connection is refused (net::ERR_CONNECTION_REFUSED) fast and
    // deterministically, without hanging until a navigation timeout. Not
    // port 1 (tcpmux) — Chromium blocks that as an "unsafe port" and fails
    // with net::ERR_UNSAFE_PORT instead, which doesn't exercise a genuine
    // connection/environment failure.
    const closedPort = await getClosedLoopbackPort();
    const flow: ScriptedFlow = {
      name: "test-unreachable-target",
      startUrl: `http://127.0.0.1:${closedPort}`,
      steps: [{ type: "expect", expected: { kind: "text_present", text: "x" } }]
    };
    const result = await runFlow(flow);
    expect(result.status).toBe("environment_error");
    expect(result.failure?.stepIndex).toBe(-1);
    expect(result.steps).toHaveLength(0);
  });

  it("classifies an unexpected engine exception as internal_error, stops immediately, and still cleans up", async () => {
    const flow: ScriptedFlow = {
      name: "test-internal-error",
      startUrl: fixture.url,
      steps: [
        { type: "expect", expected: { kind: "element_visible", role: "heading", name: "WebCheck Fixture" } },
        { type: "expect", expected: { kind: "element_visible", role: "heading", name: "WebCheck Fixture" } },
        { type: "click", target: { testId: "force-error-checkbox" } }
      ]
    };

    let cleanupObserved = false;
    let ariaSnapshotBeforeClose = "";
    const result = await runFlow(flow, {
      onBeforeStep: (_session, _step, index) => {
        if (index === 1) {
          throw new Error("simulated unexpected engine failure");
        }
      },
      onBeforeCleanup: async (session) => {
        cleanupObserved = true;
        const snapshot = await session.observeWithoutAdvancing();
        ariaSnapshotBeforeClose = snapshot.ariaSnapshot;
      }
    });

    expect(result.status).toBe("internal_error");
    expect(result.failure?.stepIndex).toBe(1);
    expect(result.failure?.code).toBe("INTERNAL_ERROR");
    expect(result.failure?.message).toContain("simulated unexpected engine failure");
    // Step 0 completed; step 1 crashed before recording any result; step 2
    // (the checkbox click) never ran at all.
    expect(result.steps).toHaveLength(1);
    expect(result.completedSteps).toBe(1);
    expect(cleanupObserved).toBe(true);
    expect(ariaSnapshotBeforeClose).toContain('checkbox "Force server error');
    expect(ariaSnapshotBeforeClose).not.toMatch(/checkbox "Force server error[^\n]*\[checked\]/);
  });

  it("classifies a stale-snapshot rejection as an ordinary failed step, not internal_error", async () => {
    // Step 1's onBeforeStep hook advances the session's real snapshot
    // behind the runner's back (a genuine action via the public
    // BrowserSession API, not a mock), so the snapshotId the runner is
    // about to send for its own step 1 action is now stale — this is the
    // real StaleSnapshotError path, not a simulated one.
    const flow: ScriptedFlow = {
      name: "test-stale-snapshot-not-internal",
      startUrl: fixture.url,
      steps: [
        { type: "fill", target: { testId: "email-input" }, value: "first@example.com" },
        { type: "fill", target: { testId: "email-input" }, value: "second@example.com" }
      ]
    };

    const result = await runFlow(flow, {
      onBeforeStep: async (session, _step, index) => {
        if (index === 1) {
          await session.act({
            snapshotId: session.currentSnapshotId,
            type: "click",
            target: { testId: "rerender-button" },
            timeoutMs: 2000
          });
        }
      }
    });

    expect(result.status).toBe("failed");
    expect(result.failure?.stepIndex).toBe(1);
    expect(result.failure?.code).toBe("stale_snapshot");
  });
});
