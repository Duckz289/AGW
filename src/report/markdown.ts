import { truncate } from "../collectors/limits.ts";
import type { EvidenceRef, Finding } from "../findings/schema.ts";
import { redactText } from "../security/redactor.ts";
import type { WebCheckReport } from "./schema.ts";

/**
 * Defense-in-depth cap on any single free-text block rendered into
 * Markdown, on top of the already-bounded upstream text (src/collectors/
 * limits.ts). report.md is a new artifact boundary, so bounding it does
 * not depend on every upstream producer having gotten truncation right.
 */
const MAX_MARKDOWN_BLOCK_LENGTH = 4000;

/**
 * Safe for a single Markdown line (headings, label/value bullets): collapses
 * newlines to a space so embedded text can never start a new line and be
 * misread as a heading, list item, or table row. Also re-applies the
 * deterministic redactor — report.md is a new persistence boundary, so this
 * defends against a hypothetical future bug even though the input `report`
 * has already been through redaction once in src/findings/from-checker.ts.
 */
function sanitizeInline(text: string): string {
  return redactText(text).replace(/\r\n|\r|\n/g, " ").trim();
}

/**
 * Safe for arbitrary, possibly multi-line free text: wraps it in a fenced
 * code block whose fence is longer than the longest run of backticks
 * already present in the content (the standard CommonMark technique), so
 * the content can never prematurely close its own fence and escape into
 * interpreted Markdown. Truncates first so the fence length reflects what
 * is actually rendered.
 */
function renderFencedBlock(text: string): string {
  const normalized = truncate(redactText(text).replace(/\r\n|\r/g, "\n"), MAX_MARKDOWN_BLOCK_LENGTH);
  const backtickRuns = normalized.match(/`+/g) ?? [];
  const longestRun = backtickRuns.reduce((max, run) => Math.max(max, run.length), 0);
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}\n${normalized}\n${fence}`;
}

function renderEvidenceRef(ref: EvidenceRef): string {
  const parts = [`seq ${ref.seq}`, `type \`${ref.type}\``];
  if (ref.actionId !== undefined) parts.push(`actionId \`${ref.actionId}\``);
  if (ref.requestId !== undefined) parts.push(`requestId \`${ref.requestId}\``);
  if (ref.screenshotPath !== undefined) parts.push(`screenshot \`${ref.screenshotPath}\``);
  return `- ${parts.join(", ")}`;
}

function renderFinding(finding: Finding): string {
  const lines: string[] = [];

  lines.push(`### ${finding.id} — ${sanitizeInline(finding.title)}`);
  lines.push("");
  lines.push(`- Rule: \`${finding.ruleId}\``);
  lines.push(`- Classification: ${finding.classification}`);
  lines.push(`- Category: ${finding.category}`);
  if (finding.actionId !== undefined) {
    lines.push(`- Action ID: \`${finding.actionId}\``);
  }

  lines.push("");
  lines.push("Summary:");
  lines.push("");
  lines.push(renderFencedBlock(finding.summary));

  lines.push("");
  lines.push("Observed:");
  lines.push("");
  lines.push(renderFencedBlock(finding.observed));

  lines.push("");
  lines.push("Expected:");
  lines.push("");
  lines.push(renderFencedBlock(finding.expected));

  if (finding.reproduction) {
    lines.push("");
    lines.push("Reproduction:");
    lines.push("");
    lines.push(`- Flow: ${sanitizeInline(finding.reproduction.flowName)}`);
    if (finding.reproduction.failedStepIndex !== undefined) {
      lines.push(`- Failed step index: ${finding.reproduction.failedStepIndex}`);
    }
    if (finding.reproduction.failedStepType !== undefined) {
      lines.push(`- Failed step type: ${sanitizeInline(finding.reproduction.failedStepType)}`);
    }
  }

  lines.push("");
  lines.push("#### Evidence");
  lines.push("");
  if (finding.evidence.length === 0) {
    lines.push("No evidence recorded.");
  } else {
    for (const ref of finding.evidence) {
      lines.push(renderEvidenceRef(ref));
    }
  }

  return lines.join("\n");
}

/**
 * Pure, deterministic rendering of an already-validated WebCheckReport into
 * a human-readable Markdown document. Presentation layer only: report.json
 * remains the machine-readable source of truth (AGENT.MD). No filesystem,
 * browser, timeline, or checker access; never mutates `report`; the same
 * input always produces byte-identical output.
 */
export function renderMarkdownReport(report: WebCheckReport): string {
  const sections: string[] = ["# WebCheck Report"];

  const run = report.run;
  const summary = report.summary;
  sections.push(
    [
      "## Run Summary",
      "",
      `- Run ID: ${sanitizeInline(run.runId)}`,
      `- Flow: ${sanitizeInline(run.flowName)}`,
      `- Status: ${run.status}`,
      `- Duration: ${run.durationMs} ms`,
      `- Completed steps: ${run.completedSteps}`,
      `- Findings: ${summary.findings}`,
      `- Confirmed: ${summary.confirmed}`,
      `- Likely: ${summary.likely}`,
      `- Warnings: ${summary.warnings}`
    ].join("\n")
  );

  const findingsBody =
    report.findings.length === 0
      ? "No findings detected."
      : report.findings.map((finding) => renderFinding(finding)).join("\n\n");
  sections.push(["## Findings", "", findingsBody].join("\n"));

  const limitationsBody =
    report.limitations.length === 0
      ? "No limitations recorded."
      : report.limitations.map((limitation) => `- ${sanitizeInline(limitation)}`).join("\n");
  sections.push(["## Limitations", "", limitationsBody].join("\n"));

  const hasScreenshot = report.findings.some((finding) =>
    finding.evidence.some((ref) => ref.screenshotPath !== undefined)
  );
  const artifactLines = ["- Events: `events.ndjson`", "- Report: `report.json`"];
  if (hasScreenshot) artifactLines.push("- Screenshots: `screenshots/`");
  sections.push(["## Artifact References", "", artifactLines.join("\n")].join("\n"));

  return `${sections.join("\n\n")}\n`;
}
