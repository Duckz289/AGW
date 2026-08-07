import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WebCheckReport } from "./schema.ts";

export class ReportWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportWriteError";
  }
}

/**
 * Writes `report.json` atomically: serialize -> write to a uniquely-named
 * temp file in the same directory -> rename over the final path. `rename`
 * within the same directory is atomic on both POSIX and Windows (verified
 * directly: renaming onto an existing destination file replaces it
 * cleanly, not merges or corrupts it) — practical durability for a local
 * MVP artifact, not a distributed-systems guarantee
 * (CURRENT_TASK.md: "Do not overengineer durability beyond local MVP
 * needs"). If anything fails before the rename, the temp file is removed
 * and the final path is never touched — a previous good report.json (or
 * its absence) is preserved exactly, never left partially written.
 */
export async function writeReport(report: WebCheckReport, runDir: string): Promise<string> {
  const finalPath = path.join(runDir, "report.json");
  const tempPath = path.join(runDir, `.report.json.tmp-${randomUUID()}`);
  const json = `${JSON.stringify(report, null, 2)}\n`;

  try {
    await writeFile(tempPath, json, "utf-8");
    await rename(tempPath, finalPath);
  } catch (err) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw new ReportWriteError(
      `failed to write report.json to ${finalPath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return finalPath;
}
