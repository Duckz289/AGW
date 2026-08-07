import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixtureServer, type FixtureServerHandle } from "../../fixtures/server.ts";
import { BrowserSession } from "../../src/engine/browser-session.ts";

describe("verification engine", () => {
  let fixture: FixtureServerHandle;
  let session: BrowserSession;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    const started = await BrowserSession.start(fixture.url);
    session = started.session;
  });

  afterAll(async () => {
    await session.close();
    await fixture.close();
  });

  it("url_matches passes when the current URL contains the pattern", async () => {
    const result = await session.verify({ kind: "url_matches", pattern: "127.0.0.1" }, 1000);
    expect(result.passed).toBe(true);
    expect(result.kind).toBe("url_matches");
    expect(result.errorCode).toBeUndefined();
  });

  it("url_matches fails when the current URL does not contain the pattern", async () => {
    const result = await session.verify({ kind: "url_matches", pattern: "/dashboard" }, 300);
    expect(result.passed).toBe(false);
    expect(result.errorCode).toBe("url_mismatch");
  });

  it("element_visible passes for a heading that is present on the page", async () => {
    const result = await session.verify(
      { kind: "element_visible", role: "heading", name: "WebCheck Fixture" },
      1000
    );
    expect(result.passed).toBe(true);
  });

  it("element_visible fails for a heading that does not exist, without throwing", async () => {
    const result = await session.verify(
      { kind: "element_visible", role: "heading", name: "Nonexistent Heading" },
      300
    );
    expect(result.passed).toBe(false);
    expect(result.errorCode).toBe("verification_timeout");
  });

  it("element_hidden passes for an element that is not in the accessibility tree", async () => {
    // #error-message starts with the `hidden` attribute set, so it is not
    // exposed as an "alert" role at all — hidden or absent, per the
    // expectation's contract. The name filter never matches anything for a
    // role that is not in the accessibility tree in the first place.
    const result = await session.verify({ kind: "element_hidden", role: "alert", name: "Error" }, 300);
    expect(result.passed).toBe(true);
  });

  it("element_hidden fails for an element that is actually visible", async () => {
    const result = await session.verify(
      { kind: "element_hidden", role: "heading", name: "WebCheck Fixture" },
      300
    );
    expect(result.passed).toBe(false);
    expect(result.errorCode).toBe("verification_timeout");
  });

  it("text_present passes when the text is visible on the page", async () => {
    const result = await session.verify({ kind: "text_present", text: "WebCheck Fixture" }, 1000);
    expect(result.passed).toBe(true);
  });

  it("text_present fails when the text is not on the page, without throwing", async () => {
    const result = await session.verify(
      { kind: "text_present", text: "Definitely Not Present Anywhere" },
      300
    );
    expect(result.passed).toBe(false);
    expect(result.errorCode).toBe("verification_timeout");
  });
});
