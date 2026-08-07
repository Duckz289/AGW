import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startFixtureServer, type FixtureServerHandle } from "../../fixtures/server.ts";

// client.callTool()'s return type is a union of the normal tool-result
// shape and an experimental task-based shape ({ toolResult: unknown }).
// Phase 0 only registers plain (non-task) tools, so at runtime this is
// always the former; parseToolPayload narrows it defensively.
type ToolCallResponse = Awaited<ReturnType<Client["callTool"]>>;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, "..", "..");
const SERVER_ENTRY = path.join(PROJECT_ROOT, "src", "mcp", "server.ts");
const ARTIFACT_DIR = path.join(PROJECT_ROOT, "phase0-artifacts");
// Spawn tsx's CLI entry directly with the current node binary rather than
// via `npx`. `npx` on Windows resolves to a .cmd wrapper around cmd.exe,
// which swallows kill() signals sent to the wrapper process and leaves the
// real node/tsx process (and anything it spawned) running — a real Phase 0
// finding, not a style choice. See README.md "Known limitations".
const TSX_CLI = path.join(PROJECT_ROOT, "node_modules", "tsx", "dist", "cli.mjs");

interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

const results: CheckResult[] = [];

function record(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name} — ${detail}`);
}

function isToolError(result: ToolCallResponse): boolean {
  const value = result as Record<string, unknown>;
  return Array.isArray(value["content"]) && value["isError"] === true;
}

function parseToolPayload(result: ToolCallResponse): Record<string, unknown> {
  const value = result as Record<string, unknown>;
  const content = value["content"];
  if (!Array.isArray(content)) {
    return { toolResult: value["toolResult"] };
  }

  const structured = value["structuredContent"];
  if (structured && typeof structured === "object") {
    return structured as Record<string, unknown>;
  }

  const first = content[0] as { type?: string; text?: string } | undefined;
  if (first?.type === "text" && typeof first.text === "string") {
    return JSON.parse(first.text) as Record<string, unknown>;
  }
  return {};
}

async function main(): Promise<void> {
  let fixture: FixtureServerHandle | undefined;
  const transcript: Array<{ tool: string; request: unknown; response: unknown }> = [];

  const client = new Client({ name: "webcheck-phase0-test-client", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [TSX_CLI, SERVER_ENTRY],
    cwd: PROJECT_ROOT
  });

  try {
    fixture = await startFixtureServer();

    await client.connect(transport);
    record("mcp transport connected", true, "StdioClientTransport initialized handshake with the server");

    // 1. webcheck_start
    const startArgs = { url: fixture.url, headless: true };
    const startResult = await client.callTool({ name: "webcheck_start", arguments: startArgs });
    const startPayload = parseToolPayload(startResult);
    transcript.push({ tool: "webcheck_start", request: startArgs, response: startPayload });

    const sessionId = typeof startPayload["sessionId"] === "string" ? (startPayload["sessionId"] as string) : undefined;
    let snapshotId = typeof startPayload["snapshotId"] === "string" ? (startPayload["snapshotId"] as string) : undefined;
    record(
      "webcheck_start returns sessionId + snapshotId",
      !isToolError(startResult) && sessionId !== undefined && snapshotId !== undefined,
      JSON.stringify(startPayload)
    );

    if (!sessionId || !snapshotId) {
      throw new Error("cannot continue MCP proof: webcheck_start did not return sessionId/snapshotId");
    }

    // 2. webcheck_observe
    const observe1Args = { sessionId };
    const observe1Result = await client.callTool({ name: "webcheck_observe", arguments: observe1Args });
    const observe1Payload = parseToolPayload(observe1Result);
    transcript.push({ tool: "webcheck_observe", request: observe1Args, response: observe1Payload });
    record(
      "webcheck_observe returns elements + matches snapshotId",
      !isToolError(observe1Result) &&
        Array.isArray(observe1Payload["elements"]) &&
        observe1Payload["snapshotId"] === snapshotId,
      JSON.stringify(observe1Payload).slice(0, 300)
    );

    // 3. webcheck_act — fill the email field.
    const actArgs = {
      sessionId,
      snapshotId,
      action: {
        snapshotId,
        type: "fill",
        target: { testId: "email-input" },
        value: "mcp-client@example.com",
        timeoutMs: 3000
      }
    };
    const actResult = await client.callTool({ name: "webcheck_act", arguments: actArgs });
    const actPayload = parseToolPayload(actResult);
    transcript.push({ tool: "webcheck_act", request: actArgs, response: actPayload });
    record(
      "webcheck_act executes fill and returns a new snapshotId",
      !isToolError(actResult) && actPayload["ok"] === true && actPayload["snapshotId"] !== snapshotId,
      JSON.stringify(actPayload).slice(0, 300)
    );

    snapshotId = typeof actPayload["snapshotId"] === "string" ? (actPayload["snapshotId"] as string) : snapshotId;

    // 4. webcheck_observe again — should reflect the post-action snapshot.
    const observe2Args = { sessionId };
    const observe2Result = await client.callTool({ name: "webcheck_observe", arguments: observe2Args });
    const observe2Payload = parseToolPayload(observe2Result);
    transcript.push({ tool: "webcheck_observe", request: observe2Args, response: observe2Payload });
    record(
      "webcheck_observe after act reflects the same post-action snapshotId",
      !isToolError(observe2Result) && observe2Payload["snapshotId"] === snapshotId,
      JSON.stringify(observe2Payload).slice(0, 300)
    );

    // Bonus: prove stale-snapshot rejection over the wire.
    const staleArgs = {
      sessionId,
      snapshotId: "stale-snapshot-id",
      action: {
        snapshotId: "stale-snapshot-id",
        type: "fill",
        target: { testId: "email-input" },
        value: "should-not-apply",
        timeoutMs: 1000
      }
    };
    const staleResult = await client.callTool({ name: "webcheck_act", arguments: staleArgs });
    const stalePayload = parseToolPayload(staleResult);
    transcript.push({ tool: "webcheck_act (stale)", request: staleArgs, response: stalePayload });
    record(
      "webcheck_act rejects a stale snapshotId over MCP",
      isToolError(staleResult) && stalePayload["code"] === "STALE_SNAPSHOT",
      JSON.stringify(stalePayload)
    );
  } finally {
    await client.close().catch(() => undefined);
    await fixture?.close().catch(() => undefined);
  }

  await fs.mkdir(ARTIFACT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(ARTIFACT_DIR, "mcp-proof.json"),
    JSON.stringify({ results, transcript }, null, 2),
    "utf-8"
  );

  console.log("\n=== MCP proof summary ===");
  for (const r of results) {
    console.log(`${r.pass ? "PASS" : "FAIL"}: ${r.name}`);
  }
  if (results.some((r) => !r.pass)) {
    process.exitCode = 1;
  }
}

void main();
