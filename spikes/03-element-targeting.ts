import { chromium, type Page } from "playwright";
import { startFixtureServer, type FixtureServerHandle } from "../fixtures/server.ts";

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

function extractRef(snapshot: string, matcher: RegExp): string | undefined {
  for (const line of snapshot.split("\n")) {
    if (matcher.test(line)) {
      const refMatch = /\[ref=(e\d+)\]/.exec(line);
      if (refMatch?.[1]) return refMatch[1];
    }
  }
  return undefined;
}

/**
 * Part A: aria-ref locator + full login flow using semantic locators.
 */
async function runLoginFlow(page: Page, fixtureUrl: string): Promise<void> {
  await page.goto(fixtureUrl);

  const snapshot = await page.locator("body").ariaSnapshot({ mode: "ai" });
  record("observe: initial snapshot captured", snapshot.length > 0, `${snapshot.length} chars`);

  const emailRef = extractRef(snapshot, /textbox "Email"/);
  record("aria-ref: extracted ref for Email textbox", emailRef !== undefined, `ref=${emailRef}`);

  if (emailRef) {
    try {
      const locatorByRef = page.locator(`aria-ref=${emailRef}`);
      await locatorByRef.fill("ref-user@example.com", { timeout: 2000 });
      const value = await page.locator("#email").inputValue();
      record(
        "aria-ref: page.locator('aria-ref=eN') resolves and fills",
        value === "ref-user@example.com",
        `filled value = "${value}"`
      );
    } catch (err) {
      record("aria-ref: page.locator('aria-ref=eN') resolves and fills", false, String(err));
    }
  }

  // Reset and drive the required flow through documented semantic locators only.
  await page.locator("#email").fill("");
  await page.getByTestId("email-input").fill("user@example.com");
  await page.getByLabel("Password").fill("hunter2");
  await page.getByRole("button", { name: "Login" }).click();

  const dashboardHeading = page.getByRole("heading", { name: "Dashboard" });
  try {
    await dashboardHeading.waitFor({ state: "visible", timeout: 3000 });
    record("semantic flow: fill+fill+click+verify Dashboard", true, "Dashboard heading visible");
  } catch (err) {
    record("semantic flow: fill+fill+click+verify Dashboard", false, String(err));
  }
}

/**
 * Part B: rerender / staleness behavior and the retry-once fallback.
 */
async function runRerenderStalenessFlow(page: Page, fixtureUrl: string): Promise<void> {
  await page.goto(fixtureUrl);

  const snapshotBefore = await page.locator("body").ariaSnapshot({ mode: "ai" });
  const emailRefBefore = extractRef(snapshotBefore, /textbox "Email"/);
  record(
    "rerender: captured pre-rerender snapshot + target ref",
    emailRefBefore !== undefined,
    `snapshotId(informal)=pre-rerender ref=${emailRefBefore}`
  );

  // Trigger the fixture rerender: replaces the #email DOM node with a new element.
  await page.getByTestId("rerender-button").click();

  let staleRejected = false;
  let staleError = "";
  if (emailRefBefore) {
    try {
      await page.locator(`aria-ref=${emailRefBefore}`).fill("should-not-work", { timeout: 1000 });
    } catch (err) {
      staleRejected = true;
      staleError = String(err);
    }
  }
  record(
    "rerender: old ref rejected as stale after DOM replacement",
    staleRejected,
    staleRejected ? staleError.split("\n")[0] ?? "" : "old ref unexpectedly still resolved"
  );

  // Re-observe: the snapshot is invalidated, so a fresh one is required.
  const snapshotAfter = await page.locator("body").ariaSnapshot({ mode: "ai" });
  const emailRefAfter = extractRef(snapshotAfter, /textbox "Email"/);
  record(
    "rerender: re-observe produces a new snapshot/ref",
    emailRefAfter !== undefined && emailRefAfter !== emailRefBefore,
    `newRef=${emailRefAfter} (old was ${emailRefBefore})`
  );

  // Resolve semantically instead of trusting the stale ref, retry exactly once.
  let retrySucceeded = false;
  let lastError = "";
  const maxAttempts = 2; // initial attempt + exactly one retry
  for (let attempt = 1; attempt <= maxAttempts && !retrySucceeded; attempt++) {
    try {
      await page.getByTestId("email-input").fill("after-rerender@example.com", { timeout: 2000 });
      const value = await page.locator("#email").inputValue();
      retrySucceeded = value === "after-rerender@example.com";
    } catch (err) {
      lastError = String(err);
    }
  }
  record(
    "rerender: semantic fallback resolves target and retry-once succeeds",
    retrySucceeded,
    retrySucceeded ? "getByTestId resolved post-rerender element" : lastError
  );
}

async function testSemanticLocatorFamily(page: Page, fixtureUrl: string): Promise<void> {
  await page.goto(fixtureUrl);

  const byTestId = await page.getByTestId("login-button").isVisible();
  const byRole = await page.getByRole("button", { name: "Login" }).isVisible();
  const byLabel = await page.getByLabel("Email").isVisible();
  const byPlaceholder = await page.getByPlaceholder("Enter your password").isVisible();
  const byText = await page.getByText("Trigger console error").isVisible();

  record("semantic: getByTestId resolves", byTestId, "login-button");
  record("semantic: getByRole resolves", byRole, 'button "Login"');
  record("semantic: getByLabel resolves", byLabel, "Email");
  record("semantic: getByPlaceholder resolves", byPlaceholder, "Enter your password");
  record("semantic: getByText resolves", byText, "Trigger console error");
}

async function main(): Promise<void> {
  let fixture: FixtureServerHandle | undefined;
  const browser = await chromium.launch({ headless: true });
  try {
    fixture = await startFixtureServer();
    const context = await browser.newContext();

    const page1 = await context.newPage();
    await runLoginFlow(page1, fixture.url);
    await page1.close();

    const page2 = await context.newPage();
    await runRerenderStalenessFlow(page2, fixture.url);
    await page2.close();

    const page3 = await context.newPage();
    await testSemanticLocatorFamily(page3, fixture.url);
    await page3.close();

    await context.close();
  } finally {
    await browser.close();
    await fixture?.close();
  }

  console.log("\n=== Spike 3 summary ===");
  for (const r of results) {
    console.log(`${r.pass ? "PASS" : "FAIL"}: ${r.name}`);
  }
  if (results.some((r) => !r.pass)) {
    process.exitCode = 1;
  }
}

void main();
