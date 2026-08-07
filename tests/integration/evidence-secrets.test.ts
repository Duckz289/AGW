import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFixtureServer, type FixtureServerHandle } from "../../fixtures/server.ts";
import { runFlow } from "../../src/engine/flow-runner.ts";
import type { ScriptedFlow } from "../../src/schemas/flow.ts";

// Sentinel values that must never survive into the persisted artifact.
// See fixtures/public/app.js's log-sensitive-button / sensitive-request-button.
const SENTINEL_PASSWORD = "WEBCHECK_TEST_PASSWORD_7f4a";
const SENTINEL_TOKEN = "WEBCHECK_TEST_TOKEN_91ce";
const SENTINEL_APIKEY = "WEBCHECK_TEST_APIKEY_a273";

describe("evidence artifact: no secret leakage (mandatory)", () => {
  let fixture: FixtureServerHandle;
  let artifactRoot: string;

  beforeEach(async () => {
    fixture = await startFixtureServer();
    artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "webcheck-evidence-secrets-test-"));
  });

  afterEach(async () => {
    await fixture.close();
    await fs.rm(artifactRoot, { recursive: true, force: true });
  });

  it("never persists sentinel secrets that pass through captured console text or network URLs", async () => {
    const flow: ScriptedFlow = {
      name: "evidence-secrets",
      startUrl: fixture.url,
      steps: [
        // Console text containing password-key and token-key sentinels.
        { type: "click", target: { testId: "log-sensitive-button" } },
        // A request URL carrying token and apikey sentinels as query params.
        { type: "click", target: { testId: "sensitive-request-button" } },
        {
          type: "expect",
          expected: { kind: "text_present", text: "WebCheck Fixture" }
        }
      ]
    };

    const result = await runFlow(flow, { artifactRoot });
    expect(result.status).toBe("passed");

    // Artifact-level scan of the RAW bytes/text — not a parsed-object
    // check — per CURRENT_TASK.md: "A passing object-level redactor unit
    // test alone is not sufficient. Artifact-level leakage tests are
    // mandatory."
    const raw = await fs.readFile(result.evidence.eventsPath, "utf-8");

    expect(raw).not.toContain(SENTINEL_PASSWORD);
    expect(raw).not.toContain(SENTINEL_TOKEN);
    expect(raw).not.toContain(SENTINEL_APIKEY);

    // Positive control: prove the scan itself is meaningful — the
    // *redacted* placeholder and the surrounding evidence must actually
    // be present, so a vacuously-empty artifact could not pass this test
    // by accident.
    expect(raw).toContain("[REDACTED]");
    expect(raw.length).toBeGreaterThan(0);
  });

  it("never persists a sentinel password typed into the login form (fill action / aria snapshot path)", async () => {
    const flow: ScriptedFlow = {
      name: "evidence-secrets-login-password",
      startUrl: fixture.url,
      steps: [
        { type: "fill", target: { label: "Email" }, value: "test@example.com" },
        { type: "fill", target: { label: "Password" }, value: SENTINEL_PASSWORD },
        { type: "click", target: { role: "button", name: "Login" } },
        { type: "expect", expected: { kind: "element_visible", role: "heading", name: "Dashboard" } }
      ]
    };

    const result = await runFlow(flow, { artifactRoot });
    expect(result.status).toBe("passed");

    const raw = await fs.readFile(result.evidence.eventsPath, "utf-8");
    expect(raw).not.toContain(SENTINEL_PASSWORD);
  });
});
