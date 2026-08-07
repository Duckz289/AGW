import { describe, expect, it } from "vitest";
import { ActionContext } from "../../src/engine/action-context.ts";

describe("ActionContext", () => {
  it("returns undefined before any action has begun", () => {
    const ctx = new ActionContext();
    expect(ctx.get()).toBeUndefined();
  });

  it("returns the active actionId after set()", () => {
    const ctx = new ActionContext();
    ctx.set("action-0001");
    expect(ctx.get()).toBe("action-0001");
  });

  it("returns undefined again after clear()", () => {
    const ctx = new ActionContext();
    ctx.set("action-0001");
    ctx.clear();
    expect(ctx.get()).toBeUndefined();
  });

  it("clears even when the caller's own work throws, when cleared in a finally", () => {
    const ctx = new ActionContext();
    ctx.set("action-0001");
    try {
      try {
        throw new Error("simulated action failure");
      } finally {
        ctx.clear();
      }
    } catch {
      // expected — this test is about the finally-clear, not the throw itself.
    }
    expect(ctx.get()).toBeUndefined();
  });
});
