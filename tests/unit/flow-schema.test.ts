import { describe, expect, it } from "vitest";
import { ExpectationSchema, FlowStepSchema, ScriptedFlowSchema } from "../../src/schemas/flow.ts";

describe("ScriptedFlowSchema", () => {
  it("accepts a valid flow", () => {
    const result = ScriptedFlowSchema.safeParse({
      name: "fixture-login-success",
      startUrl: "http://127.0.0.1:4300",
      steps: [
        { type: "fill", target: { label: "Email" }, value: "test@example.com" },
        { type: "fill", target: { label: "Password" }, value: "correct-password" },
        { type: "click", target: { role: "button", name: "Login" } },
        { type: "expect", expected: { kind: "url_matches", pattern: "127.0.0.1:4300" } },
        { type: "expect", expected: { kind: "element_visible", role: "heading", name: "Dashboard" } }
      ]
    });
    expect(result.success).toBe(true);
  });

  it("requires at least one step", () => {
    const result = ScriptedFlowSchema.safeParse({
      name: "empty-flow",
      startUrl: "http://127.0.0.1:4300",
      steps: []
    });
    expect(result.success).toBe(false);
  });
});

describe("FlowStepSchema", () => {
  it("rejects an unknown step type", () => {
    const result = FlowStepSchema.safeParse({
      type: "select",
      target: { role: "combobox", name: "Country" },
      value: "US"
    });
    expect(result.success).toBe(false);
  });

  it("rejects a fill step missing a target", () => {
    const result = FlowStepSchema.safeParse({ type: "fill", value: "test@example.com" });
    expect(result.success).toBe(false);
  });

  it("rejects a fill step missing a value", () => {
    const result = FlowStepSchema.safeParse({ type: "fill", target: { label: "Email" } });
    expect(result.success).toBe(false);
  });

  it("accepts a valid fill step", () => {
    const result = FlowStepSchema.safeParse({
      type: "fill",
      target: { label: "Email" },
      value: "test@example.com"
    });
    expect(result.success).toBe(true);
  });

  it("rejects a click step missing a target", () => {
    const result = FlowStepSchema.safeParse({ type: "click" });
    expect(result.success).toBe(false);
  });

  it("accepts a valid click step", () => {
    const result = FlowStepSchema.safeParse({ type: "click", target: { role: "button", name: "Login" } });
    expect(result.success).toBe(true);
  });

  it("rejects an expect step missing an expectation", () => {
    const result = FlowStepSchema.safeParse({ type: "expect" });
    expect(result.success).toBe(false);
  });

  it("accepts a valid expect step", () => {
    const result = FlowStepSchema.safeParse({
      type: "expect",
      expected: { kind: "text_present", text: "Dashboard" }
    });
    expect(result.success).toBe(true);
  });

  it("rejects a navigate step missing a url", () => {
    const result = FlowStepSchema.safeParse({ type: "navigate" });
    expect(result.success).toBe(false);
  });
});

describe("ExpectationSchema", () => {
  it("rejects an unknown expectation kind", () => {
    const result = ExpectationSchema.safeParse({ kind: "network_response", urlPattern: "/api" });
    expect(result.success).toBe(false);
  });

  it("accepts all four supported expectation kinds", () => {
    expect(ExpectationSchema.safeParse({ kind: "url_matches", pattern: "/dashboard" }).success).toBe(true);
    expect(
      ExpectationSchema.safeParse({ kind: "element_visible", role: "heading", name: "Dashboard" }).success
    ).toBe(true);
    expect(
      ExpectationSchema.safeParse({ kind: "element_hidden", role: "alert", name: "Error" }).success
    ).toBe(true);
    expect(ExpectationSchema.safeParse({ kind: "text_present", text: "You are logged in" }).success).toBe(true);
  });
});
