# ADR 0001 — Element targeting strategy

Status: Accepted (Phase 0)

## Context

The engine needs a way to (a) observe a page and (b) act on a specific
element from that observation, safely across re-renders. Two candidate
mechanisms were spiked against the local fixture in
[`spikes/03-element-targeting.ts`](../../spikes/03-element-targeting.ts),
using [`spikes/02-aria-snapshot.ts`](../../spikes/02-aria-snapshot.ts) as
the observation source.

Installed Playwright version: **1.62.1** (`playwright` and
`playwright-core`, verified via `node_modules/*/package.json`).

## APIs tested

1. `locator.ariaSnapshot({ mode: "ai" })` — public, documented API
   (present with a full doc comment in
   `node_modules/playwright-core/types/types.d.ts`). Produces a YAML-like
   tree with `role "accessible name" [ref=eN]` entries.
2. `page.locator("aria-ref=eN")` — a selector engine literally named
   `aria-ref` exists inside Playwright's injected/core bundle
   (`node_modules/playwright-core/lib/coreBundle.js` contains the string
   `"aria-ref selector"` and matches `aria-ref=`), but **it does not
   appear anywhere in `types.d.ts`** — there is no doc comment, no typed
   overload, no example referencing it in the public API surface. It is
   the same mechanism `@playwright/mcp` uses internally, not a
   documented Playwright Node API.
3. Semantic locators: `getByTestId`, `getByRole`, `getByLabel`,
   `getByPlaceholder`, `getByText` — all public, documented, typed APIs.

## Findings

- `mode: "ai"` is accepted and returns `[ref=eN]` markers, roles, and
  accessible names for every interactive element on the fixture
  (`textbox "Email" [ref=e6]`, `button "Login" [ref=e11]`, etc.). Two
  consecutive calls against an unchanged page produced structurally
  identical output (only irrelevant here — no ref churn was observed
  without a DOM change).
- `page.locator("aria-ref=e6")` **did resolve and act successfully**
  against a fresh snapshot (filled the Email field). So the mechanism
  works today on 1.62.1, but it is undocumented/internal — there is no
  semver guarantee it will keep working across Playwright versions.
- After triggering the fixture's rerender (which replaces the `#email`
  DOM node with a brand-new element), the **old** `aria-ref=e6` locator
  did **not** resolve: `locator.fill()` against it threw
  `TimeoutError: locator.fill: Timeout 1000ms exceeded.` There is no
  distinct "stale reference" error type — staleness manifests as the
  locator never matching anything and eventually timing out.
- Re-observing after the rerender produced a new snapshot with a new ref
  for the same logical element (`e6` → `e17`).
- All five semantic locators (`getByTestId`, `getByRole`, `getByLabel`,
  `getByPlaceholder`, `getByText`) resolved correctly, both before and
  immediately after the rerender, with no special handling needed — the
  element's role/name/testid/label/placeholder did not change even
  though the underlying DOM node did.

## Decision

**Primary targeting strategy: semantic locators**, resolved in priority
order `testId → role+name → label → placeholder` (implemented in
[`src/engine/target-resolver.ts`](../../src/engine/target-resolver.ts) and
validated by
[`src/schemas/action.ts`](../../src/schemas/action.ts)'s `SemanticTarget`
schema). `getByText` and a CSS-selector last resort are part of the
MVP-plan priority list but are out of scope for the Phase 0 minimal
target resolver and are deferred to Phase 1.

`aria-ref=eN` is **not** used anywhere in `src/` (shared production
code), per `AGENT.MD`'s rule against depending on undocumented Playwright
internals in shared code. It remains only in the Phase 0 spike as a
verified-but-rejected option. This ADR is the required verified-spike +
documented-decision + tested-fallback trail for that rule.

`ariaSnapshot({ mode: "ai" })` itself **is** used in the shared observer
(`src/engine/observer.ts`) — it is public, documented, and stable.

## Fallback strategy

If the primary semantic target does not resolve (element missing,
ambiguous, or a stale reference from an old snapshot was supplied), the
executor:

1. Rejects the action outright if its `snapshotId` does not match the
   session's current snapshot (schema/engine-level check, before ever
   touching the browser).
2. If a fresh-snapshot action still fails to resolve at the browser
   level (target removed by a rerender that happened between observe and
   act), the executor re-observes, resolves the same `SemanticTarget`
   against the new snapshot, and retries the action **exactly once**.
3. A second failure is returned to the caller as a typed action failure.
   It is not retried further and is not silently swallowed.

## Stale behavior

There is no dedicated "stale element" exception from Playwright for
either ref-based or semantic locators — both simply fail to match and
time out. The engine treats two situations as stale:

- **Snapshot-level staleness**: an incoming action's `snapshotId` does
  not match the session's current snapshot ID → rejected before any
  browser interaction (`STALE_SNAPSHOT`).
- **Runtime staleness**: the snapshot was current when the action was
  issued, but the page changed between observe and act (e.g. a rerender)
  → the browser-level locator call times out, which the executor
  interprets as a resolution failure and triggers the retry-once policy
  above.

## Retry policy

Exactly one retry, using a semantic re-resolution against a fresh
observation. No unlimited or exponential retry. This matches
`AGENT.MD`: "Stale target recovery may retry once using a semantic
locator. Repeated failure must be reported rather than hidden by
unlimited retry."

## Why coordinates are not the default

Coordinate-based clicks were not spiked at all in Phase 0 — this is a
deliberate scope decision, not an oversight. Rationale:

- Coordinates carry no identity. After a rerender or layout shift, a
  coordinate click can silently land on the wrong element with no error,
  whereas both `aria-ref` and semantic locators fail loudly (timeout)
  when the intended target is gone.
- Neither this ADR's spike nor the MVP plan found a case where semantic
  locators were insufficient to identify the fixture's interactive
  elements, so there is no demonstrated need to fall back further.
- `AGENT.MD` and `MVP_PLAN.MD` both specify coordinate actions as an
  explicit last resort, not a default.

## Known trade-offs

- Semantic locators depend on the target application having reasonably
  accessible markup (labels, roles, `data-testid`). A poorly-labeled app
  will produce ambiguous or non-matching locators; this is an accepted
  MVP limitation, not solved in Phase 0.
- `getByText` (deferred fallback) is fragile against copy or i18n
  changes; it sits last in priority for that reason.
- `aria-ref` is faster and unambiguous for the exact element the
  snapshot pointed at (no name/role duplication issues), but ties the
  engine to an internal API that Playwright could change or remove
  without a deprecation notice, since it is not part of the public
  contract. That risk is why it was rejected for production use despite
  working correctly in this spike.
