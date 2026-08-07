import type { ConsoleMessage, Page } from "playwright";
import { redactText } from "../security/redactor.ts";
import type { TimelineStore } from "../timeline/store.ts";
import { MAX_CONSOLE_EVENTS_PER_RUN, MAX_CONSOLE_MESSAGE_LENGTH, truncate } from "./limits.ts";

export interface ConsoleCollectorOptions {
  /** Returns the actionId currently active on the session, if any. */
  getActionId: () => string | undefined;
  maxMessageLength?: number;
  maxEventsPerRun?: number;
}

function appendOptions(actionId: string | undefined): { actionId?: string } {
  return actionId !== undefined ? { actionId } : {};
}

/**
 * Attaches a deterministic console collector to `page`. Console
 * warning/error is evidence only in Phase 2A — never classified as a
 * defect here (CURRENT_TASK.md).
 *
 * Data path per event: extract raw fields from the ConsoleMessage
 * (normalize) -> redactText (redact) -> truncate -> TimelineStore.append,
 * which itself Zod-validates before ever writing a byte (validate ->
 * append). Text is always redacted *before* truncation, so a truncation
 * cut can never leave a partial, still-readable secret fragment in the
 * persisted text.
 */
export function attachConsoleCollector(page: Page, timeline: TimelineStore, options: ConsoleCollectorOptions): void {
  const maxMessageLength = options.maxMessageLength ?? MAX_CONSOLE_MESSAGE_LENGTH;
  const maxEventsPerRun = options.maxEventsPerRun ?? MAX_CONSOLE_EVENTS_PER_RUN;
  let persistedCount = 0;
  let limitNoted = false;

  page.on("console", (msg: ConsoleMessage) => {
    void handle(msg);
  });

  async function handle(msg: ConsoleMessage): Promise<void> {
    const actionId = options.getActionId();

    if (persistedCount >= maxEventsPerRun) {
      if (!limitNoted) {
        limitNoted = true;
        try {
          await timeline.append(
            "console",
            {
              level: "warn",
              text: `[webcheck] console event limit reached (${maxEventsPerRun} per run); further console events in this run were not persisted`
            },
            appendOptions(actionId)
          );
        } catch {
          // Best-effort side-channel evidence: this collector's async
          // listener has no natural backpressure point in the flow's own
          // control flow. A failure here does not represent the run's
          // own pass/fail outcome, so it is not escalated — see
          // README.md "Evidence limitations".
        }
      }
      return;
    }

    const location = msg.location();
    const text = truncate(redactText(msg.text()), maxMessageLength);

    persistedCount += 1;
    try {
      await timeline.append(
        "console",
        {
          level: msg.type(),
          text,
          location: {
            ...(location.url ? { url: redactText(location.url) } : {}),
            ...(location.lineNumber !== undefined ? { lineNumber: location.lineNumber } : {}),
            ...(location.columnNumber !== undefined ? { columnNumber: location.columnNumber } : {})
          }
        },
        appendOptions(actionId)
      );
    } catch {
      // Best-effort; see note above.
    }
  }
}
