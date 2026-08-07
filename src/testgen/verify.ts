import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestVerificationExecutionFailure, VerificationOutcome } from "./types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const PLAYWRIGHT_CLI = path.join(PROJECT_ROOT, "node_modules", "@playwright", "test", "cli.js");
const CONFIG_PATH = path.join(PROJECT_ROOT, "playwright.config.ts");

// Well above playwright.config.ts's own 15s per-test timeout, to allow
// for browser startup overhead while still guaranteeing verify() cannot
// hang forever if the subprocess itself gets stuck.
const OVERALL_TIMEOUT_MS = 60_000;

const ranTestsPattern = /\d+\s+(passed|failed)/;
const moduleResolutionPattern = /Cannot find module/i;
const noTestsFoundPattern = /No tests found/i;
const loadErrorPattern = /SyntaxError|Failed to parse|Transform failed|Unexpected token/i;

/**
 * Classifies *why* the runner never reached a normal pass/fail report.
 * Process-level signals (spawn failure, timeout) are handled by their
 * own dedicated call sites before this is ever reached; this only
 * distinguishes among startup-failure modes that Playwright does not
 * expose a distinct exit code for (AGENT.MD "do not classify solely
 * through output text matching where process exit semantics are
 * sufficient" — exit code alone cannot tell these apart, so text
 * matching is the only signal actually available here).
 *
 * Order matters: Playwright always appends a generic "No tests found."
 * once it fails to collect any test, *including* when the real cause was
 * a parse/syntax error or an unresolvable import in the spec file itself
 * (verified directly — a syntax error's output ends with the same "No
 * tests found." line as a genuinely missing file). The more specific
 * causes must be checked first, or a syntax/import error would always be
 * misclassified as the generic "no_tests_found".
 */
function classifyStartupFailure(output: string): TestVerificationExecutionFailure["reason"] {
  if (moduleResolutionPattern.test(output)) return "module_resolution_failure";
  if (loadErrorPattern.test(output)) return "load_error";
  if (noTestsFoundPattern.test(output)) return "no_tests_found";
  return "unknown";
}

/**
 * Spawns the real Playwright Test runner directly via `node <cli.js>`
 * (the current `node` binary, not `npx`) against exactly one generated
 * spec file — the same Windows-safe direct-spawn pattern already used by
 * src/mcp/test-client.ts, avoiding the `.cmd` wrapper issue documented in
 * README's Known limitations. This is not a custom Playwright runner: it
 * is the same `@playwright/test` CLI a user would invoke by hand.
 *
 * Returns a `VerificationOutcome` that structurally distinguishes "the
 * test executed and its assertion failed" (`executed: true, outcome:
 * "failed"` — the regression test doing its job against a still-buggy
 * target) from "the runner/environment never got the test running at
 * all" (`executed: false, reason: ...`) — see src/testgen/types.ts.
 */
export function verifyGeneratedTest(specPath: string, options: { baseUrl?: string } = {}): Promise<VerificationOutcome> {
  // `WEBCHECK_TEST_DIR` (read by playwright.config.ts) is pinned to the
  // spec file's own directory for every invocation — generated tests
  // live under a run's own artifact directory, which for an isolated
  // test run (runFlow({ artifactRoot })) sits entirely outside the
  // project directory, where a fixed relative testDir could never find
  // it. Verified directly (not assumed): Playwright Test's positional
  // file argument must also be forward-slash-normalized on Windows — a
  // backslash-separated path (absolute *or* relative) fails to match at
  // all ("No tests found") even though the file genuinely exists.
  const testDir = path.dirname(specPath);
  const fileName = path.basename(specPath).split(path.sep).join("/");
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PLAYWRIGHT_CLI, "test", fileName, "--config", CONFIG_PATH], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        WEBCHECK_TEST_DIR: testDir,
        // Verified directly (not assumed): a generated test does not
        // necessarily live anywhere under PROJECT_ROOT — a real target
        // app's own .webcheck/ directory is a separate npm project with
        // no access to *this* project's node_modules, so Node's normal
        // ancestor-directory walk fails to resolve "@playwright/test"
        // from the spec file's own location ("Cannot find module").
        // NODE_PATH is Node's documented fallback module search path.
        NODE_PATH: [path.join(PROJECT_ROOT, "node_modules"), process.env["NODE_PATH"]].filter(Boolean).join(path.delimiter),
        ...(options.baseUrl !== undefined ? { WEBCHECK_BASE_URL: options.baseUrl } : {})
      }
    });

    let output = "";
    let settled = false;

    const finish = (outcome: VerificationOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish({
        executed: false,
        reason: "timeout",
        message: `verification did not complete within ${OVERALL_TIMEOUT_MS}ms`,
        output
      });
    }, OVERALL_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf-8");
    });

    child.on("error", (err) => {
      // A genuine process-level failure (executable not found, EACCES,
      // ...) — a pure process signal, no text matching involved.
      finish({ executed: false, reason: "spawn_error", message: err.message, output });
    });

    child.on("close", (code) => {
      const durationMs = Date.now() - startedAt;

      if (ranTestsPattern.test(output)) {
        finish({ executed: true, outcome: code === 0 ? "passed" : "failed", exitCode: code ?? -1, durationMs, output });
        return;
      }

      const reason = classifyStartupFailure(output);
      finish({
        executed: false,
        reason,
        message: `the Playwright Test runner exited (code ${code ?? "null"}) without producing a normal pass/fail report`,
        output
      });
    });
  });
}
