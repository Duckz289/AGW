import type { Page } from "playwright";

export interface PageSnapshot {
  snapshotId: string;
  url: string;
  title: string;
  /** YAML-like output of locator.ariaSnapshot({ mode: "ai" }) on <body>. */
  ariaSnapshot: string;
}

/**
 * Builds a PageSnapshot for the given page, tagged with the caller-supplied
 * snapshotId. Snapshot identity/versioning is owned by BrowserSession, not
 * this function — it only knows how to observe, not how to version.
 */
export async function observe(page: Page, snapshotId: string): Promise<PageSnapshot> {
  const ariaSnapshot = await page.locator("body").ariaSnapshot({ mode: "ai" });

  return {
    snapshotId,
    url: page.url(),
    title: await page.title(),
    ariaSnapshot
  };
}

export interface ObservedElementSummary {
  role: string;
  name?: string;
  ref: string;
}

const ELEMENT_LINE_PATTERN = /^\s*-\s*([a-zA-Z]+)(?:\s+"([^"]*)")?.*\[ref=(e\d+)\]/;

/**
 * Extracts a compact { role, name, ref } summary from an ariaSnapshot
 * string, for MCP responses that should not repeat the full YAML tree.
 */
export function summarizeElements(ariaSnapshot: string): ObservedElementSummary[] {
  const summary: ObservedElementSummary[] = [];
  for (const line of ariaSnapshot.split("\n")) {
    const match = ELEMENT_LINE_PATTERN.exec(line);
    if (!match) continue;
    const [, role, name, ref] = match;
    if (!role || !ref) continue;
    summary.push(name !== undefined && name !== "" ? { role, name, ref } : { role, ref });
  }
  return summary;
}
