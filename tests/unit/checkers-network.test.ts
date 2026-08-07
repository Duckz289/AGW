import { describe, expect, it } from "vitest";
import { checkNetworkErrors, checkTransportFailures } from "../../src/checkers/network.ts";
import { ev } from "../helpers/synthetic-events.ts";

describe("NW-HTTP-ERROR", () => {
  it("triggers likely on a 500 response with no correlated verification", () => {
    const events = [
      ev(1, "network_request", { requestId: "req-000001", method: "POST", url: "http://x/api/login", resourceType: "fetch" }),
      ev(2, "network_response", { requestId: "req-000001", url: "http://x/api/login", status: 500 })
    ];
    const results = checkNetworkErrors({ events });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ruleId: "NW-HTTP-ERROR", status: "likely" });
    expect(results[0]?.evidenceSeqs).toEqual([1, 2]);
  });

  it("triggers likely on a 404 response", () => {
    const events = [ev(1, "network_response", { requestId: "req-000001", url: "http://x/missing", status: 404 })];
    const results = checkNetworkErrors({ events });
    expect(results).toHaveLength(1);
    expect(results[0]?.observed).toContain("404");
  });

  it("does not trigger below 400", () => {
    const events = [ev(1, "network_response", { requestId: "req-000001", url: "http://x/ok", status: 200 })];
    expect(checkNetworkErrors({ events })).toHaveLength(0);
  });

  it("upgrades to confirmed when the same actionId has a failed verification", () => {
    const events = [
      ev(1, "network_response", { requestId: "req-000001", url: "http://x/api/login", status: 500 }, "action-0001"),
      ev(2, "verification", { passed: false, kind: "element_visible", elapsedMs: 10, observed: "not visible" }, "action-0001")
    ];
    const results = checkNetworkErrors({ events });
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("confirmed");
    expect(results[0]?.evidenceSeqs).toEqual([1, 2]);
  });

  it("does not upgrade across a different action (no cross-action upgrade)", () => {
    const events = [
      ev(1, "network_response", { requestId: "req-000001", url: "http://x/api/login", status: 500 }, "action-0001"),
      ev(2, "verification", { passed: false, kind: "element_visible", elapsedMs: 10, observed: "not visible" }, "action-0002")
    ];
    const results = checkNetworkErrors({ events });
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("likely");
  });

  it("does not upgrade a background request with no actionId even if some unrelated verification failed", () => {
    const events = [
      ev(1, "network_response", { requestId: "req-000001", url: "http://x/api/background", status: 500 }),
      ev(2, "verification", { passed: false, kind: "element_visible", elapsedMs: 10, observed: "not visible" }, "action-0001")
    ];
    const results = checkNetworkErrors({ events });
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("likely");
  });

  it("deduplicates by requestId: only one result even if seen twice", () => {
    const events = [
      ev(1, "network_response", { requestId: "req-000001", url: "http://x/a", status: 500 }),
      ev(2, "network_finished", { requestId: "req-000001", url: "http://x/a", method: "GET", status: 500 })
    ];
    expect(checkNetworkErrors({ events })).toHaveLength(1);
  });

  it("produces one distinct result per distinct requestId", () => {
    const events = [
      ev(1, "network_response", { requestId: "req-000001", url: "http://x/a", status: 500 }),
      ev(2, "network_response", { requestId: "req-000002", url: "http://x/b", status: 404 })
    ];
    expect(checkNetworkErrors({ events })).toHaveLength(2);
  });

  it("orders results deterministically by scan order (ascending seq)", () => {
    const events = [
      ev(5, "network_response", { requestId: "req-000002", url: "http://x/b", status: 404 }),
      ev(2, "network_response", { requestId: "req-000001", url: "http://x/a", status: 500 })
    ];
    // Events are provided out of seq order on purpose: the checker must
    // not reorder — it scans in the given (array) order.
    const results = checkNetworkErrors({ events });
    expect(results.map((r) => r.evidenceSeqs[0])).toEqual([5, 2]);
  });
});

describe("NW-TRANSPORT-FAILURE", () => {
  it("triggers likely on a genuine transport failure", () => {
    const events = [
      ev(1, "network_failed", { requestId: "req-000001", url: "http://x/api/transport-fail", method: "GET", failureText: "net::ERR_EMPTY_RESPONSE" })
    ];
    const results = checkTransportFailures({ events });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ruleId: "NW-TRANSPORT-FAILURE", status: "likely" });
  });

  it("does not trigger on a legitimate cancellation (net::ERR_ABORTED)", () => {
    const events = [
      ev(1, "network_failed", { requestId: "req-000001", url: "http://x/api/login", method: "POST", failureText: "net::ERR_ABORTED" })
    ];
    expect(checkTransportFailures({ events })).toHaveLength(0);
  });

  it("upgrades to confirmed when the same actionId has a failed verification", () => {
    const events = [
      ev(1, "network_failed", { requestId: "req-000001", url: "http://x/api/transport-fail", method: "GET", failureText: "net::ERR_EMPTY_RESPONSE" }, "action-0001"),
      ev(2, "verification", { passed: false, kind: "text_present", elapsedMs: 5, observed: "not found" }, "action-0001")
    ];
    const results = checkTransportFailures({ events });
    expect(results[0]?.status).toBe("confirmed");
    expect(results[0]?.evidenceSeqs).toEqual([1, 2]);
  });

  it("does not upgrade across a different action", () => {
    const events = [
      ev(1, "network_failed", { requestId: "req-000001", url: "http://x/api/transport-fail", method: "GET" }, "action-0001"),
      ev(2, "verification", { passed: false, kind: "text_present", elapsedMs: 5, observed: "not found" }, "action-0002")
    ];
    expect(checkTransportFailures({ events })[0]?.status).toBe("likely");
  });

  it("deduplicates by requestId", () => {
    const events = [
      ev(1, "network_failed", { requestId: "req-000001", url: "http://x/a", method: "GET" }),
      ev(2, "network_failed", { requestId: "req-000001", url: "http://x/a", method: "GET" })
    ];
    expect(checkTransportFailures({ events })).toHaveLength(1);
  });
});
