/**
 * Phase 2A evidence-pipeline size limits. Deliberately simple, static
 * constants — no adaptive/dynamic budgets (CURRENT_TASK.md: "Do not build
 * dynamic adaptive budgets yet").
 */

/** Console message text is truncated beyond this many characters. */
export const MAX_CONSOLE_MESSAGE_LENGTH = 2000;

/** Runtime error stack traces are truncated beyond this many characters. */
export const MAX_STACK_LENGTH = 4000;

/** After this many console events in a single run, further console events are not persisted (one truncation-notice event is appended instead). */
export const MAX_CONSOLE_EVENTS_PER_RUN = 200;

/** Appends a truncation marker rather than silently cutting text with no trace of what happened. */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}… [truncated, ${text.length - maxLength} more characters]`;
}
