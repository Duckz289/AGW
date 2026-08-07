# Current Task — Phase 4A.1 Evidence Finalization + Verification Result Hardening

## Phase 4A.1 patch notes (this milestone)

A correctness patch over Phase 4A, not a new feature. Two fixes:

1. **Evidence finalization ordering.** `runFlow()`'s network-settle wait
   (`BrowserSession.waitForNetworkSettle()`, bounded `networkidle`,
   1000ms) used to run in the `finally` block, *after* `finalize()` had
   already read `events.ndjson` back for `runCheckers()`. A flow whose
   *last* step triggers a network request with no subsequent
   verification could reach checker execution before that request's
   `network_response`/`network_failed` event had landed, silently
   producing no `NW-HTTP-ERROR`/`NW-TRANSPORT-FAILURE` Finding — reliably
   reproduced (not assumed) while building Phase 4A's own tests. Fixed by
   moving the wait to the top of `finalize()` itself (the single funnel
   every exit path from a run goes through: early failure, stale
   snapshot, internal error, or a full pass), and removing the now-
   redundant call from `finally`. Still exactly one bounded
   `networkidle` wait per run, not after every action. Proof:
   `tests/integration/final-evidence-boundary.test.ts` (12 repeated runs
   per scenario, HTTP 500 and transport failure, both with **no** inline
   `expected` workaround on the triggering step).
2. **Generated-test verification result model.** The old `verified:
   boolean` field only meant "was the file executed" — ambiguous next to
   a regression test that is *expected* to fail against a still-buggy
   target. Replaced with a structured `VerificationOutcome` (see below)
   that makes `executed: true, outcome: "failed"` (the test ran fine;
   the bug still exists) structurally impossible to confuse with
   `executed: false, reason: ...` (the runner/environment never produced
   a pass/fail report at all — module resolution failure, no tests
   found, a load/syntax error, a spawn error, or a timeout).
   `src/testgen/verify.ts` classifies which; the CLI's `Status` field
   only becomes `verification_failed` for the latter — a failing
   assertion is a successful `export-test` operation (CLI exit `0`), not
   a WebCheck error.

Supported rules, locator priority, and the fail-on-bug/pass-on-fix
assertions are all **unchanged** — see below (unchanged from Phase 4A).

## Scope

Generates reproducible Playwright regression tests from a run's own
already-validated `report.json` Findings, for a deliberately narrow,
conservative set of Finding classes. No LLM anywhere in generation. Does
**not** generate tests for every Finding, generate source-code fixes,
add CI/GitHub integration, or add new MCP tools.

## Supported Finding classes

Exactly three (`src/testgen/types.ts::SUPPORTED_RULE_IDS`):

- `RT-EXCEPTION`
- `NW-HTTP-ERROR`
- `NW-TRANSPORT-FAILURE`

Everything else — `ST-INFINITE-LOADING`, `FM-SERVER-ERROR-NOT-SHOWN`, and
any future rule — returns a structured `unsupported` result. Generation
never throws for an unsupported or malformed request; every outcome is
one of `TestGenerationStatus`'s four values.

```ts
type TestGenerationStatus = "generated" | "unsupported" | "insufficient_evidence" | "verification_failed";

interface GeneratedTestResult {
  status: TestGenerationStatus;
  findingId: string;
  ruleId: string;
  outputPath?: string;
  reason?: string;
  verification?: VerificationOutcome;  // present only when --verify actually attempted execution
}

type VerificationFailureReason =
  | "spawn_error" | "module_resolution_failure" | "no_tests_found" | "load_error" | "timeout" | "unknown";

type VerificationOutcome =
  | { executed: true; outcome: "passed" | "failed"; exitCode: number; durationMs: number; output: string }
  | { executed: false; reason: VerificationFailureReason; message: string; output: string };
```

## Source-of-truth invariant

Generation reads exactly three structured artifacts — never Markdown,
never prose, never an LLM call:

```text
report.json (Finding: ruleId, actionId, evidence[], observed)
+ flow.json (the original ScriptedFlow, redacted, persisted per run)
+ events.ndjson (action_started.stepIndex resolves actionId -> flow step;
                 network_request/network_failed resolve method+URL)
  -> src/testgen/generator.ts::planGeneratedTest()  (pure, no I/O)
  -> src/testgen/render.ts::renderGeneratedTest()   (pure, deterministic)
  -> src/testgen/write.ts::writeGeneratedTest()     (atomic write)
```

`action_started`'s own `stepIndex` payload field is the *only*
correlation mechanism used to map a Finding's `actionId` back to the
exact flow step that triggered it — never inferred from counting or
timing. `network_request`/`network_failed` events (found via the
Finding's own evidence `seq`s) supply the request's method + URL for the
two network rules; `network_failed` carries these directly since
`NW-TRANSPORT-FAILURE` findings never reference a separate
`network_request` evidence entry (src/checkers/network.ts).

## Flow persistence: `flow.json`

`src/engine/flow-persist.ts::writeFlowArtifact()` writes the validated,
redacted original flow to `<runDir>/flow.json` at the very start of
`runFlow()` (right after the timeline directory exists, before any step
runs) — so it exists even for a run that later fails or hits
`internal_error`. Redaction: a fill step whose target (testId/role/name/
label/placeholder) names a conventionally sensitive field (password,
token, ...) has its value replaced outright with `[REDACTED]`
(`ScriptedFlowSchema` has no `{{secret:...}}` placeholder mechanism yet,
so this is the only available signal); every other free-text field is
also passed through `redactText()` defensively. A write failure here is
a hard artifact-integrity failure — `internal_error`,
`FLOW_ARTIFACT_FAILURE` — short-circuiting before any browser session is
created, mirroring the evidence-init failure path.

## Locator strategy

`src/testgen/locator.ts::resolveLocatorPlan()` — same priority as
`docs/decisions/0001-element-targeting.md`: testId -> role+name -> label
-> placeholder. `role` without `name` is treated as absent. Returns
`undefined` (never a coordinate click, never a guessed CSS selector) when
none of the four fields are present, which the generator turns into
`insufficient_evidence`. A structural 5th "exact text" tier is not
implemented: `SemanticTargetSchema` never carries free text and its own
`refine` guarantees one of the four fields above is always present
whenever a target exists, so that tier would be unreachable code.

## Flow reconstruction

`src/testgen/generator.ts::buildReplayPrefix()` replays flow steps
`[0, stepIndex)` — the minimum prefix up to (not including) the
triggering step — then the triggering step itself. `expect` steps are
skipped during replay (verification, not action; not needed to
reproduce the defect). No `waitForTimeout()` anywhere in any of the
three templates — network rules use `page.waitForResponse()`/
`page.waitForEvent("requestfailed")` raced via `Promise.all`/
`Promise.race`, which resolve on a real Playwright event rather than a
fixed sleep.

## Per-rule generation (`src/testgen/render.ts`)

- **RT-EXCEPTION**: registers `page.on("pageerror", ...)` before
  navigating, replays the flow, then `expect(pageErrors).toHaveLength(0)`
  — fails if any uncaught exception occurred. The original observed
  message is included in the assertion's diagnostic text (redacted
  again), not asserted as an exact stack match.
- **NW-HTTP-ERROR**: races `page.waitForResponse(method+path matcher)`
  against the triggering action via `Promise.all`, then
  `expect(response.status()).toBeLessThan(400)` — the mandatory correct-
  behavior assertion (never `.toBe(500)`, which would pass while the bug
  still exists).
- **NW-TRANSPORT-FAILURE**: races `waitForEvent("requestfailed", ...)`
  against `waitForResponse(...)` via `Promise.race` (a fixed backend
  produces a normal response, never a `requestfailed` event, so exactly
  one of the two always resolves — no timeout needed for the "fixed"
  case), then asserts the outcome was a response, not a failure.
  `ERR_ABORTED` is never generated for, because `checkTransportFailures`
  already excludes it from ever becoming a Finding.

Request identity is matched on method + URL **path** only (not full URL,
not port) — a real target app runs on a fixed port a user controls, but
this project's own isolated test runs spin up a fresh fixture server on
a random port each time, so path-only matching is what actually makes
the same generated file replayable against multiple server instances via
`WEBCHECK_BASE_URL`.

## Generated test format

Uses `@playwright/test` (added as a new devDependency in this milestone,
pinned to `1.62.1` to match the already-installed `playwright` core
package — the target repro capability requires actually executing
generated files, which the previously-installed `playwright` package
alone cannot do). Every file:

```ts
// Generated by WebCheck
// Finding: finding-0001
// Rule: NW-HTTP-ERROR
// Source run: <runId>
import { test, expect } from "@playwright/test";

const BASE_URL = process.env.WEBCHECK_BASE_URL ?? "<flow.startUrl>";
...
```

`BASE_URL` defaults to the original flow's `startUrl` (realistic for a
real dev server on a fixed port) and is overridable via
`WEBCHECK_BASE_URL` — the seam this project's own integration tests use
to point a generated file at a fresh, isolated fixture-server instance.

## Output location

`<runDir>/generated-tests/<findingId>.spec.ts` — filename derived only
from the already-safe, deterministic `finding-NNNN` id (never the
Finding's title). `src/testgen/write.ts` rejects any findingId that
isn't exactly that shape before ever joining it into a path
(path-traversal guard), and writes atomically (temp file + rename,
mirroring `src/report/write.ts`) — no partial `.spec.ts` is ever left on
failure.

## Execution / verification (`src/testgen/verify.ts`)

`verifyGeneratedTest(specPath, { baseUrl? })` spawns the real
`@playwright/test` CLI directly via `node <cli.js>` (the current `node`
binary, not `npx` — the same Windows `.cmd`-wrapper-avoidance pattern
`src/mcp/test-client.ts` already uses) and returns a `VerificationOutcome`
(see above). Three Windows-specific quirks were found and fixed
empirically (not assumed), all required for a generated file located
*anywhere*, not just under this project's own `.webcheck/`:

1. Playwright Test's positional file argument must be forward-slash
   normalized — a backslash-separated path (relative or absolute) fails
   to match with "No tests found" even though the file exists.
2. `testDir` is read from `WEBCHECK_TEST_DIR` (falling back to
   `.webcheck` for manual/default usage), set per-invocation to the
   spec file's own directory — a generated test does not necessarily
   live under this project's directory tree at all (a real target app's
   `.webcheck/` is a separate npm project), so a fixed relative
   `testDir` can never find it.
3. `NODE_PATH` is set to this project's own `node_modules` — Node's
   module resolution for `import { test } from "@playwright/test"`
   walks up from the spec file's *own* location and fails
   ("Cannot find module") when that file lives outside any directory
   tree with access to this project's dependencies, which is exactly
   the isolated-artifact-root case this project's own tests use.

**Failure classification** (Phase 4A.1): `child.on("error")` (process
never spawned) is a pure process-level signal → `reason:
"spawn_error"`. Otherwise, if the combined stdout+stderr matches a
normal Playwright summary line (`N passed`/`N failed`), the test
genuinely executed → `executed: true`. Otherwise the runner never
collected any test at all, and *why* is classified from output text —
unavoidable here since Playwright exposes the same nonzero exit/"No
tests found." trailer for multiple distinct startup-failure causes
(AGENT.MD: text matching only where exit code alone is insufficient),
checked in specificity order (verified directly — a syntax error's
output *also* ends with "No tests found.", so the generic pattern must
be checked last or it always wins): `Cannot find module` →
`module_resolution_failure`; a parse/syntax error pattern → `load_error`;
otherwise `no_tests_found`; anything unrecognized → `unknown`. A
`setTimeout` guard (60s, well above the 15s per-test config timeout)
guarantees `verifyGeneratedTest()` itself can never hang → `reason:
"timeout"`. See `tests/integration/testgen-verify.test.ts`.

Not a custom Playwright runner — the same `@playwright/test` CLI a user
would invoke by hand, with the config overrides above making it locatable
and resolvable regardless of where the generated file physically lives.

## CLI

```text
webcheck export-test <runId> <findingId> [--verify]
```

Loads `report.json`/`flow.json`/`events.ndjson` from
`.webcheck/runs/<runId>/` by hand (validated against their real Zod
schemas), generates, writes, and prints status. `--verify` additionally
executes the generated file once immediately — never executed by
default. `runId` is validated as a bare path segment
(`path.basename(runId) === runId`) before ever being joined into a
filesystem path. Print format (`src/cli/index.ts::formatExportTestOutput`,
a pure function unit-tested directly for all four shapes —
`tests/unit/cli-export-test-output.test.ts`):

```text
Finding: finding-0001
Rule: NW-HTTP-ERROR
Status: generated
Test: .webcheck/runs/<runId>/generated-tests/finding-0001.spec.ts
Verification executed: yes
Verification outcome: failed
Exit code: 1
```

`Verification outcome`/`Exit code` lines appear only when
`executed: true`; when `executed: false`, `Verification reason` and
`Verification message` appear instead — the two shapes never both
print. `Status` stays `generated` (CLI exit `0`) for both `outcome:
"passed"` and `outcome: "failed"` — only `executed: false` flips
`Status` to `verification_failed` (CLI exit `2`).

## Failure semantics

- Generation (`plan` -> `render`) never throws — every outcome is a
  `GeneratedTestResult` with one of the four statuses.
- A write failure (`TestWriteError`) propagates as a thrown error from
  `generateTest()` — none of the four `TestGenerationStatus` values mean
  "the plan was good but the file couldn't be written," so the CLI
  handles it as a distinct, structured operational error (`Result:
  ERROR`, exit 2), without corrupting any existing run artifact.
- `export-test` never changes the original run's `FlowRunStatus` —
  it operates on an already-finished run's artifacts, in a separate
  process/invocation, well after that run completed.

## MCP

Unchanged — no new MCP tools, no MCP-driven test generation. Existing
MCP proof (`npm run mcp:test`) remains green.

## Fixture bug/fix toggle

`fixtures/server.ts::startFixtureServer(port, { mode })` — `"buggy"`
(default, unchanged Phase 0-3B behavior) vs `"fixed"`: `/api/login`
ignores `forceError`, `/api/transport-fail` responds normally instead of
destroying the socket, and `index.html` injects
`window.__WEBCHECK_FIXTURE_MODE__` for `app.js`'s throw-error-button
handler to read. The *same* scripted flow (and so the same generated
test) reproduces the bug against `"buggy"` and no longer reproduces it
against `"fixed"`, without the flow or the generated file changing at
all — this is what makes the mandatory fail-on-bug/pass-on-fix proof
possible without a new fixture framework.

## Dependencies

`@playwright/test@^1.62.1` added as a new devDependency — explicitly
confirmed with the user first (the milestone's own instruction: "if a
new dependency is required, stop, explain the need"), since actually
executing generated Playwright Test files is a mandatory requirement
this milestone cannot satisfy with the previously-installed `playwright`
core package alone. No other dependency changes.

## Stop condition

Do not begin Phase 4B (linking verified regression-test artifacts back
into `report.json`/`report.md`) without a new explicit task.
