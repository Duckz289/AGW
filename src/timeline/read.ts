import { readFile } from "node:fs/promises";
import { TimelineEventSchema, type TimelineEvent } from "./events.ts";

/**
 * Reads a persisted `events.ndjson` file back into an in-memory
 * `TimelineEvent[]` — the read side of the same normalize -> redact ->
 * validate -> append pipeline (TimelineStore.append validates on the way
 * out; this validates again on the way back in), so a corrupted or
 * hand-edited artifact fails loudly instead of being silently trusted by
 * whatever consumes it (Phase 2B's checkers).
 */
export async function readTimelineEvents(eventsPath: string): Promise<TimelineEvent[]> {
  const raw = await readFile(eventsPath, "utf-8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);

  return lines.map((line, index) => {
    const parsedJson: unknown = JSON.parse(line);
    const result = TimelineEventSchema.safeParse(parsedJson);
    if (!result.success) {
      throw new Error(`invalid timeline event at line ${index + 1} of "${eventsPath}": ${result.error.message}`);
    }
    return result.data;
  });
}
