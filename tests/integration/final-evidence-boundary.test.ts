import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFixtureServer, type FixtureServerHandle } from "../../fixtures/server.ts";
import { runFlow } from "../../src/engine/flow-runner.ts";
import type { ScriptedFlow } from "../../src/schemas/flow.ts";
import { readTimelineEvents } from "../../src/timeline/read.ts";

/**
 * Phase 4A.1: proves the network-settle wait now happens *before*
 * checker execution (moved from runFlow()'s `finally` block to the top
 * of `finalize()`), by exercising exactly the flow shape that previously
 * required a workaround: the flow's LAST step triggers a network request
 * and has no inline `expected` to incidentally buy the response time to
 * land before finalize() reads events.ndjson back for `runCheckers()`.
 */
describe("final evidence boundary: last-step network request settles before checker execution", () => {
  let fixture: FixtureServerHandle;
  let artifactRoot: string;

  beforeEach(async () => {
    fixture = await startFixtureServer(0, { mode: "buggy" });
    artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "webcheck-final-evidence-"));
  });

  afterEach(async () => {
    await fixture.close();
    await fs.rm(artifactRoot, { recursive: true, force: true });
  });

  it(
    "last-step HTTP 500 with no inline expected: NW-HTTP-ERROR is produced reliably across repeated runs",
    async () => {
      const flow: ScriptedFlow = {
        name: "final-evidence-http-500",
        startUrl: fixture.url,
        steps: [
          { type: "fill", target: { label: "Email" }, value: "test@example.com" },
          { type: "fill", target: { label: "Password" }, value: "correct-password" },
          { type: "click", target: { testId: "force-error-checkbox" } },
          // Deliberately no `expected` here — this is exactly the
          // workaround this milestone proves is no longer necessary.
          { type: "click", target: { role: "button", name: "Login" } }
        ]
      };

      const REPEATS = 12;
      for (let i = 0; i < REPEATS; i++) {
        const result = await runFlow(flow, { artifactRoot });
        expect(result.status, `run ${i}: flow status`).toBe("passed");

        const events = await readTimelineEvents(result.evidence.eventsPath);
        const responseEvent = events.find(
          (e) => e.type === "network_response" && e.payload.url.includes("/api/login") && e.payload.status === 500
        );
        expect(responseEvent, `run ${i}: expected the HTTP 500 network_response in events.ndjson`).toBeDefined();

        const checkerFinding = result.checkerResults.find((r) => r.ruleId === "NW-HTTP-ERROR");
        expect(checkerFinding, `run ${i}: expected an NW-HTTP-ERROR checker result`).toBeDefined();

        const report: { findings: Array<{ ruleId: string }> } = JSON.parse(
          await fs.readFile(result.evidence.reportPath, "utf-8")
        );
        const reportFinding = report.findings.find((f) => f.ruleId === "NW-HTTP-ERROR");
        expect(reportFinding, `run ${i}: expected NW-HTTP-ERROR in report.json`).toBeDefined();
      }
    },
    60_000
  );

  it(
    "last-step transport failure with no inline expected: NW-TRANSPORT-FAILURE is produced reliably across repeated runs",
    async () => {
      const flow: ScriptedFlow = {
        name: "final-evidence-transport-failure",
        startUrl: fixture.url,
        // A single step, no inline expected — the request-triggering
        // action is both the first and the last step.
        steps: [{ type: "click", target: { testId: "transport-fail-button" } }]
      };

      const REPEATS = 12;
      for (let i = 0; i < REPEATS; i++) {
        const result = await runFlow(flow, { artifactRoot });
        expect(result.status, `run ${i}: flow status`).toBe("passed");

        const events = await readTimelineEvents(result.evidence.eventsPath);
        const failedEvent = events.find(
          (e) => e.type === "network_failed" && e.payload.url.includes("/api/transport-fail")
        );
        expect(failedEvent, `run ${i}: expected the network_failed event in events.ndjson`).toBeDefined();

        const checkerFinding = result.checkerResults.find((r) => r.ruleId === "NW-TRANSPORT-FAILURE");
        expect(checkerFinding, `run ${i}: expected an NW-TRANSPORT-FAILURE checker result`).toBeDefined();

        const report: { findings: Array<{ ruleId: string }> } = JSON.parse(
          await fs.readFile(result.evidence.reportPath, "utf-8")
        );
        const reportFinding = report.findings.find((f) => f.ruleId === "NW-TRANSPORT-FAILURE");
        expect(reportFinding, `run ${i}: expected NW-TRANSPORT-FAILURE in report.json`).toBeDefined();
      }
    },
    60_000
  );
});
