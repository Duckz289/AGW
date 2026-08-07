import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFixtureServer, type FixtureServerHandle } from "../../fixtures/server.ts";
import { runFlow } from "../../src/engine/flow-runner.ts";
import type { ScriptedFlow } from "../../src/schemas/flow.ts";

const ERROR_INDICATOR = { role: "alert", name: "Server error, please try again." };
const LOADING_INDICATOR = { role: "status", name: "Loading" };

describe("Phase 2B checkers over the real evidence pipeline", () => {
  let fixture: FixtureServerHandle;
  let artifactRoot: string;

  beforeEach(async () => {
    fixture = await startFixtureServer();
    artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "webcheck-checkers-test-"));
  });

  afterEach(async () => {
    await fixture.close();
    await fs.rm(artifactRoot, { recursive: true, force: true });
  });

  function counts(results: { status: string }[]): { confirmed: number; likely: number; warning: number } {
    return {
      confirmed: results.filter((r) => r.status === "confirmed").length,
      likely: results.filter((r) => r.status === "likely").length,
      warning: results.filter((r) => r.status === "warning").length
    };
  }

  it("clean flow: zero confirmed and zero likely checker results (mandatory gate)", async () => {
    const flow: ScriptedFlow = {
      name: "checkers-clean-flow",
      startUrl: fixture.url,
      steps: [
        { type: "fill", target: { label: "Email" }, value: "test@example.com" },
        { type: "fill", target: { label: "Password" }, value: "correct-password" },
        { type: "click", target: { role: "button", name: "Login" } },
        { type: "expect", expected: { kind: "url_matches", pattern: new URL(fixture.url).host } },
        { type: "expect", expected: { kind: "element_visible", role: "heading", name: "Dashboard" } }
      ]
    };
    const result = await runFlow(flow, { artifactRoot });
    expect(result.status).toBe("passed");

    const c = counts(result.checkerResults);
    expect(c.confirmed).toBe(0);
    expect(c.likely).toBe(0);
  });

  it("console error only: RT-EXCEPTION does not trigger (mandatory negative)", async () => {
    const flow: ScriptedFlow = {
      name: "checkers-console-error-only",
      startUrl: fixture.url,
      steps: [{ type: "click", target: { testId: "console-error-button" } }]
    };
    const result = await runFlow(flow, { artifactRoot });
    expect(result.status).toBe("passed");
    expect(result.checkerResults.some((r) => r.ruleId === "RT-EXCEPTION")).toBe(false);
  });

  it("runtime exception: RT-EXCEPTION triggers confirmed, referencing a real seq", async () => {
    const flow: ScriptedFlow = {
      name: "checkers-runtime-exception",
      startUrl: fixture.url,
      steps: [{ type: "click", target: { testId: "throw-error-button" } }]
    };
    const result = await runFlow(flow, { artifactRoot });
    expect(result.status).toBe("passed");

    const rtResults = result.checkerResults.filter((r) => r.ruleId === "RT-EXCEPTION");
    expect(rtResults).toHaveLength(1);
    expect(rtResults[0]?.status).toBe("confirmed");
    expect(rtResults[0]?.evidenceSeqs.length).toBeGreaterThan(0);

    const raw = await fs.readFile(result.evidence.eventsPath, "utf-8");
    const events = raw.trim().split("\n").map((l) => JSON.parse(l) as { seq: number });
    const validSeqs = new Set(events.map((e) => e.seq));
    for (const seq of rtResults[0]?.evidenceSeqs ?? []) {
      expect(validSeqs.has(seq)).toBe(true);
    }
  });

  it("HTTP 500 + failed same-action verification: NW-HTTP-ERROR and FM-SERVER-ERROR-NOT-SHOWN both confirmed", async () => {
    const flow: ScriptedFlow = {
      name: "checkers-http-500-failed-verification",
      startUrl: fixture.url,
      checks: { errorIndicator: ERROR_INDICATOR },
      steps: [
        { type: "fill", target: { label: "Email" }, value: "test@example.com" },
        { type: "fill", target: { label: "Password" }, value: "correct-password" },
        { type: "click", target: { testId: "force-error-checkbox" } },
        {
          type: "click",
          target: { role: "button", name: "Login" },
          expected: { kind: "element_visible", role: "heading", name: "Dashboard" },
          timeoutMs: 300
        }
      ]
    };
    const result = await runFlow(flow, { artifactRoot });
    expect(result.status).toBe("failed");

    const nwResults = result.checkerResults.filter((r) => r.ruleId === "NW-HTTP-ERROR");
    expect(nwResults).toHaveLength(1);
    expect(nwResults[0]?.status).toBe("confirmed");

    const fmResults = result.checkerResults.filter((r) => r.ruleId === "FM-SERVER-ERROR-NOT-SHOWN");
    expect(fmResults).toHaveLength(1);
    expect(fmResults[0]?.status).toBe("confirmed");
  });

  it("HTTP 500 with the configured UI error correctly shown: FM-SERVER-ERROR-NOT-SHOWN never triggers (mandatory gate); NW-HTTP-ERROR remains likely evidence", async () => {
    const flow: ScriptedFlow = {
      name: "checkers-http-500-proper-ui-error",
      startUrl: fixture.url,
      checks: { errorIndicator: ERROR_INDICATOR },
      steps: [
        { type: "fill", target: { label: "Email" }, value: "test@example.com" },
        { type: "fill", target: { label: "Password" }, value: "correct-password" },
        { type: "click", target: { testId: "force-error-checkbox" } },
        { type: "click", target: { role: "button", name: "Login" } },
        { type: "expect", expected: { kind: "element_visible", role: "alert", name: ERROR_INDICATOR.name } }
      ]
    };
    const result = await runFlow(flow, { artifactRoot });
    expect(result.status).toBe("passed");

    expect(result.checkerResults.some((r) => r.ruleId === "FM-SERVER-ERROR-NOT-SHOWN")).toBe(false);

    const nwResults = result.checkerResults.filter((r) => r.ruleId === "NW-HTTP-ERROR");
    expect(nwResults).toHaveLength(1);
    expect(nwResults[0]?.status).toBe("likely");
  });

  it("transport failure + failed same-action verification: NW-TRANSPORT-FAILURE confirmed", async () => {
    const flow: ScriptedFlow = {
      name: "checkers-transport-failure",
      startUrl: fixture.url,
      steps: [
        {
          type: "click",
          target: { testId: "transport-fail-button" },
          expected: { kind: "text_present", text: "Dashboard" },
          timeoutMs: 300
        }
      ]
    };
    const result = await runFlow(flow, { artifactRoot });
    expect(result.status).toBe("failed");

    const results = result.checkerResults.filter((r) => r.ruleId === "NW-TRANSPORT-FAILURE");
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("confirmed");
  });

  it("cancelled request (net::ERR_ABORTED): NW-TRANSPORT-FAILURE does not trigger (mandatory gate)", async () => {
    const flow: ScriptedFlow = {
      name: "checkers-cancelled-request",
      startUrl: fixture.url,
      steps: [{ type: "click", target: { testId: "cancel-request-button" } }]
    };
    const result = await runFlow(flow, { artifactRoot });
    expect(result.status).toBe("passed");
    expect(result.checkerResults.some((r) => r.ruleId === "NW-TRANSPORT-FAILURE")).toBe(false);
  });

  it("explicit infinite loading: ST-INFINITE-LOADING triggers confirmed", async () => {
    const flow: ScriptedFlow = {
      name: "checkers-infinite-loading",
      startUrl: fixture.url,
      checks: { loadingIndicator: LOADING_INDICATOR },
      steps: [
        { type: "click", target: { testId: "infinite-loading-button" } },
        { type: "expect", expected: { kind: "element_visible", role: "status", name: "Loading" } },
        {
          type: "expect",
          expected: { kind: "element_visible", role: "heading", name: "Dashboard" },
          timeoutMs: 300
        }
      ]
    };
    const result = await runFlow(flow, { artifactRoot });
    expect(result.status).toBe("failed");

    const results = result.checkerResults.filter((r) => r.ruleId === "ST-INFINITE-LOADING");
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("confirmed");
  });
});
