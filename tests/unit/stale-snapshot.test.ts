import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixtureServer, type FixtureServerHandle } from "../../fixtures/server.ts";
import { BrowserSession, StaleSnapshotError } from "../../src/engine/browser-session.ts";

describe("stale snapshot rejection", () => {
  let fixture: FixtureServerHandle;
  let session: BrowserSession;
  let initialSnapshotId: string;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    const started = await BrowserSession.start(fixture.url);
    session = started.session;
    initialSnapshotId = started.snapshot.snapshotId;
  });

  afterAll(async () => {
    await session.close();
    await fixture.close();
  });

  it("rejects an action whose snapshotId no longer matches the session", async () => {
    // Advance the session's snapshot once so initialSnapshotId is now stale.
    await session.act({
      snapshotId: initialSnapshotId,
      type: "fill",
      target: { testId: "email-input" },
      value: "first@example.com",
      timeoutMs: 2000
    });

    await expect(
      session.act({
        snapshotId: initialSnapshotId,
        type: "fill",
        target: { testId: "email-input" },
        value: "should-be-rejected@example.com",
        timeoutMs: 2000
      })
    ).rejects.toThrow(StaleSnapshotError);
  });
});
