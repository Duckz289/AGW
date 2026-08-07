import { randomUUID } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { attachConsoleCollector } from "../collectors/console.ts";
import { attachNetworkCollector } from "../collectors/network.ts";
import { attachPageErrorCollector } from "../collectors/page-error.ts";
import type { BrowserAction } from "../schemas/action.ts";
import type { Expectation } from "../schemas/flow.ts";
import type { TimelineStore } from "../timeline/store.ts";
import { ActionContext } from "./action-context.ts";
import { type ActionResult, executeAction } from "./action-executor.ts";
import { observe, type PageSnapshot } from "./observer.ts";
import { assertUrlPolicy } from "./url-policy.ts";
import { verify, type VerificationResult } from "./verification.ts";

export class StaleSnapshotError extends Error {
  constructor(expectedSnapshotId: string, actualSnapshotId: string) {
    super(
      `stale snapshot: action targeted snapshot "${expectedSnapshotId}" but the current session snapshot is "${actualSnapshotId}"`
    );
    this.name = "StaleSnapshotError";
  }
}

export interface ActOutcome {
  result: ActionResult;
  snapshot: PageSnapshot;
  retried: boolean;
}

export interface BrowserSessionStartOptions {
  headless?: boolean;
  /**
   * When provided, wires the console/runtime-error/network collectors
   * against the session's page (before the initial navigation, so no
   * early events are missed) and correlates their events with whichever
   * actionId is currently active (see beginAction/endAction below).
   * Omitted by every existing Phase 0/1A caller and by MCP in this
   * milestone — session behavior is completely unchanged when no
   * timeline is supplied.
   */
  timeline?: TimelineStore;
}

/**
 * Owns exactly one active browser (one context, one page) per session, per
 * MVP_PLAN.MD §6.2. This is the minimal shared core: session id
 * generation, lifecycle, snapshot versioning, observation, one action at a
 * time, stale-snapshot rejection, and cleanup. Checkers, timeline
 * persistence and reporting are out of scope for Phase 0.
 */
export class BrowserSession {
  readonly sessionId: string;
  readonly startUrl: string;

  private readonly browser: Browser;
  private readonly context: BrowserContext;
  private readonly page: Page;
  private snapshotSeq = 0;
  private latestSnapshotId: string;
  private actionSeq = 0;
  private readonly actionContext = new ActionContext();

  private constructor(
    sessionId: string,
    startUrl: string,
    browser: Browser,
    context: BrowserContext,
    page: Page,
    initialSnapshotId: string
  ) {
    this.sessionId = sessionId;
    this.startUrl = startUrl;
    this.browser = browser;
    this.context = context;
    this.page = page;
    this.latestSnapshotId = initialSnapshotId;
  }

  static async start(
    url: string,
    options: BrowserSessionStartOptions = {}
  ): Promise<{ session: BrowserSession; snapshot: PageSnapshot }> {
    assertUrlPolicy(url);

    const sessionId = randomUUID();
    const browser = await chromium.launch({ headless: options.headless ?? true });

    let context: BrowserContext | undefined;
    let page: Page | undefined;
    try {
      context = await browser.newContext();
      page = await context.newPage();

      const initialSnapshotId = `${sessionId}-0`;
      const session = new BrowserSession(sessionId, url, browser, context, page, initialSnapshotId);

      // Collectors are wired before goto() (not after) so nothing emitted
      // during the very first navigation — an initial console.log, the
      // top-level document request/response — is missed.
      if (options.timeline) {
        const timeline = options.timeline;
        const getActionId = (): string | undefined => session.actionContext.get();
        attachConsoleCollector(page, timeline, { getActionId });
        attachPageErrorCollector(page, timeline, { getActionId });
        attachNetworkCollector(page, timeline, { getActionId });
      }

      await page.goto(url);

      const snapshot = await observe(page, initialSnapshotId);
      return { session, snapshot };
    } catch (err) {
      await page?.close().catch(() => undefined);
      await context?.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
      throw err;
    }
  }

  get currentSnapshotId(): string {
    return this.latestSnapshotId;
  }

  private async observeCurrent(): Promise<PageSnapshot> {
    this.snapshotSeq += 1;
    this.latestSnapshotId = `${this.sessionId}-${this.snapshotSeq}`;
    return observe(this.page, this.latestSnapshotId);
  }

  async observeWithoutAdvancing(): Promise<PageSnapshot> {
    return observe(this.page, this.latestSnapshotId);
  }

  /**
   * Executes one BrowserAction. Rejects immediately if the action's
   * snapshotId does not match the session's current snapshot. On a
   * resolution/timeout failure that could be caused by a mid-flight
   * rerender, re-observes and retries the same semantic target exactly
   * once, per docs/decisions/0001-element-targeting.md.
   */
  async act(action: BrowserAction): Promise<ActOutcome> {
    if (action.snapshotId !== this.latestSnapshotId) {
      throw new StaleSnapshotError(action.snapshotId, this.latestSnapshotId);
    }

    let result = await executeAction(this.page, action);
    let retried = false;

    const isRetryable =
      !result.ok && (result.failureKind === "target_not_found" || result.failureKind === "action_timeout");

    if (isRetryable) {
      retried = true;
      await this.observeCurrent();
      result = await executeAction(this.page, action);
    }

    const snapshot = await this.observeCurrent();
    return { result, snapshot, retried };
  }

  /**
   * Checks a typed Expectation against the current live page state. Unlike
   * act(), this does not mutate the page and does not advance the session's
   * snapshot — it is a read-only check, so there is no ref/snapshotId to go
   * stale (src/engine/verification.ts resolves the target fresh on every
   * call).
   */
  async verify(expectation: Expectation, timeoutMs: number): Promise<VerificationResult> {
    return verify(this.page, expectation, timeoutMs);
  }

  /** Sequential, human-readable, run-scoped action id (`action-0001`, `action-0002`, ...). */
  nextActionId(): string {
    this.actionSeq += 1;
    return `action-${String(this.actionSeq).padStart(4, "0")}`;
  }

  /** Marks `actionId` as the currently-active action; collectors read this to correlate the events they observe. */
  beginAction(actionId: string): void {
    this.actionContext.set(actionId);
  }

  /** Clears the currently-active action. Callers must call this in a `finally`, even on failure, so a failed action's id is never left active and accidentally attached to later unrelated events. */
  endAction(): void {
    this.actionContext.clear();
  }

  /** Captures a PNG screenshot of the current page to `filePath`. */
  async screenshot(filePath: string): Promise<void> {
    await this.page.screenshot({ path: filePath });
  }

  /**
   * Best-effort wait for the page's network activity to settle, so
   * console/network events already in flight at the CDP layer have a
   * chance to reach the collectors' listeners before the caller proceeds
   * to close the session (closing the browser transport mid-flight can
   * silently drop events that Playwright had not yet dispatched to
   * `page.on(...)` — an observed, reproduced evidence gap, not a
   * hypothetical one; see CURRENT_TASK.md "Evidence limitations").
   * Never throws: a timeout here just means we proceeded without waiting
   * further, which is always safe — it only trades a little latency for
   * more complete evidence, never correctness.
   */
  async waitForNetworkSettle(timeoutMs = 1000): Promise<void> {
    await this.page.waitForLoadState("networkidle", { timeout: timeoutMs }).catch(() => undefined);
  }

  async close(): Promise<void> {
    await this.page.close().catch(() => undefined);
    await this.context.close().catch(() => undefined);
    await this.browser.close().catch(() => undefined);
  }
}
