import { defineConfig } from "@playwright/test";

/**
 * Config for executing WebCheck-generated regression tests only
 * (`<runDir>/generated-tests/*.spec.ts`) — not a general project test
 * runner and not wired into `npm test`/CI.
 *
 * `testDir` defaults to `.webcheck` (matching the default,
 * non-test-isolated artifact location a real WebCheck run produces) but
 * is overridable via `WEBCHECK_TEST_DIR` — `src/testgen/verify.ts` sets
 * this to the exact `generated-tests` directory it is about to execute,
 * since integration tests use `runFlow({ artifactRoot })` to isolate
 * each run's artifacts *outside* the project directory entirely, where a
 * fixed relative `testDir` could never find them.
 */
export default defineConfig({
  testDir: process.env["WEBCHECK_TEST_DIR"] ?? ".webcheck",
  testMatch: /.*\.spec\.ts$/,
  reporter: [["list"]],
  retries: 0,
  workers: 1,
  timeout: 15_000,
  use: {
    headless: true
  }
});
