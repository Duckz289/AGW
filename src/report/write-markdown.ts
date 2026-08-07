import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export class MarkdownWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarkdownWriteError";
  }
}

/**
 * Writes `report.md` atomically, mirroring src/report/write.ts's
 * write-temp-then-rename pattern: write to a uniquely-named temp file in
 * the same directory, then `rename` over the final path. If anything fails
 * before the rename, the temp file is removed and the final path is never
 * touched — no partially-written report.md is ever left behind.
 */
export async function writeMarkdownReport(runDir: string, markdown: string): Promise<string> {
  const finalPath = path.join(runDir, "report.md");
  const tempPath = path.join(runDir, `.report.md.tmp-${randomUUID()}`);

  try {
    await writeFile(tempPath, markdown, "utf-8");
    await rename(tempPath, finalPath);
  } catch (err) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw new MarkdownWriteError(
      `failed to write report.md to ${finalPath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return finalPath;
}
