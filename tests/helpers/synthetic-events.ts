import type { PayloadForType, TimelineEvent, TimelineEventType } from "../../src/timeline/events.ts";

/**
 * Builds a synthetic, already-valid TimelineEvent for checker unit tests,
 * without needing a real browser/fixture run. `seq` also stands in for
 * `timestampWallMs`/`timestampMonoMs` so ordering assertions stay
 * readable.
 */
export function ev<TType extends TimelineEventType>(
  seq: number,
  type: TType,
  payload: PayloadForType<TType>,
  actionId?: string
): TimelineEvent {
  return {
    version: 1,
    seq,
    runId: "test-run",
    timestampWallMs: seq,
    timestampMonoMs: seq,
    type,
    ...(actionId !== undefined ? { actionId } : {}),
    payload
  } as TimelineEvent;
}
