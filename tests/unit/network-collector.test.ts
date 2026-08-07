import { describe, expect, it } from "vitest";
import type { Page, Request, Response } from "playwright";
import { attachNetworkCollector } from "../../src/collectors/network.ts";
import type { TimelineStore } from "../../src/timeline/store.ts";

interface RecordedAppend {
  type: string;
  payload: Record<string, unknown>;
  actionId: string | undefined;
}

function createFakePage(): { page: Page; emit: (event: string, arg: unknown) => Promise<void> } {
  const listeners = new Map<string, Array<(arg: unknown) => void | Promise<void>>>();
  const page = {
    on(event: string, listener: (arg: unknown) => void | Promise<void>) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return page;
    }
  };
  return {
    page: page as unknown as Page,
    async emit(event: string, arg: unknown) {
      for (const listener of listeners.get(event) ?? []) {
        await listener(arg);
      }
    }
  };
}

function createFakeTimeline(): { timeline: TimelineStore; calls: RecordedAppend[] } {
  const calls: RecordedAppend[] = [];
  const timeline = {
    runId: "test-run",
    runDir: "/fake/run",
    eventsPath: "/fake/run/events.ndjson",
    screenshotsDir: "/fake/run/screenshots",
    nextScreenshotSeq: () => 1,
    async append(type: string, payload: Record<string, unknown>, options: { actionId?: string } = {}) {
      calls.push({ type, payload, actionId: options.actionId });
    },
    close: async () => undefined
  };
  return { timeline: timeline as unknown as TimelineStore, calls };
}

function createFakeRequest(overrides: {
  method?: string;
  url?: string;
  resourceType?: string;
  failureText?: string | null;
  responseEnd?: number;
}): Request {
  const request = {
    method: () => overrides.method ?? "GET",
    url: () => overrides.url ?? "http://127.0.0.1:4300/",
    resourceType: () => overrides.resourceType ?? "document",
    failure: () =>
      overrides.failureText !== undefined && overrides.failureText !== null
        ? { errorText: overrides.failureText }
        : null,
    timing: () => ({ responseEnd: overrides.responseEnd ?? -1 }),
    response: async () => null
  };
  return request as unknown as Request;
}

function createFakeResponse(request: Request, status: number): Response {
  const response = {
    request: () => request,
    url: () => (request as unknown as { url: () => string }).url(),
    status: () => status,
    statusText: () => (status === 200 ? "OK" : "Error"),
    headerValue: async (name: string) => (name === "content-type" ? "application/json" : null)
  };
  return response as unknown as Response;
}

describe("network collector: request identity", () => {
  it("assigns the same requestId to every event tied to the same Request object", async () => {
    const { page, emit } = createFakePage();
    const { timeline, calls } = createFakeTimeline();
    attachNetworkCollector(page, timeline, { getActionId: () => undefined });

    const request = createFakeRequest({ url: "http://127.0.0.1:4300/api/login", method: "POST" });
    await emit("request", request);
    await emit("response", createFakeResponse(request, 200));
    await emit("requestfinished", request);

    const requestIds = calls.map((c) => c.payload["requestId"]);
    expect(new Set(requestIds).size).toBe(1);
    expect(requestIds).toEqual(["req-000001", "req-000001", "req-000001"]);
  });

  it("assigns distinct, sequential requestIds to distinct Request objects", async () => {
    const { page, emit } = createFakePage();
    const { timeline, calls } = createFakeTimeline();
    attachNetworkCollector(page, timeline, { getActionId: () => undefined });

    const first = createFakeRequest({ url: "http://127.0.0.1:4300/a" });
    const second = createFakeRequest({ url: "http://127.0.0.1:4300/b" });
    await emit("request", first);
    await emit("request", second);

    expect(calls[0]?.payload["requestId"]).toBe("req-000001");
    expect(calls[1]?.payload["requestId"]).toBe("req-000002");
  });
});

describe("network collector: action correlation", () => {
  it("tags an event with the actionId that was active when the request started", async () => {
    const { page, emit } = createFakePage();
    const { timeline, calls } = createFakeTimeline();
    let currentActionId: string | undefined = "action-0001";
    attachNetworkCollector(page, timeline, { getActionId: () => currentActionId });

    const request = createFakeRequest({ url: "http://127.0.0.1:4300/api/login" });
    await emit("request", request);
    // The action ends before the response arrives — correlation must
    // stick with the id captured at request time, not "whatever is
    // current now".
    currentActionId = undefined;
    await emit("response", createFakeResponse(request, 200));

    expect(calls[0]?.actionId).toBe("action-0001");
    expect(calls[1]?.actionId).toBe("action-0001");
  });

  it("leaves actionId absent for events outside any active action", async () => {
    const { page, emit } = createFakePage();
    const { timeline, calls } = createFakeTimeline();
    attachNetworkCollector(page, timeline, { getActionId: () => undefined });

    await emit("request", createFakeRequest({ url: "http://127.0.0.1:4300/styles.css" }));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.actionId).toBeUndefined();
  });
});

describe("network collector: HTTP semantics", () => {
  it("records an HTTP error status as a normal network_response, not network_failed", async () => {
    const { page, emit } = createFakePage();
    const { timeline, calls } = createFakeTimeline();
    attachNetworkCollector(page, timeline, { getActionId: () => undefined });

    const request = createFakeRequest({ url: "http://127.0.0.1:4300/api/login", method: "POST" });
    await emit("request", request);
    await emit("response", createFakeResponse(request, 500));

    const types = calls.map((c) => c.type);
    expect(types).toContain("network_response");
    expect(types).not.toContain("network_failed");
    const response = calls.find((c) => c.type === "network_response");
    expect(response?.payload["status"]).toBe(500);
  });

  it("records a transport failure as network_failed with no network_response", async () => {
    const { page, emit } = createFakePage();
    const { timeline, calls } = createFakeTimeline();
    attachNetworkCollector(page, timeline, { getActionId: () => undefined });

    const request = createFakeRequest({ url: "http://127.0.0.1:4300/api/transport-fail", failureText: "net::ERR_EMPTY_RESPONSE" });
    await emit("request", request);
    await emit("requestfailed", request);

    const types = calls.map((c) => c.type);
    expect(types).toContain("network_failed");
    expect(types).not.toContain("network_response");
    const failed = calls.find((c) => c.type === "network_failed");
    expect(failed?.payload["failureText"]).toBe("net::ERR_EMPTY_RESPONSE");
    expect(failed?.payload["requestId"]).toBe(calls[0]?.payload["requestId"]);
  });
});

describe("network collector: redaction", () => {
  it("redacts a sensitive query parameter in the request URL before it reaches the timeline", async () => {
    const { page, emit } = createFakePage();
    const { timeline, calls } = createFakeTimeline();
    attachNetworkCollector(page, timeline, { getActionId: () => undefined });

    await emit(
      "request",
      createFakeRequest({ url: "http://127.0.0.1:4300/api/sensitive?token=WEBCHECK_TEST_TOKEN_91ce&query=test" })
    );

    const url = calls[0]?.payload["url"] as string;
    expect(url).not.toContain("WEBCHECK_TEST_TOKEN_91ce");
    expect(url).toContain("query=test");
  });
});
