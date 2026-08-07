import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { TimelineEventSchema, type PayloadForType, type TimelineEventType } from "./events.ts";

export class TimelineWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimelineWriteError";
  }
}

export class TimelineClosedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimelineClosedError";
  }
}

export interface TimelineStoreCreateOptions {
  /** Directory under which `<runId>/events.ndjson` is created. Defaults to `<cwd>/.webcheck/runs`. */
  artifactRoot?: string;
}

export interface AppendOptions {
  actionId?: string;
}

/**
 * Append-only NDJSON evidence store for a single flow run. One instance
 * per run — `runId` is generated once at creation (`crypto.randomUUID()`)
 * and is never derived from user-controlled input (flow name, URL, etc.),
 * so the artifact directory it produces (`<artifactRoot>/<runId>/`) cannot
 * be influenced by path traversal.
 *
 * Data path enforced here (CURRENT_TASK.md): every event passed to
 * `append()` is expected to already be normalized and redacted by the
 * caller (collectors / flow-runner) — this class's own job is only
 * envelope assembly (seq/runId/timestamps), Zod validation, and the
 * actual durable write. There is no raw/unredacted event store anywhere:
 * nothing is written to disk before `append()` validates it.
 */
export class TimelineStore {
  readonly runId: string;
  readonly runDir: string;
  readonly eventsPath: string;
  readonly screenshotsDir: string;

  private seq = 0;
  private screenshotSeq = 0;
  private closed = false;
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(runId: string, runDir: string, eventsPath: string, screenshotsDir: string) {
    this.runId = runId;
    this.runDir = runDir;
    this.eventsPath = eventsPath;
    this.screenshotsDir = screenshotsDir;
  }

  static async create(options: TimelineStoreCreateOptions = {}): Promise<TimelineStore> {
    const runId = randomUUID();
    const artifactRoot = options.artifactRoot ?? path.join(process.cwd(), ".webcheck", "runs");
    const runDir = path.join(artifactRoot, runId);
    const screenshotsDir = path.join(runDir, "screenshots");
    const eventsPath = path.join(runDir, "events.ndjson");

    await mkdir(screenshotsDir, { recursive: true });

    return new TimelineStore(runId, runDir, eventsPath, screenshotsDir);
  }

  /** Monotonic counter for deterministic, collision-free screenshot file names (independent of the main event `seq`). */
  nextScreenshotSeq(): number {
    this.screenshotSeq += 1;
    return this.screenshotSeq;
  }

  /**
   * Validates and durably appends one timeline event. `seq` is assigned
   * synchronously (before any `await`), so concurrent, un-awaited callers
   * can never receive or write a duplicate/out-of-order `seq`. The actual
   * disk write is additionally serialized through an internal queue so
   * that on-disk line order always matches `seq` order, even if two
   * collectors fire their (independently async) event handlers close
   * together.
   */
  async append<TType extends TimelineEventType>(
    type: TType,
    payload: PayloadForType<TType>,
    options: AppendOptions = {}
  ): Promise<void> {
    if (this.closed) {
      throw new TimelineClosedError(`cannot append a "${type}" event: timeline store for run ${this.runId} is closed`);
    }

    this.seq += 1;
    const seq = this.seq;

    const envelope = {
      version: 1 as const,
      seq,
      runId: this.runId,
      timestampWallMs: Date.now(),
      timestampMonoMs: performance.now(),
      type,
      ...(options.actionId !== undefined ? { actionId: options.actionId } : {}),
      payload
    };

    const parsed = TimelineEventSchema.safeParse(envelope);
    if (!parsed.success) {
      throw new TimelineWriteError(
        `refusing to append invalid timeline event (type="${type}", seq=${seq}): ${parsed.error.message}`
      );
    }

    const line = `${JSON.stringify(parsed.data)}\n`;
    const task = this.writeQueue.then(() => appendFile(this.eventsPath, line, "utf-8"));
    // Keep the chain alive even if this write fails, so later calls still
    // queue in order after this attempt instead of racing ahead of it.
    this.writeQueue = task.then(
      () => undefined,
      () => undefined
    );

    try {
      await task;
    } catch (err) {
      throw new TimelineWriteError(
        `failed to append timeline event (type="${type}", seq=${seq}) to ${this.eventsPath}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Marks the store closed; further `append()` calls are rejected. There
   * is no buffered file handle to flush — each `append()` call is already
   * durably written (via `fs.appendFile`) before it resolves.
   */
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}
