import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export class TestWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestWriteError";
  }
}

// Finding IDs are always this deterministic, index-based shape
// (src/findings/from-checker.ts). Rejecting anything else here is a
// path-traversal guard (AGENT.MD "Protect all artifact operations
// against path traversal"), not a generic validator.
const FINDING_ID_PATTERN = /^finding-\d+$/;

/**
 * Writes a generated regression test to
 * `<runDir>/generated-tests/<findingId>.spec.ts` — a safe, deterministic
 * filename derived only from the Finding's own id, never its title.
 * Atomic write, mirroring src/report/write.ts: temp file in the target
 * directory, then `rename`; no partial `.spec.ts` is ever left on
 * failure.
 */
export async function writeGeneratedTest(runDir: string, findingId: string, source: string): Promise<string> {
  if (!FINDING_ID_PATTERN.test(findingId)) {
    throw new TestWriteError(`refusing to write generated test: unsafe findingId "${findingId}"`);
  }

  const testsDir = path.join(runDir, "generated-tests");
  const finalPath = path.join(testsDir, `${findingId}.spec.ts`);
  const tempPath = path.join(testsDir, `.${findingId}.spec.ts.tmp-${randomUUID()}`);

  try {
    await mkdir(testsDir, { recursive: true });
    await writeFile(tempPath, source, "utf-8");
    await rename(tempPath, finalPath);
  } catch (err) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw new TestWriteError(
      `failed to write generated test to ${finalPath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return finalPath;
}
