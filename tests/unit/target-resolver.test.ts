import { describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { resolveTarget, TargetResolutionError } from "../../src/engine/target-resolver.ts";

interface Call {
  method: string;
  args: unknown[];
}

function createFakePage(): { page: Page; calls: Call[] } {
  const calls: Call[] = [];
  const marker = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args });
    return { __locator: method };
  };

  const fake = {
    getByTestId: marker("getByTestId"),
    getByRole: marker("getByRole"),
    getByLabel: marker("getByLabel"),
    getByPlaceholder: marker("getByPlaceholder")
  };

  return { page: fake as unknown as Page, calls };
}

describe("resolveTarget priority", () => {
  it("prefers testId over role, label and placeholder", () => {
    const { page, calls } = createFakePage();
    resolveTarget(page, { testId: "email-input", role: "textbox", label: "Email", placeholder: "you@x.com" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("getByTestId");
    expect(calls[0]?.args[0]).toBe("email-input");
  });

  it("prefers role+name over label and placeholder when no testId is given", () => {
    const { page, calls } = createFakePage();
    resolveTarget(page, { role: "button", name: "Login", label: "Login button", placeholder: "unused" });
    expect(calls[0]?.method).toBe("getByRole");
    expect(calls[0]?.args).toEqual(["button", { name: "Login" }]);
  });

  it("prefers label over placeholder when no testId or role is given", () => {
    const { page, calls } = createFakePage();
    resolveTarget(page, { label: "Password", placeholder: "Enter your password" });
    expect(calls[0]?.method).toBe("getByLabel");
    expect(calls[0]?.args[0]).toBe("Password");
  });

  it("falls back to placeholder when nothing else is given", () => {
    const { page, calls } = createFakePage();
    resolveTarget(page, { placeholder: "Enter your password" });
    expect(calls[0]?.method).toBe("getByPlaceholder");
    expect(calls[0]?.args[0]).toBe("Enter your password");
  });

  it("throws TargetResolutionError for an empty target", () => {
    const { page } = createFakePage();
    expect(() => resolveTarget(page, {} as never)).toThrow(TargetResolutionError);
  });
});
