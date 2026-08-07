import type { Page } from "playwright";
import { redactText } from "../security/redactor.ts";
import type { TimelineStore } from "../timeline/store.ts";
import { MAX_STACK_LENGTH, truncate } from "./limits.ts";

export interface PageErrorCollectorOptions {
  getActionId: () => string | undefined;
  maxStackLength?: number;
}

/**
 * Attaches a deterministic runtime (uncaught exception) collector to
 * `page`. Kept distinct from console events (`runtime_error`, never
 * flattened into a `console` event) and does not attempt root-cause
 * classification — that is out of scope for Phase 2A.
 */
export function attachPageErrorCollector(page: Page, timeline: TimelineStore, options: PageErrorCollectorOptions): void {
  const maxStackLength = options.maxStackLength ?? MAX_STACK_LENGTH;

  page.on("pageerror", (error: Error) => {
    void handle(error);
  });

  async function handle(error: Error): Promise<void> {
    const actionId = options.getActionId();
    const message = redactText(error.message);
    const stack = error.stack !== undefined ? truncate(redactText(error.stack), maxStackLength) : undefined;

    try {
      await timeline.append(
        "runtime_error",
        {
          ...(error.name ? { name: error.name } : {}),
          message,
          ...(stack !== undefined ? { stack } : {})
        },
        actionId !== undefined ? { actionId } : {}
      );
    } catch {
      // Best-effort side-channel evidence; see console collector's note.
    }
  }
}
