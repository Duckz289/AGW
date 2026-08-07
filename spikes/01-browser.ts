import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
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

async function runSuccessScenario(): Promise<void> {
  let fixture: FixtureServerHandle | undefined;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;

  try {
    fixture = await startFixtureServer();
    record("fixture start", true, `listening on ${fixture.url}`);

    browser = await chromium.launch({ headless: true });
    record("chromium launch", true, `version ${browser.version()}`);

    context = await browser.newContext();
    page = await context.newPage();

    await page.goto(fixture.url);

    const heading = await page.locator("h1").first().textContent();
    const isExpectedHeading = heading === "WebCheck Fixture";
    record(
      "navigation + assertion",
      isExpectedHeading,
      `h1 textContent = "${heading}"`
    );

    await fs.mkdir(ARTIFACT_DIR, { recursive: true });
    const screenshotPath = path.join(ARTIFACT_DIR, "01-browser-success.png");
    await page.screenshot({ path: screenshotPath });
    const stat = await fs.stat(screenshotPath);
    record("screenshot", stat.size > 0, `${screenshotPath} (${stat.size} bytes)`);
  } finally {
    await page?.close().catch(() => undefined);
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await fixture?.close().catch(() => undefined);
    record("cleanup after success", true, "page/context/browser/fixture closed in finally");
  }
}

async function runFailureScenario(): Promise<void> {
  let fixture: FixtureServerHandle | undefined;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let cleanupRan = false;
  let threw = false;

  try {
    fixture = await startFixtureServer();
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    page = await context.newPage();
    await page.goto(fixture.url);

    // Deliberately fail: wait for an element that will never appear.
    await page.locator("#element-that-does-not-exist").waitFor({ timeout: 500 });
  } catch {
    threw = true;
  } finally {
    await page?.close().catch(() => undefined);
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await fixture?.close().catch(() => undefined);
    cleanupRan = true;
  }

  record(
    "cleanup after failure",
    threw && cleanupRan,
    `error thrown = ${threw}, cleanup ran = ${cleanupRan}`
  );
}

async function main(): Promise<void> {
  await runSuccessScenario();
  await runFailureScenario();

  const failed = results.filter((r) => !r.pass);
  console.log("\n=== Spike 1 summary ===");
  for (const r of results) {
    console.log(`${r.pass ? "PASS" : "FAIL"}: ${r.name}`);
  }
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

void main();
