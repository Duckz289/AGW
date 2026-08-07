import type { Page, Request } from "playwright";
import { redactText, redactUrl } from "../security/redactor.ts";
import type { PayloadForType, TimelineEventType } from "../timeline/events.ts";
import type { TimelineStore } from "../timeline/store.ts";

export interface NetworkCollectorOptions {
  getActionId: () => string | undefined;
}

interface RequestMeta {
  requestId: string;
  /**
   * Captured once, when the Request object is first seen (always the
   * `request` event, which Playwright fires before response/failed/
   * finished for the same Request) — not re-read per event. This is the
   * "assign correlation directly during capture" the milestone asks for:
   * a response that happens to arrive after the originating action's
   * context has already cleared still correctly correlates with the
   * action that made the request, rather than silently losing
   * correlation or picking up whatever unrelated action is "current" by
   * then.
   */
  actionId: string | undefined;
}

/**
 * Attaches a deterministic network metadata collector to `page`, using
 * only public Playwright page events. Request identity is a `WeakMap`
 * keyed by object identity (not URL — the same endpoint can be requested
 * many times in one run), per CURRENT_TASK.md.
 *
 * `network_finished` (not `network_response`) is used to read
 * `request.timing()` — Phase 0 (see README.md "Known limitations")
 * already verified `responseEnd` is not reliably populated at `response`
 * time and only becomes available once `requestfinished` fires; that
 * finding is preserved here rather than regressed.
 *
 * No request/response bodies or headers are captured by default
 * (CURRENT_TASK.md "Body capture": conservative, metadata-first).
 */
export function attachNetworkCollector(page: Page, timeline: TimelineStore, options: NetworkCollectorOptions): void {
  const requestMeta = new WeakMap<Request, RequestMeta>();
  let requestSeq = 0;

  function metaFor(request: Request): RequestMeta {
    let meta = requestMeta.get(request);
    if (meta === undefined) {
      requestSeq += 1;
      meta = { requestId: `req-${String(requestSeq).padStart(6, "0")}`, actionId: options.getActionId() };
      requestMeta.set(request, meta);
    }
    return meta;
  }

  async function safeAppend<TType extends TimelineEventType>(
    type: TType,
    payload: PayloadForType<TType>,
    actionId: string | undefined
  ): Promise<void> {
    try {
      await timeline.append(type, payload, actionId !== undefined ? { actionId } : {});
    } catch {
      // Best-effort side-channel evidence; see console collector's note
      // in src/collectors/console.ts.
    }
  }

  page.on("request", (request) => {
    const meta = metaFor(request);
    void safeAppend(
      "network_request",
      {
        requestId: meta.requestId,
        method: request.method(),
        url: redactUrl(request.url()),
        resourceType: request.resourceType()
      },
      meta.actionId
    );
  });

  page.on("response", (response) => {
    void (async () => {
      const meta = metaFor(response.request());
      let contentType: string | undefined;
      try {
        contentType = (await response.headerValue("content-type")) ?? undefined;
      } catch {
        contentType = undefined;
      }

      await safeAppend(
        "network_response",
        {
          requestId: meta.requestId,
          url: redactUrl(response.url()),
          status: response.status(),
          statusText: response.statusText(),
          ...(contentType !== undefined ? { contentType: redactText(contentType) } : {})
        },
        meta.actionId
      );
    })();
  });

  // HTTP error responses (e.g. 500) are handled entirely by the `response`
  // listener above, as a normal network_response with that status code —
  // never here. This listener only fires for genuine transport-level
  // failures (AGENT.MD: "HTTP error responses are not the same as
  // transport failures").
  page.on("requestfailed", (request) => {
    const meta = metaFor(request);
    const failure = request.failure();
    void safeAppend(
      "network_failed",
      {
        requestId: meta.requestId,
        url: redactUrl(request.url()),
        method: request.method(),
        ...(failure?.errorText !== undefined ? { failureText: failure.errorText } : {})
      },
      meta.actionId
    );
  });

  page.on("requestfinished", (request) => {
    void (async () => {
      const meta = metaFor(request);
      const response = await request.response().catch(() => null);
      const timing = request.timing();
      const durationMs = timing.responseEnd >= 0 ? timing.responseEnd : undefined;

      await safeAppend(
        "network_finished",
        {
          requestId: meta.requestId,
          url: redactUrl(request.url()),
          method: request.method(),
          ...(response ? { status: response.status() } : {}),
          ...(durationMs !== undefined ? { durationMs } : {})
        },
        meta.actionId
      );
    })();
  });
}
