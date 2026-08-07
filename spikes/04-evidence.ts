import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { startFixtureServer, type FixtureServerHandle } from "../fixtures/server.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT_DIR = path.join(__dirname, "..", "phase0-artifacts");

interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

const results: CheckResult[] = [];

function record(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name} — ${detail}`);
}

type ConsoleEvent = { kind: "console"; level: string; text: string };
type PageErrorEvent = { kind: "pageerror"; message: string };
type RequestEvent = { kind: "request"; method: string; url: string; startedAtMs: number };
type ResponseEvent = {
  kind: "response";
  method: string;
  url: string;
  status: number;
  durationMs?: number;
};
type RequestFailedEvent = {
  kind: "requestfailed";
  method: string;
  url: string;
  failureText: string;
};
type RequestFinishedEvent = {
  kind: "requestfinished";
  method: string;
  url: string;
  status?: number;
  durationMs?: number;
};

type EvidenceEvent =
  | ConsoleEvent
  | PageErrorEvent
  | RequestEvent
  | ResponseEvent
  | RequestFailedEvent
  | RequestFinishedEvent;

function attachCollectors(page: Page, sink: EvidenceEvent[]): void {
  const statusByUrl = new Map<string, number>();

  page.on("console", (msg) => {
    sink.push({ kind: "console", level: msg.type(), text: msg.text() });
  });

  page.on("pageerror", (err) => {
    sink.push({ kind: "pageerror", message: err.message });
  });

  page.on("request", (req) => {
    sink.push({ kind: "request", method: req.method(), url: req.url(), startedAtMs: Date.now() });
  });

  page.on("response", (res) => {
    // Note (Phase 0 finding): timing().responseEnd is NOT yet populated at
    // 'response' time — it only becomes available once the request fully
    // finishes. Duration is therefore recorded from 'requestfinished', not
    // here. See docs/decisions/0001-element-targeting.md sibling note in
    // phase0-artifacts/04-evidence-findings.md.
    statusByUrl.set(res.url(), res.status());
    sink.push({
      kind: "response",
      method: res.request().method(),
      url: res.url(),
      status: res.status()
    });
  });

  page.on("requestfinished", (req) => {
    let durationMs: number | undefined;
    try {
      const timing = req.timing();
      if (timing.responseEnd >= 0) {
        durationMs = timing.responseEnd;
      }
    } catch {
      durationMs = undefined;
    }
    const status = statusByUrl.get(req.url());
    sink.push({
      kind: "requestfinished",
      method: req.method(),
      url: req.url(),
      ...(status !== undefined ? { status } : {}),
      ...(durationMs !== undefined ? { durationMs } : {})
    });
  });

  page.on("requestfailed", (req) => {
    sink.push({
      kind: "requestfailed",
      method: req.method(),
      url: req.url(),
      failureText: req.failure()?.errorText ?? "unknown"
    });
  });
}

async function runEvidenceScenarios(page: Page, fixtureUrl: string, events: EvidenceEvent[]): Promise<void> {
  // 1. Successful request — the initial navigation itself.
  await page.goto(fixtureUrl);

  // 2. HTTP 500 response — submit login with the force-error checkbox checked.
  await page.getByTestId("email-input").fill("user@example.com");
  await page.getByLabel("Password").fill("hunter2");
  await page.getByTestId("force-error-checkbox").check();
  await Promise.all([
    page.waitForResponse((res) => res.url().endsWith("/api/login"), { timeout: 5000 }),
    page.getByRole("button", { name: "Login" }).click()
  ]);

  // 3. Controlled transport failure — no internet access involved, the
  // fixture server destroys the raw socket for this route.
  try {
    await page.getByTestId("transport-fail-button").click();
    await page.waitForTimeout(300);
  } catch {
    // ignored — evidence is captured via the requestfailed listener
  }

  // 4. console.error event.
  await page.getByTestId("console-error-button").click();

  // 5. Uncaught runtime exception.
  await page.getByTestId("throw-error-button").click();
  await page.waitForTimeout(200);
}

async function captureTrace(fixture: FixtureServerHandle): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.tracing.start({ screenshots: true, snapshots: true });

    const page = await context.newPage();
    await page.goto(fixture.url);
    await page.getByTestId("email-input").fill("trace-user@example.com");
    await page.getByLabel("Password").fill("trace-password");
    await page.getByRole("button", { name: "Login" }).click();
    await page.getByRole("heading", { name: "Dashboard" }).waitFor({ state: "visible", timeout: 3000 });

    await fs.mkdir(ARTIFACT_DIR, { recursive: true });
    const tracePath = path.join(ARTIFACT_DIR, "04-trace.zip");
    await context.tracing.stop({ path: tracePath });

    const stat = await fs.stat(tracePath);
    record("trace: non-empty zip generated", stat.size > 0, `${tracePath} (${stat.size} bytes)`);
    console.log(`Open the trace with: npx playwright show-trace "${tracePath}"`);

    await page.close();
    await context.close();
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  const events: EvidenceEvent[] = [];

  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    attachCollectors(page, events);

    await runEvidenceScenarios(page, fixture.url, events);

    await page.close();
    await context.close();
  } finally {
    await browser.close();
  }

  await fs.mkdir(ARTIFACT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(ARTIFACT_DIR, "04-evidence-events.json"),
    JSON.stringify(events, null, 2),
    "utf-8"
  );

  // --- Assertions -----------------------------------------------------

  const loginResponses = events.filter(
    (e): e is ResponseEvent => e.kind === "response" && e.url.endsWith("/api/login")
  );
  const login500 = loginResponses.find((e) => e.status === 500);
  record(
    "HTTP 500 produces a normal response event",
    login500 !== undefined,
    login500 ? `status=${login500.status} url=${login500.url}` : "no 500 response event found"
  );

  const loginRequestFailed = events.some(
    (e) => e.kind === "requestfailed" && e.url.endsWith("/api/login")
  );
  record(
    "HTTP 500 is NOT reported as requestfailed",
    login500 !== undefined && !loginRequestFailed,
    `requestfailed for /api/login present = ${loginRequestFailed}`
  );

  const transportFailure = events.find(
    (e): e is RequestFailedEvent => e.kind === "requestfailed" && e.url.endsWith("/api/transport-fail")
  );
  record(
    "controlled transport failure produces requestfailed",
    transportFailure !== undefined,
    transportFailure ? `failureText="${transportFailure.failureText}"` : "no requestfailed event found"
  );

  const transportFailureHadResponse = events.some(
    (e) => e.kind === "response" && e.url.endsWith("/api/transport-fail")
  );
  record(
    "transport failure did NOT produce a response event",
    !transportFailureHadResponse,
    `response for /api/transport-fail present = ${transportFailureHadResponse}`
  );

  const consoleErrors = events.filter((e): e is ConsoleEvent => e.kind === "console" && e.level === "error");
  const pageErrors = events.filter((e): e is PageErrorEvent => e.kind === "pageerror");
  record(
    "console.error and pageerror are captured as separate categories",
    consoleErrors.length > 0 && pageErrors.length > 0,
    `console.error count=${consoleErrors.length}, pageerror count=${pageErrors.length}`
  );
  record(
    "pageerror text does not appear duplicated in console-error text",
    !consoleErrors.some((c) => pageErrors.some((p) => c.text.includes(p.message))),
    "checked for cross-contamination between the two categories"
  );

  const successFinished = events.find(
    (e): e is RequestFinishedEvent => e.kind === "requestfinished" && e.status === 200 && e.durationMs !== undefined
  );
  record(
    "method, URL, status and timing recorded for a successful request",
    successFinished !== undefined,
    successFinished
      ? `method=${successFinished.method} url=${successFinished.url} status=${successFinished.status} durationMs=${successFinished.durationMs}`
      : "no requestfinished event with status+timing captured"
  );

  const kinds = new Set(events.map((e) => e.kind));
  record(
    "failures are not flattened into one generic category",
    kinds.has("response") && kinds.has("requestfailed") && kinds.has("console") && kinds.has("pageerror"),
    `distinct event kinds observed: ${[...kinds].join(", ")}`
  );

  await captureTrace(fixture);
  await fixture.close();

  console.log("\n=== Spike 4 summary ===");
  for (const r of results) {
    console.log(`${r.pass ? "PASS" : "FAIL"}: ${r.name}`);
  }
  if (results.some((r) => !r.pass)) {
    process.exitCode = 1;
  }
}

void main();
