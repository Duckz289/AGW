import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chromium } from "playwright";
import { startFixtureServer, type FixtureServerHandle } from "../../fixtures/server.ts";
import { BrowserSession, StaleSnapshotError } from "../../src/engine/browser-session.ts";
import { summarizeElements } from "../../src/engine/observer.ts";

/**
 * The fixture's login handler updates the DOM only after its `fetch()`
 * promise resolves, asynchronously with respect to the click that
 * triggered it (see fixtures/public/app.js). BrowserSession.act() snapshots
 * immediately after the click resolves, with no built-in network-settle
 * wait (that is deferred to a later phase per MVP_PLAN.MD §10) — so
 * asserting on `clickLogin.snapshot` directly is a genuine, pre-existing
 * race. Poll like Phase 1A's verification engine does instead of coupling
 * this test to that timing.
 */
async function waitForAriaSnapshotToContain(
  session: BrowserSession,
  text: string,
  timeoutMs = 2000
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  for (;;) {
    const snapshot = await session.observeWithoutAdvancing();
    last = snapshot.ariaSnapshot;
    if (last.includes(text) || Date.now() >= deadline) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("fixture-driven browser flow", () => {
  let fixture: FixtureServerHandle;

  beforeEach(async () => {
    fixture = await startFixtureServer();
  });

  afterEach(async () => {
    await fixture.close();
  });

  it("opens the fixture and observes email/password/login elements", async () => {
    const { session, snapshot } = await BrowserSession.start(fixture.url);
    try {
      expect(snapshot.title).toBe("WebCheck Fixture");

      const elements = summarizeElements(snapshot.ariaSnapshot);
      expect(elements.some((e) => e.role === "textbox" && e.name === "Email")).toBe(true);
      expect(elements.some((e) => e.role === "textbox" && e.name === "Password")).toBe(true);
      expect(elements.some((e) => e.role === "button" && e.name === "Login")).toBe(true);
    } finally {
      await session.close();
    }
  });

  it("fills email, fills password, clicks login, and reaches the dashboard", async () => {
    const { session, snapshot } = await BrowserSession.start(fixture.url);
    try {
      const fillEmail = await session.act({
        snapshotId: snapshot.snapshotId,
        type: "fill",
        target: { testId: "email-input" },
        value: "user@example.com",
        timeoutMs: 2000
      });
      expect(fillEmail.result.ok).toBe(true);

      const fillPassword = await session.act({
        snapshotId: fillEmail.snapshot.snapshotId,
        type: "fill",
        target: { label: "Password" },
        value: "hunter2",
        timeoutMs: 2000
      });
      expect(fillPassword.result.ok).toBe(true);

      const clickLogin = await session.act({
        snapshotId: fillPassword.snapshot.snapshotId,
        type: "click",
        target: { role: "button", name: "Login" },
        timeoutMs: 2000
      });
      expect(clickLogin.result.ok).toBe(true);
      const finalAriaSnapshot = await waitForAriaSnapshotToContain(session, "Dashboard");
      expect(finalAriaSnapshot).toContain("Dashboard");
    } finally {
      await session.close();
    }
  });

  it("invalidates the old snapshot after a rerender and allows a fresh action once re-observed", async () => {
    const { session, snapshot } = await BrowserSession.start(fixture.url);
    try {
      const preRerenderSnapshotId = snapshot.snapshotId;

      const rerenderOutcome = await session.act({
        snapshotId: preRerenderSnapshotId,
        type: "click",
        target: { testId: "rerender-button" },
        timeoutMs: 2000
      });
      expect(rerenderOutcome.result.ok).toBe(true);
      expect(rerenderOutcome.snapshot.snapshotId).not.toBe(preRerenderSnapshotId);

      // Reusing the pre-rerender snapshotId must be rejected as stale.
      await expect(
        session.act({
          snapshotId: preRerenderSnapshotId,
          type: "fill",
          target: { testId: "email-input" },
          value: "stale@example.com",
          timeoutMs: 2000
        })
      ).rejects.toThrow(StaleSnapshotError);

      // A new observation allows a further action to proceed normally.
      const freshFill = await session.act({
        snapshotId: rerenderOutcome.snapshot.snapshotId,
        type: "fill",
        target: { testId: "email-input" },
        value: "fresh@example.com",
        timeoutMs: 2000
      });
      expect(freshFill.result.ok).toBe(true);
    } finally {
      await session.close();
    }
  });

  it("cleans up browser resources after a successful run", async () => {
    const { session } = await BrowserSession.start(fixture.url);
    await expect(session.close()).resolves.toBeUndefined();
  });

  it("cleans up browser resources after a controlled failure", async () => {
    const browser = await chromium.launch({ headless: true });
    let cleanupRan = false;
    let threw = false;

    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        await page.goto(fixture.url);
        await page.locator("#element-that-does-not-exist").waitFor({ timeout: 300 });
      } catch {
        threw = true;
      } finally {
        await page.close();
        await context.close();
        cleanupRan = true;
      }
    } finally {
      await browser.close();
    }

    expect(threw).toBe(true);
    expect(cleanupRan).toBe(true);
  });
});
