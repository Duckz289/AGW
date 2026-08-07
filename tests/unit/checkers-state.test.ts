import { describe, expect, it } from "vitest";
import { checkInfiniteLoading } from "../../src/checkers/state.ts";
import { ev } from "../helpers/synthetic-events.ts";

const LOADING = { role: "status", name: "Loading" };

describe("ST-INFINITE-LOADING", () => {
  it("does nothing without explicit config", () => {
    const events = [
      ev(1, "verification", { passed: true, kind: "element_visible", elapsedMs: 5, observed: 'element with role "status" and name "Loading" is visible' }),
      ev(2, "verification", { passed: false, kind: "element_visible", elapsedMs: 500, observed: 'element with role "heading" and name "Dashboard" did not become visible within 500ms' })
    ];
    expect(checkInfiniteLoading({ events })).toHaveLength(0);
    expect(checkInfiniteLoading({ events }, {})).toHaveLength(0);
  });

  it("triggers confirmed when the configured loading indicator is shown and the next verification fails", () => {
    const events = [
      ev(1, "verification", { passed: true, kind: "element_visible", elapsedMs: 5, observed: 'element with role "status" and name "Loading" is visible' }),
      ev(2, "verification", { passed: false, kind: "element_visible", elapsedMs: 500, observed: 'element with role "heading" and name "Dashboard" did not become visible within 500ms' })
    ];
    const results = checkInfiniteLoading({ events }, { loadingIndicator: LOADING });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ruleId: "ST-INFINITE-LOADING", status: "confirmed", evidenceSeqs: [1, 2] });
  });

  it("does not trigger if the loading indicator verification did not pass", () => {
    const events = [
      ev(1, "verification", { passed: false, kind: "element_visible", elapsedMs: 5, observed: 'element with role "status" and name "Loading" did not become visible within 5ms' }),
      ev(2, "verification", { passed: false, kind: "element_visible", elapsedMs: 500, observed: 'element with role "heading" and name "Dashboard" did not become visible within 500ms' })
    ];
    expect(checkInfiniteLoading({ events }, { loadingIndicator: LOADING })).toHaveLength(0);
  });

  it("does not trigger if the following verification also passed", () => {
    const events = [
      ev(1, "verification", { passed: true, kind: "element_visible", elapsedMs: 5, observed: 'element with role "status" and name "Loading" is visible' }),
      ev(2, "verification", { passed: true, kind: "element_visible", elapsedMs: 5, observed: 'element with role "heading" and name "Dashboard" is visible' })
    ];
    expect(checkInfiniteLoading({ events }, { loadingIndicator: LOADING })).toHaveLength(0);
  });

  it("does not trigger for an unrelated element that happens to be visible", () => {
    const events = [
      ev(1, "verification", { passed: true, kind: "element_visible", elapsedMs: 5, observed: 'element with role "heading" and name "WebCheck Fixture" is visible' }),
      ev(2, "verification", { passed: false, kind: "element_visible", elapsedMs: 500, observed: 'element with role "heading" and name "Dashboard" did not become visible within 500ms' })
    ];
    expect(checkInfiniteLoading({ events }, { loadingIndicator: LOADING })).toHaveLength(0);
  });
});
