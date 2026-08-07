import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TimelineClosedError, TimelineStore, TimelineWriteError } from "../../src/timeline/store.ts";

describe("TimelineStore", () => {
  let artifactRoot: string;

  beforeEach(async () => {
    artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "webcheck-timeline-store-test-"));
  });

  afterEach(async () => {
    await fs.rm(artifactRoot, { recursive: true, force: true });
  });

  it("assigns seq 1 to the first appended event", async () => {
    const store = await TimelineStore.create({ artifactRoot });
    await store.append("run_started", {
      runId: store.runId,
      flowName: "x",
      startUrl: "http://127.0.0.1:4300",
      startedAt: new Date().toISOString()
    });

    const raw = await fs.readFile(store.eventsPath, "utf-8");
    const line = JSON.parse(raw.trim());
    expect(line.seq).toBe(1);
  });

  it("increments seq once per persisted event with no gaps or reuse", async () => {
    const store = await TimelineStore.create({ artifactRoot });
    for (let i = 0; i < 5; i++) {
      await store.append("console", { level: "log", text: `message ${i}` });
    }

    const raw = await fs.readFile(store.eventsPath, "utf-8");
    const lines = raw.trim().split("\n").map((line) => JSON.parse(line) as { seq: number });
    expect(lines.map((l) => l.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it("writes one valid JSON event per line, in seq order", async () => {
    const store = await TimelineStore.create({ artifactRoot });
    await store.append("console", { level: "log", text: "a" });
    await store.append("console", { level: "warn", text: "b" });
    await store.append("console", { level: "error", text: "c" });

    const raw = await fs.readFile(store.eventsPath, "utf-8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(3);

    const parsed = lines.map((line) => JSON.parse(line));
    expect(parsed.map((e) => e.payload.text)).toEqual(["a", "b", "c"]);
    for (const event of parsed) {
      expect(event.version).toBe(1);
      expect(event.runId).toBe(store.runId);
      expect(typeof event.timestampWallMs).toBe("number");
      expect(typeof event.timestampMonoMs).toBe("number");
    }
  });

  it("rejects writes after close", async () => {
    const store = await TimelineStore.create({ artifactRoot });
    await store.append("console", { level: "log", text: "before close" });
    await store.close();

    await expect(store.append("console", { level: "log", text: "after close" })).rejects.toThrow(
      TimelineClosedError
    );
  });

  it("rejects an invalid event instead of writing it", async () => {
    const store = await TimelineStore.create({ artifactRoot });

    // @ts-expect-error -- deliberately missing the required `text` field to prove runtime validation catches what the type system would otherwise block.
    await expect(store.append("console", { level: "log" })).rejects.toThrow(TimelineWriteError);

    const raw = await fs.readFile(store.eventsPath, "utf-8").catch(() => "");
    expect(raw.trim()).toBe("");
  });

  it("safely creates the run artifact directory, scoped by a fresh UUID runId", async () => {
    const store = await TimelineStore.create({ artifactRoot });
    expect(store.runDir).toBe(path.join(artifactRoot, store.runId));
    expect(store.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    const stat = await fs.stat(store.screenshotsDir);
    expect(stat.isDirectory()).toBe(true);
  });
});
