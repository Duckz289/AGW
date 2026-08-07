import { describe, expect, it } from "vitest";
import { ActInputSchema, BrowserActionSchema, SemanticTargetSchema } from "../../src/schemas/action.ts";

describe("SemanticTargetSchema", () => {
  it("requires at least one field", () => {
    expect(SemanticTargetSchema.safeParse({}).success).toBe(false);
    expect(SemanticTargetSchema.safeParse({ testId: "x" }).success).toBe(true);
  });
});

describe("BrowserActionSchema", () => {
  it("accepts a valid click with a target", () => {
    const result = BrowserActionSchema.safeParse({
      snapshotId: "s-0",
      type: "click",
      target: { role: "button", name: "Login" },
      timeoutMs: 1000
    });
    expect(result.success).toBe(true);
  });

  it("rejects click missing both target and url", () => {
    const result = BrowserActionSchema.safeParse({
      snapshotId: "s-0",
      type: "click",
      timeoutMs: 1000
    });
    expect(result.success).toBe(false);
  });

  it("rejects fill missing a target", () => {
    const result = BrowserActionSchema.safeParse({
      snapshotId: "s-0",
      type: "fill",
      value: "hello",
      timeoutMs: 1000
    });
    expect(result.success).toBe(false);
  });

  it("rejects fill missing a value", () => {
    const result = BrowserActionSchema.safeParse({
      snapshotId: "s-0",
      type: "fill",
      target: { testId: "email-input" },
      timeoutMs: 1000
    });
    expect(result.success).toBe(false);
  });

  it("accepts a valid fill with target and value", () => {
    const result = BrowserActionSchema.safeParse({
      snapshotId: "s-0",
      type: "fill",
      target: { testId: "email-input" },
      value: "user@example.com",
      timeoutMs: 1000
    });
    expect(result.success).toBe(true);
  });

  it("rejects navigate missing a url", () => {
    const result = BrowserActionSchema.safeParse({
      snapshotId: "s-0",
      type: "navigate",
      timeoutMs: 1000
    });
    expect(result.success).toBe(false);
  });

  it("accepts a valid navigate with a url", () => {
    const result = BrowserActionSchema.safeParse({
      snapshotId: "s-0",
      type: "navigate",
      url: "http://localhost:3000",
      timeoutMs: 1000
    });
    expect(result.success).toBe(true);
  });

  it("defaults timeoutMs when omitted", () => {
    const result = BrowserActionSchema.safeParse({
      snapshotId: "s-0",
      type: "navigate",
      url: "http://localhost:3000"
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.timeoutMs).toBe(5000);
  });
});

describe("ActInputSchema", () => {
  it("requires the top-level snapshotId to match action.snapshotId", () => {
    const result = ActInputSchema.safeParse({
      sessionId: "session-1",
      snapshotId: "s-0",
      action: {
        snapshotId: "s-1",
        type: "navigate",
        url: "http://localhost:3000"
      }
    });
    expect(result.success).toBe(false);
  });

  it("accepts matching snapshotIds", () => {
    const result = ActInputSchema.safeParse({
      sessionId: "session-1",
      snapshotId: "s-0",
      action: {
        snapshotId: "s-0",
        type: "navigate",
        url: "http://localhost:3000"
      }
    });
    expect(result.success).toBe(true);
  });
});
