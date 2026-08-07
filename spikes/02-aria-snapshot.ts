import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
// eslint-disable-next-line @typescript-eslint/no-var-requires
import playwrightCorePkg from "playwright-core/package.json" with { type: "json" };
import { startFixtureServer } from "../fixtures/server.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT_DIR = path.join(__dirname, "..", "phase0-artifacts");

async function main(): Promise<void> {
  const findings: string[] = [];
  findings.push(`Installed Playwright (playwright-core) version: ${playwrightCorePkg.version}`);

  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });

  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(fixture.url);

    const body = page.locator("body");

    let aiSnapshot = "";
    let aiModeAccepted = true;
    try {
      aiSnapshot = await body.ariaSnapshot({ mode: "ai" });
    } catch (err) {
      aiModeAccepted = false;
      aiSnapshot = `<error calling ariaSnapshot mode:"ai"> ${String(err)}`;
    }
    findings.push(`mode:"ai" accepted without throwing: ${aiModeAccepted}`);

    const defaultSnapshot = await body.ariaSnapshot({ mode: "default" });

    // Call again to check for instability between two consecutive calls
    // against an unchanged page.
    const aiSnapshotSecondCall = await body.ariaSnapshot({ mode: "ai" });
    const stableAcrossRepeatedCalls = normalizeRefs(aiSnapshot) === normalizeRefs(aiSnapshotSecondCall);
    findings.push(
      `Snapshot stable in structure across two consecutive calls (ignoring ref numbers): ${stableAcrossRepeatedCalls}`
    );

    const hasRefs = /\[ref=e\d+\]/.test(aiSnapshot);
    findings.push(`References like [ref=eN] appear: ${hasRefs}`);

    const hasRoleAndName = /"[^"]+"/.test(aiSnapshot) && /textbox|button|link|heading/.test(aiSnapshot);
    findings.push(`Role and accessible name appear in snapshot: ${hasRoleAndName}`);

    const emailIdentifiable = /email/i.test(aiSnapshot);
    const passwordIdentifiable = /password/i.test(aiSnapshot);
    const loginIdentifiable = /login/i.test(aiSnapshot);
    findings.push(`Email element identifiable by text match: ${emailIdentifiable}`);
    findings.push(`Password element identifiable by text match: ${passwordIdentifiable}`);
    findings.push(`Login element identifiable by text match: ${loginIdentifiable}`);

    findings.push(`Snapshot (mode:"ai") character length: ${aiSnapshot.length}`);
    findings.push(`Snapshot (mode:"default") character length: ${defaultSnapshot.length}`);

    const undocumentedNotes: string[] = [];
    if (!hasRefs && aiModeAccepted) {
      undocumentedNotes.push(
        'mode:"ai" was accepted but did not include [ref=eN] markers as documented.'
      );
    }
    if (undocumentedNotes.length === 0) {
      undocumentedNotes.push("No instability or undocumented behavior observed.");
    }
    findings.push(`Undocumented/instability notes: ${undocumentedNotes.join(" ")}`);

    await fs.mkdir(ARTIFACT_DIR, { recursive: true });
    await fs.writeFile(
      path.join(ARTIFACT_DIR, "02-aria-snapshot-ai-mode.yaml"),
      aiSnapshot,
      "utf-8"
    );
    await fs.writeFile(
      path.join(ARTIFACT_DIR, "02-aria-snapshot-default-mode.yaml"),
      defaultSnapshot,
      "utf-8"
    );
    await fs.writeFile(
      path.join(ARTIFACT_DIR, "02-aria-snapshot-findings.md"),
      `# Spike 2 — AI accessibility snapshot findings\n\n${findings.map((f) => `- ${f}`).join("\n")}\n`,
      "utf-8"
    );

    console.log(findings.join("\n"));
    console.log("\n--- captured mode:\"ai\" snapshot ---\n");
    console.log(aiSnapshot);
  } finally {
    await browser.close();
    await fixture.close();
  }
}

function normalizeRefs(snapshot: string): string {
  return snapshot.replace(/\[ref=e\d+\]/g, "[ref=eN]");
}

void main();
