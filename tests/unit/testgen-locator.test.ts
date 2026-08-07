import { describe, expect, it } from "vitest";
import { resolveLocatorPlan } from "../../src/testgen/locator.ts";

describe("resolveLocatorPlan", () => {
  it("5. prefers testId over every other field", () => {
    const plan = resolveLocatorPlan({ testId: "login-button", role: "button", name: "Login", label: "x", placeholder: "y" });
    expect(plan).toEqual({ kind: "testId", code: 'page.getByTestId("login-button")' });
  });

  it("prefers role+name over label/placeholder when testId is absent", () => {
    const plan = resolveLocatorPlan({ role: "button", name: "Login", label: "x", placeholder: "y" });
    expect(plan).toEqual({ kind: "role", code: 'page.getByRole("button", { name: "Login" })' });
  });

  it("prefers label over placeholder when testId/role+name are absent", () => {
    const plan = resolveLocatorPlan({ label: "Email", placeholder: "you@example.com" });
    expect(plan).toEqual({ kind: "label", code: 'page.getByLabel("Email")' });
  });

  it("falls back to placeholder when nothing else is present", () => {
    const plan = resolveLocatorPlan({ placeholder: "you@example.com" });
    expect(plan).toEqual({ kind: "placeholder", code: 'page.getByPlaceholder("you@example.com")' });
  });

  it("treats role without name as absent and falls through to label", () => {
    const plan = resolveLocatorPlan({ role: "button", label: "Submit" });
    expect(plan).toEqual({ kind: "label", code: 'page.getByLabel("Submit")' });
  });

  it("7. returns undefined when no usable semantic field is present", () => {
    const plan = resolveLocatorPlan({ role: "button" });
    expect(plan).toBeUndefined();
  });

  it("6. never generates a coordinate-based or CSS-selector locator", () => {
    const plan = resolveLocatorPlan({ testId: "x" });
    expect(plan?.code).not.toMatch(/page\.mouse|page\.click\(\s*\d/);
    expect(plan?.code).not.toContain("page.locator(");
  });

  it("safely escapes quotes and special characters via JSON.stringify", () => {
    const plan = resolveLocatorPlan({ testId: 'weird"name\nwith\\backslash' });
    expect(plan?.code).toBe('page.getByTestId("weird\\"name\\nwith\\\\backslash")');
  });
});
