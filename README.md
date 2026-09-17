# WebCheck Agent

WebCheck Agent is a local-first frontend testing tool, controlled by a
coding agent (Claude Code, Cursor, Codex, ...) over MCP, or scripted
directly. It drives Chromium via Playwright, observes pages through an
AI-oriented accessibility snapshot, executes typed browser actions, and
is meant to eventually collect evidence (console, network, screenshots,
traces) and produce deterministic findings. See `MVP_PLAN.MD` for the
full product/architecture plan.

## Engineering overview

Use this project to inspect reproducible failures in local frontend flows. The scripted pipeline is:

`Playwright flow → redacted evidence timeline → deterministic checkers → JSON/Markdown reports → regression test`

- Evidence references bind findings to exact timeline events; report rendering does not rerun checks.
- Typed actions, stale-snapshot rejection, and a loopback URL policy constrain browser control.
- Unit and browser integration tests cover reports, redaction, evidence finalization, and generated-test verification.

**Current maturity:** an early local implementation. The MCP server exposes browser control, but does not yet produce the scripted pipeline's evidence or reports. Test generation supports three finding classes. See [known limitations](#known-limitations).

## Quick start

With Node.js 20+ and npm installed:

```bash
npm ci
npx playwright install chromium
npm run fixture
```

In a second terminal:

```bash
npm run webcheck -- run --flow fixtures/flows/login-success.json
```

See [typecheck and tests](#typecheck-and-tests) for verification and [MCP proof](#mcp-proof) for the separate agent-control interface. Detailed implementation notes follow.

## Status: Phase 4A.1 — Evidence Finalization + Verification Result Hardening (complete)

This repository implements **Phase 0** (technical spikes, MCP proof, and
the minimal shared engine), **Phase 1A** (a deterministic scripted flow
runner plus a CLI to run it), **Phase 2A** (an append-only evidence
timeline per run — collectors, redaction, action correlation,
screenshot-on-failure evidence), **Phase 2B** (five deterministic checker
rules that consume that timeline and produce `CheckerResult[]`),
**Phase 3A** (a structured `Finding` model and a machine-readable
`report.json` per run, built deterministically from checker results),
**Phase 3B** (a deterministic, pure Markdown renderer that turns the same
validated `report.json` object into a human-readable `report.md`),
**Phase 4A** (a deterministic, non-LLM Playwright regression-test
generator for exactly three supported Finding classes, with real
fail-on-bug/pass-on-fix execution), and **Phase 4A.1**: a correctness
patch fixing the evidence-finalization ordering (network events now
settle *before* checker execution, not after) and hardening the
generated-test verification result into a structured, unambiguous model
— see "Regression test generation" below. It does **not** implement AI
summaries, root-cause hypotheses, severity/confidence scoring, CAPTCHA
handling, an embedded LLM planner, CI/GitHub integration, or any later
roadmap phase. Do not treat anything
here as a working end-to-end WebCheck product yet.

What exists:

- A deterministic local fixture site + server (`fixtures/`), plus four
  fixture flow JSON files (`fixtures/flows/`).
- Four spikes proving Chromium lifecycle, the AI accessibility snapshot,
  element targeting + staleness behavior, and evidence/trace collection
  (`spikes/`).
- An ADR recording the element-targeting decision
  (`docs/decisions/0001-element-targeting.md`).
- A minimal shared engine: one browser session, snapshot versioning,
  semantic target resolution, one action executor, stale-snapshot
  rejection, a loopback-only URL policy, a deterministic verification
  engine (`url_matches` / `element_visible` / `element_hidden` /
  `text_present`), and a scripted flow runner (`src/engine/`).
- An append-only NDJSON evidence timeline per run (`src/timeline/`),
  console/runtime-error/network collectors (`src/collectors/`), and a
  deterministic secret redactor (`src/security/redactor.ts`) — see
  "Evidence artifacts" below.
- Five deterministic checker rules (`src/checkers/`) that consume a run's
  own timeline and produce `CheckerResult[]` — see "Checkers" below.
- A structured `Finding` model and a machine-readable `report.json` built
  deterministically from checker results (`src/findings/`,
  `src/report/`), plus a deterministic, pure Markdown renderer
  (`src/report/markdown.ts`) that turns that same validated report object
  into a human-readable `report.md` — see "Reports" below.
- Zod schemas for the MCP tool inputs, the browser action model, the
  scripted-flow/expectation model (including the minimal Phase 2B
  `checks` declaration), the timeline event model, and the
  Finding/report models (`src/schemas/`, `src/timeline/events.ts`,
  `src/findings/schema.ts`, `src/report/schema.ts`).
- A minimal MCP server exposing `webcheck_start`, `webcheck_observe` and
  `webcheck_act`, plus a real MCP client that drives it end to end
  (`src/mcp/`). MCP does not yet pass a timeline into `BrowserSession`, so
  agent-driven MCP sessions produce no evidence artifact, checker
  results, or report in this milestone (see "Known limitations").
- A CLI (`src/cli/index.ts`) that loads a flow, runs it, writes evidence,
  flow, and report artifacts automatically, prints a concise checker
  summary, and exits with a deterministic exit code; plus an
  `export-test` command that generates a regression test from an
  existing run's report — see "Regression test generation" below.
- A deterministic, non-LLM regression-test generator (`src/testgen/`)
  for `RT-EXCEPTION` / `NW-HTTP-ERROR` / `NW-TRANSPORT-FAILURE` Findings,
  and a persisted `flow.json` per run (`src/engine/flow-persist.ts`) so
  a run's original flow is available for later, separate test
  generation — see "Regression test generation" below.
- Unit and integration tests (`tests/`).

## Checkers

Five rules, each a pure function over the run's own already-redacted
timeline (`src/checkers/`): `RT-EXCEPTION`, `NW-HTTP-ERROR`,
`NW-TRANSPORT-FAILURE`, `ST-INFINITE-LOADING`, `FM-SERVER-ERROR-NOT-SHOWN`.
See `CURRENT_TASK.md` for the full trigger/classification/false-positive
table. Two of the five (`ST-INFINITE-LOADING`, `FM-SERVER-ERROR-NOT-SHOWN`)
require an explicit declaration in the flow file and produce nothing
without one:

```json
{
  "checks": {
    "loadingIndicator": { "role": "status", "name": "Loading" },
    "errorIndicator": { "role": "alert", "name": "Server error, please try again." }
  }
}
```

`runFlow()` runs all five automatically after every run (reading the
run's own just-written `events.ndjson` back — not a parallel in-memory
structure) and attaches the result to `FlowRunResult.checkerResults`.
The CLI prints one summary line, e.g. `Checks: 0 confirmed, 1 likely, 0
warnings` — never verbose findings, and exit codes are unaffected by
checker results.

## Reports

Every run also writes `.webcheck/runs/<runId>/report.json` —
`schemaVersion: 1`, pretty-printed, UTF-8, written atomically (temp file
+ rename, so a previous good file — or its absence — is never left
partially overwritten):

```ts
interface WebCheckReport {
  schemaVersion: 1;
  run: { runId; flowName; status; startedAt; finishedAt; durationMs; completedSteps; evidencePath };
  summary: { findings: number; confirmed: number; likely: number; warnings: number };
  findings: Finding[];
  limitations: string[]; // fixed, short, currently-true only
}
```

Each `CheckerResult` becomes one `Finding` (`id`, `ruleId`, `title`,
`classification` — straight from the checker's `status`, no severity/
confidence scoring — `category` deterministically mapped from the rule-id
prefix, `summary`/`observed`/`expected`, and `evidence: EvidenceRef[]`
resolved from the *exact* matching `events.ndjson` line by `seq` — never
the closest one, never a copy of the raw payload). A checker result
referencing a `seq` that doesn't exist in the timeline is a hard build
error (`MissingEvidenceError` → `ReportBuildError`), not a silently
dropped reference. See `CURRENT_TASK.md` for the full Finding/report
schema and the checker→Finding field mapping.

Every run also writes `.webcheck/runs/<runId>/report.md` — a
human-readable Markdown rendering of the *same* validated
`WebCheckReport` object, produced by `renderMarkdownReport()`
(`src/report/markdown.ts`): pure, deterministic (no filesystem/browser/
timeline/checker access, no mutation, same input → byte-identical
output), written atomically the same way as `report.json`
(`src/report/write-markdown.ts`, temp file + rename). `report.md` is a
presentation layer only — **`report.json` remains the machine-readable
source of truth**; Markdown never re-runs checkers, never rebuilds
findings, and is never read back by any other part of WebCheck. Its
structure is fixed: `# WebCheck Report` → `## Run Summary` → `##
Findings` (one `### finding-000N — <title>` subsection per finding, with
an `#### Evidence` list) → `## Limitations` → `## Artifact References`.
Free-text finding fields (`summary`/`observed`/`expected`) are rendered
inside fenced code blocks whose fence length is computed to exceed the
longest run of backticks already in the content (so the content can
never prematurely close its own fence), and are capped at 4000
characters with a truncation marker; single-line fields (title, rule id,
flow name) have embedded newlines collapsed to spaces so they cannot
inject a fake heading or list item. `redactText()` runs again on every
free-text field inside the renderer itself — `report.md` is a new
persistence boundary, so it does not rely solely on upstream redaction
having already happened.

If report.json generation fails, behavior is unchanged from Phase 3A. If
report.json succeeds but Markdown rendering or writing fails, the run is
classified `internal_error` (`MARKDOWN_REPORT_FAILURE`) while the
already-written `report.json` and `events.ndjson` are left untouched —
Markdown is a presentation layer over an already-complete artifact, not
a dependency of it, so a failure there never corrupts or deletes the
good artifacts that came before it.

The CLI prints where all three artifacts landed:

```text
Evidence: .webcheck/runs/1b6e2c3a-.../events.ndjson
Report:   .webcheck/runs/1b6e2c3a-.../report.json
Markdown: .webcheck/runs/1b6e2c3a-.../report.md
```

`report.json` never embeds `events.ndjson`'s content — only `seq`
references back into it — and `report.md` never embeds anything beyond
what `report.json` already contains. The pipeline is strictly
`events.ndjson → checker results → report.json → report.md`: each stage
is derived only from the one before it, never rebuilt independently.

## Regression test generation

Every run also writes `.webcheck/runs/<runId>/flow.json` — the
validated, redacted original `ScriptedFlow` (a fill step targeting a
conventionally sensitive field, e.g. a password, has its value replaced
with `[REDACTED]` outright; every other free-text field is passed
through the same deterministic redactor). This exists so a later,
*separate* `export-test` invocation can reconstruct a reproduction
without ever parsing `report.md` or prose.

`webcheck export-test <runId> <findingId> [--verify]` generates a
deterministic Playwright regression test for one Finding, from
`report.json` + `flow.json` + `events.ndjson` alone — no LLM anywhere.
Exactly three Finding classes are supported:

- `RT-EXCEPTION` — asserts `expect(pageErrors).toHaveLength(0)` after
  replaying the flow, with `page.on("pageerror", ...)` registered before
  navigation.
- `NW-HTTP-ERROR` — races `page.waitForResponse()` against the
  triggering action, asserts `expect(response.status()).toBeLessThan(400)`.
- `NW-TRANSPORT-FAILURE` — races `waitForEvent("requestfailed")` against
  `waitForResponse()`, asserts the outcome was a normal response.

Every other Finding class (`ST-INFINITE-LOADING`,
`FM-SERVER-ERROR-NOT-SHOWN`, and anything not yet implemented) returns a
structured `unsupported` result — generation never throws for an
unsupported or malformed request:

```ts
type TestGenerationStatus = "generated" | "unsupported" | "insufficient_evidence" | "verification_failed";
interface GeneratedTestResult {
  status: TestGenerationStatus;
  findingId: string;
  ruleId: string;
  outputPath?: string;
  reason?: string;
  verification?: VerificationOutcome; // present only when --verify actually attempted execution
}
type VerificationOutcome =
  | { executed: true; outcome: "passed" | "failed"; exitCode: number; durationMs: number; output: string }
  | { executed: false; reason: "spawn_error" | "module_resolution_failure" | "no_tests_found" | "load_error" | "timeout" | "unknown"; message: string; output: string };
```

The triggering flow step is reconstructed via the Finding's own
`actionId`, resolved through the exact `action_started.stepIndex` event
`flow-runner.ts` itself recorded — never inferred from counting or
timing. The element locator uses the same priority as
`docs/decisions/0001-element-targeting.md` (testId → role+name → label →
placeholder); if none of those are available, generation returns
`insufficient_evidence` rather than guessing a coordinate click or a CSS
selector. No `waitForTimeout()` anywhere — the network-rule templates
use real Playwright event waits (`waitForResponse`/`waitForEvent`) raced
against the triggering action.

Generated files go to
`.webcheck/runs/<runId>/generated-tests/<findingId>.spec.ts` (a
deterministic filename from the Finding's own id — never its title) and
use `@playwright/test` (added as a devDependency in this milestone,
pinned to match the already-installed `playwright` core package). `
--verify` executes the generated file once immediately via the real
`@playwright/test` CLI and reports whether it actually ran — generation
never executes anything by default.

`verification.executed: true` means the file was genuinely spawned and
produced a normal pass/fail report; it is never set from static
inspection. `verification.outcome: "failed"` (the assertion did not
hold) is structurally distinct from `executed: false` (the runner or
environment never got the test running at all — module resolution
failure, no tests found, a load/syntax error, a spawn error, or a
timeout) — a generated file that correctly reproduces an existing bug is
*expected* to report `outcome: "failed"` when executed, which is a
successful `export-test` operation, not a WebCheck error (CLI exit code
stays `0`); only `executed: false` is treated as an operational problem
(CLI exit code `2`, `status: "verification_failed"`).

The regression-test convention is fail-on-bug / pass-on-fix: a generated
test asserts the *desired correct behavior* (e.g.
`toBeLessThan(400)`), never that the bug still exists (never
`toBe(500)`) — so the same, unmodified generated file fails against a
buggy target and passes once the target is fixed. This is verified for
real (not merely inspected) against `fixtures/server.ts`'s
`{ mode: "buggy" | "fixed" }` toggle for all three supported rules — see
`tests/integration/testgen.test.ts`.

## Evidence artifacts

Every `runFlow()` call (and so every CLI run) writes an append-only
NDJSON timeline to `.webcheck/runs/<runId>/events.ndjson`
(`runId` is a fresh `crypto.randomUUID()`, never derived from the flow
name or any other user-controlled input), plus screenshots on failure to
`.webcheck/runs/<runId>/screenshots/`. `.webcheck/` is git-ignored, the
same as `phase0-artifacts/`.

Each line is one JSON envelope:

```ts
interface TimelineEnvelope<T> {
  version: 1;
  seq: number;             // starts at 1, strictly increasing, never reused
  runId: string;
  timestampWallMs: number; // Date.now()
  timestampMonoMs: number; // performance.now()
  type: TimelineEventType; // run_started | run_finished | action_started |
                            // action_finished | verification | console |
                            // runtime_error | network_request |
                            // network_response | network_failed |
                            // network_finished | screenshot
  actionId?: string;       // present when a browser action was active when this was captured
  payload: T;
}
```

**Captured**: console messages (level/text/location), uncaught page
exceptions (kept distinct from console — never flattened together),
network request/response/failure/finish metadata (method, URL, status,
content-type, timing from `requestfinished`), verification results, and
one screenshot per action or verification failure (never on success).

**Not captured by default**: request/response bodies, raw headers (only
`content-type`), cookies/storage/auth state. Metadata-first by design.

**Redaction** (`src/security/redactor.ts`) always runs before anything is
persisted, and before truncation, so a size cut can never leave a partial
secret readable. It recognizes `password`, `passwd`, `token`,
`access_token`, `refresh_token`, `authorization`, `cookie`, `set-cookie`,
`api_key`, `apikey`, `secret`, `session`, `sessionid` (case-insensitive,
as `key=value`/`key: value`/a quoted JSON key), plus standalone
`Bearer <token>` forms, and redacts sensitive URL query parameter values
in place (harmless parameters are preserved).

See `CURRENT_TASK.md` for the full architecture note and observed
evidence limitations (in particular: the very last network-triggering
action's trailing `network_finished` event can race with run teardown and
be absent — reliably reproduced, documented, not a bug).

## Running a scripted flow

Start the fixture server (it listens on `http://127.0.0.1:4300` by
default):

```bash
npm run fixture
```

In another terminal, run a flow against it:

```bash
npm run webcheck -- run --flow fixtures/flows/login-success.json
```

Exit codes: `0` = flow passed, `1` = ordinary flow failed, `2` =
`config_error` / `environment_error` / `internal_error`. The structured
`FlowRunResult.status` (see `src/engine/flow-runner.ts`) distinguishes
all three exit-2 causes even though the CLI maps them to the same exit
code:

- `config_error` — invalid/unreadable flow file, or a `startUrl` outside
  the loopback allowlist.
- `environment_error` — browser launch failure, or the target server was
  unreachable when the run started.
- `internal_error` — an unexpected exception from WebCheck's own
  engine/runtime that isn't one of the above (not a config problem, not
  an environment problem, and not an ordinary action/verification/
  stale-snapshot failure, all of which remain `failed`).

See `fixtures/flows/` for the four example flows (`login-success`,
`login-wrong-url`, `login-missing-element`, `stop-on-failure`) and
`src/schemas/flow.ts` for the flow/expectation schema. `url_matches` is a
plain substring match against the current page URL, not a regular
expression.

Every run also prints where its evidence landed, e.g.:

```text
Evidence: .webcheck/runs/1b6e2c3a-.../events.ndjson
```

The CLI never dumps timeline contents to stdout — inspect the file
directly (it's newline-delimited JSON; `jq . events.ndjson` or similar
works well).

## Prerequisites

- Node.js >= 20 (developed against Node 24).
- npm.

## Install

```bash
npm install
```

## Install Chromium

```bash
npx playwright install chromium
```

## Run the fixture server standalone

```bash
npm run fixture
```

Prints the URL it's listening on (defaults to `http://127.0.0.1:4300`,
falls back to a free port if that one is taken).

## Run the spikes

Each spike starts its own fixture server and browser, and prints a
PASS/FAIL line per check.

```bash
npm run spike:browser
npm run spike:snapshot
npm run spike:targeting
npm run spike:evidence
```

Artifacts (screenshots, captured snapshots, the evidence event log, and
the Playwright trace) are written to `phase0-artifacts/` (git-ignored).

## Typecheck and tests

```bash
npm run typecheck
npm run test:unit
npm run test:integration
npm test
npm run lint
```

## MCP proof

Runs a real MCP client (over stdio, against the actual server process)
through `webcheck_start` → `webcheck_observe` → `webcheck_act` →
`webcheck_observe`, and writes a sanitized transcript to
`phase0-artifacts/mcp-proof.json`.

```bash
npm run mcp:test
```

To run the MCP server standalone (e.g. to point an MCP-capable client at
it manually):

```bash
npm run mcp
```

## Open the Playwright trace

`npm run spike:evidence` generates `phase0-artifacts/04-trace.zip`.

```bash
npx playwright show-trace phase0-artifacts/04-trace.zip
```

## Known limitations

- Only one active browser session is supported at a time, matching the
  Phase 0 / MVP scope (`MVP_PLAN.MD` §6.1).
- The MCP tool set is limited to `webcheck_start` / `webcheck_observe` /
  `webcheck_act`. There is no `webcheck_finish`, no reporting, and no
  regression-test generation yet. Phase 1A's flow runner is a CLI-only
  capability — it is not exposed as an MCP tool. MCP-driven sessions do
  not produce an evidence artifact in Phase 2A either (`BrowserSession`
  accepts an optional `timeline`, but `src/mcp/server.ts` does not
  construct or pass one yet) — the collector/session API was
  deliberately structured so MCP can opt in later without duplicating
  evidence logic.
- Target resolution supports `testId`, `role`+`name`, `label` and
  `placeholder`, in that priority order. `getByText` and a CSS last
  resort from the full MVP plan are not implemented.
- `aria-ref=eN` locators work against the installed Playwright version
  but are undocumented internals; they are used only in
  `spikes/03-element-targeting.ts`, never in `src/`. See
  `docs/decisions/0001-element-targeting.md`.
- On Windows, spawning a `tsx`-run subprocess through `npx` (a `.cmd`
  wrapper) prevents clean process termination — killing the wrapper does
  not reliably terminate the real `node`/`tsx` process underneath.
  `src/mcp/test-client.ts` and `tests/integration/cli.test.ts` both spawn
  `tsx`'s CLI entry directly with the current `node` binary to avoid
  this; do the same if you write another client/subprocess test on
  Windows.
- `request.timing().responseEnd` is not populated at `response` time; it
  only becomes available once `requestfinished` fires. Both
  `spikes/04-evidence.ts` and the Phase 2A network collector
  (`src/collectors/network.ts`) read timing from `requestfinished`, not
  `response`.
- Scripted flows only support `navigate` / `fill` / `click` / `expect`
  steps and are loaded from local JSON files only — no YAML, no
  `select`/`scroll`/`press`/`wait`, no branching, loops or variables (all
  deferred past Phase 1A per `CURRENT_TASK.md`).
- `url_matches` is a plain substring/path match against `page.url()`, not
  a regular expression, by design (see `src/schemas/flow.ts`).
- No AI summary, root-cause hypothesis, severity/confidence scoring,
  regression-test generation, CAPTCHA policy, or embedded planner — out
  of scope through Phase 3B by design. Only five checker rules exist (see
  "Checkers" above); no duplicate-request, hydration, session-loss,
  responsive, accessibility, or performance rule, and so no
  corresponding `Finding.category` is ever actually produced yet even
  though the schema already accepts those values.
- `report.md`'s "Artifact References" section always lists
  `events.ndjson` and `report.json` as fixed, well-known sibling
  filenames rather than deriving them from `report.run.evidencePath` —
  the renderer is pure (no filesystem access), so it cannot resolve a
  relative path against an actual `cwd`; all three artifacts are always
  written as siblings in the same run directory by construction, so the
  bare filenames are already correct and portable. The `screenshots/`
  line is included only when at least one finding's evidence actually
  references a `screenshotPath` — since no current checker rule
  populates one (see the report.json screenshot-evidence limitation
  below), it does not appear in practice yet.
- Markdown escaping is a simple, deliberately non-exhaustive strategy
  (newline normalization for single-line fields, dynamically-sized
  fenced code blocks for free text, no raw HTML, no Markdown tables) —
  sufficient to guarantee free text can never break the document's
  section structure, but not a general-purpose Markdown sanitizer.
- `Finding.metadata` exists in the schema (`Record<string, JsonValue>`)
  but no current checker populates it — reserved for a future rule that
  needs structured extras without another Finding-shape change.
- Checkers and report generation share one read of `events.ndjson` (read
  back once inside `finalize()`, reused for both `runCheckers()` and
  `buildReport()`), so both always see exactly the same, already-durable,
  already-validated timeline.
- Chromium computes no accessible *name* from text content alone for
  `role="status"`/`role="alert"` elements — verified directly (not
  assumed): `getByRole("alert", { name: <exact visible text> })` matched
  zero elements even though the same text was visibly present and
  `getByRole("alert")` alone matched one. Unlike `heading`/`button`
  (name-from-content works there), the fixture's loading indicator and
  error message need an explicit `aria-label` kept in sync with their
  visible text for role+name checks to resolve at all
  (`fixtures/public/{index.html,app.js}`). Anything in your own target
  app using `role="status"`/`role="alert"` for a loading/error indicator
  will need the same treatment for `ST-INFINITE-LOADING`/
  `FM-SERVER-ERROR-NOT-SHOWN` (or `element_visible` checks generally) to
  resolve it by name.
- `ST-INFINITE-LOADING`/`FM-SERVER-ERROR-NOT-SHOWN` extract the role/name
  they were checking from a verification's `observed` text (via a regex
  coupled to `src/engine/verification.ts`'s exact wording,
  `src/checkers/element-target.ts`), because Phase 2A's
  `VerificationPayloadSchema` deliberately has no structured role/name
  field. A wording change in `verification.ts` would need a matching
  update there.
- `NW-HTTP-ERROR`/`NW-TRANSPORT-FAILURE` only upgrade to `confirmed` via
  an *inline* `expected` on the same action (i.e. an actionId-tagged
  verification) — a later, separate `expect` step (which carries no
  actionId) never triggers the upgrade. This is a deliberate scope
  boundary ("do not correlate across action boundaries"), not a bug.
- The fixture app's login handler updates the DOM only after its
  `fetch()` promise resolves, asynchronously with respect to the click
  that triggered it. `BrowserSession.act()` has no built-in
  network-settle wait (deferred to a later phase per `MVP_PLAN.MD` §10),
  so a test asserting on the snapshot returned directly from a click that
  triggers an async update is inherently racy.
  `tests/integration/fixture-flow.test.ts` was found to be flaky this way
  (reproduced on the original, unmodified Phase 0 file) and was fixed to
  poll for the expected DOM change instead — no production `src/` code
  was changed for this. Phase 1A's `expect` step type is the general
  solution to this class of race for scripted flows.
- Evidence collectors (`src/collectors/*.ts`) are best-effort: they run
  from async Playwright event listeners with no natural point in the
  flow's own control flow to await or retry against, so a write failure
  there is caught and does not change the run's own pass/fail outcome —
  unlike the flow's own critical-path timeline writes
  (`run_started`/`action_started`/`action_finished`/`verification`/
  `screenshot`/`run_finished`), which are awaited and do turn a write
  failure into `internal_error`.
- Closing the session immediately after the last step can otherwise race
  with in-flight network events at the CDP layer — reliably reproduced
  for a flow that ends right after the request-triggering action.
  `runFlow()` calls `BrowserSession.waitForNetworkSettle()` (a bounded,
  never-throwing `page.waitForLoadState("networkidle", {timeout: 1000})`)
  before closing, to give those events a chance to arrive. This adds up
  to ~0.5–1s of latency per run in exchange for reliable evidence
  capture — see `CURRENT_TASK.md` "Evidence limitations" for the
  reasoning.
- Console events are capped at 200 persisted per run and 2000 characters
  each; runtime error stacks are capped at 4000 characters
  (`src/collectors/limits.ts`). Once the console cap is hit, one
  truncation-notice event is appended and further console events in that
  run are dropped — this is a fixed limit, not an adaptive budget.
- **Fixed in Phase 4A.1** (previously listed here as an open limitation):
  a flow whose *last* step triggers a network request with no subsequent
  verification used to be able to reach checker execution before that
  request's `network_response`/`network_failed` event had landed,
  silently producing no `NW-HTTP-ERROR`/`NW-TRANSPORT-FAILURE` Finding —
  because `waitForNetworkSettle()` ran in `runFlow()`'s `finally` block,
  *after* `finalize()` had already read `events.ndjson` back for
  `runCheckers()`. The wait now runs as the first thing inside
  `finalize()` itself (`src/engine/flow-runner.ts`) — the single funnel
  every exit path from a run goes through — so it always completes
  before the timeline is read for checking, for every run outcome, not
  only a full pass. The inline-`expected` workaround this entry used to
  recommend is no longer necessary; see
  `tests/integration/final-evidence-boundary.test.ts` (12 repeated runs
  per scenario) for the regression proof. Still bounded (`networkidle`,
  1000ms) and still only waits once per run, not after every action.
- Regression-test generation only supports `RT-EXCEPTION`,
  `NW-HTTP-ERROR`, and `NW-TRANSPORT-FAILURE` — see "Regression test
  generation" above. Network-rule request matching is method + URL
  **path** only, never full URL or port, so a generated file is
  replayable against a target on any port (via `WEBCHECK_BASE_URL`) but
  cannot distinguish two endpoints that share a path on different hosts.
- `flow.json`'s password-field redaction (`src/engine/flow-persist.ts`)
  replaces the value outright with `[REDACTED]` rather than the original
  credential — a generated regression test replays that placeholder
  value, not the real one. For this project's own fixtures this makes no
  functional difference (the fixture's simulated bug depends only on a
  checkbox flag, never on password content), but a real target app whose
  bug genuinely depends on the exact original password value cannot be
  faithfully reproduced this way. `ScriptedFlowSchema` has no
  `{{secret:...}}` placeholder mechanism yet (MVP_PLAN.MD §11.3's
  vision, not implemented in this milestone), which is why redaction has
  no better option than replacing the value.
- `src/testgen/verify.ts` spawns the real `@playwright/test` CLI with
  two empirically-verified environment overrides — see
  `CURRENT_TASK.md`'s "Execution / verification" section for the exact
  Windows path-separator and module-resolution issues found and why
  `WEBCHECK_TEST_DIR`/`NODE_PATH` are set on every invocation. This
  matters most for a real target app, whose own `.webcheck/` directory
  is a separate npm project with no access to this project's
  `node_modules` on its own.
- The locator resolver's "exact text" priority tier (5th, after
  testId/role+name/label/placeholder) is not implemented: it would be
  unreachable given `SemanticTargetSchema`'s own guarantee that one of
  the other four fields is always present whenever a target exists.
