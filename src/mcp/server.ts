import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { BrowserSession, StaleSnapshotError } from "../engine/browser-session.ts";
import { summarizeElements } from "../engine/observer.ts";
import { ActInputSchema, BrowserActionSchema } from "../schemas/action.ts";
import { ObserveInputSchema } from "../schemas/observe.ts";
import { StartInputSchema } from "../schemas/start.ts";

const MAX_ARIA_SNAPSHOT_CHARS = 4000;

// Phase 0 only supports a single active run at a time (MVP_PLAN.MD §6.1).
let activeSession: BrowserSession | undefined;

function truncate(text: string, max = MAX_ARIA_SNAPSHOT_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[truncated ${text.length - max} more characters]`;
}

function okResult(payload: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload
  };
}

function errorResult(code: string, message: string): CallToolResult {
  const payload = { code, message };
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: true
  };
}

function classifyStartError(err: unknown): { code: string; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  if (/URL policy denial/.test(message)) return { code: "POLICY_DENIED", message };
  if (/browserType\.launch|Executable doesn't exist/.test(message)) {
    return { code: "BROWSER_LAUNCH_FAILURE", message };
  }
  if (/net::ERR_|page\.goto|Timeout.*exceeded/.test(message)) {
    return { code: "ENV_FAILURE", message };
  }
  return { code: "CONFIGURATION_FAILURE", message };
}

function classifyActFailureKind(kind: string | undefined): string {
  switch (kind) {
    case "target_not_found":
      return "TARGET_NOT_FOUND";
    case "action_timeout":
      return "ACTION_TIMEOUT";
    case "policy_denied":
      return "POLICY_DENIED";
    default:
      return "ACTION_FAILURE";
  }
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "webcheck-agent-phase0", version: "0.0.0" });

  server.registerTool(
    "webcheck_start",
    {
      title: "Start a WebCheck session",
      description:
        "Launches Chromium, navigates to a loopback URL (localhost/127.0.0.1/::1 only) and returns the initial snapshot.",
      inputSchema: StartInputSchema.shape
    },
    async (input) => {
      if (activeSession) {
        return errorResult(
          "SESSION_ALREADY_ACTIVE",
          `a session (${activeSession.sessionId}) is already active; only one active run is allowed in Phase 0`
        );
      }

      try {
        const { session, snapshot } = await BrowserSession.start(input.url, {
          ...(input.headless !== undefined ? { headless: input.headless } : {})
        });
        activeSession = session;
        return okResult({
          sessionId: session.sessionId,
          url: snapshot.url,
          snapshotId: snapshot.snapshotId
        });
      } catch (err) {
        const { code, message } = classifyStartError(err);
        return errorResult(code, message);
      }
    }
  );

  server.registerTool(
    "webcheck_observe",
    {
      title: "Observe the current page",
      description:
        "Returns URL, title, current snapshotId, a sanitized AI accessibility snapshot and a compact semantic element summary.",
      inputSchema: ObserveInputSchema.shape
    },
    async (input) => {
      if (!activeSession) {
        return errorResult("SESSION_NOT_FOUND", "no active session; call webcheck_start first");
      }
      if (input.sessionId !== activeSession.sessionId) {
        return errorResult(
          "SESSION_NOT_FOUND",
          `sessionId "${input.sessionId}" does not match the active session`
        );
      }

      try {
        const snapshot = await activeSession.observeWithoutAdvancing();
        return okResult({
          url: snapshot.url,
          title: snapshot.title,
          snapshotId: snapshot.snapshotId,
          ariaSnapshot: truncate(snapshot.ariaSnapshot),
          elements: summarizeElements(snapshot.ariaSnapshot)
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult("BROWSER_FAILURE", message);
      }
    }
  );

  server.registerTool(
    "webcheck_act",
    {
      title: "Execute one browser action",
      description:
        "Executes exactly one click/fill/navigate action against the current snapshot. Rejects stale snapshotIds. No arbitrary JavaScript, no coordinates.",
      inputSchema: {
        sessionId: z.string(),
        snapshotId: z.string(),
        action: BrowserActionSchema
      }
    },
    async (input) => {
      if (!activeSession) {
        return errorResult("SESSION_NOT_FOUND", "no active session; call webcheck_start first");
      }
      if (input.sessionId !== activeSession.sessionId) {
        return errorResult(
          "SESSION_NOT_FOUND",
          `sessionId "${input.sessionId}" does not match the active session`
        );
      }

      const parsed = ActInputSchema.safeParse(input);
      if (!parsed.success) {
        return errorResult("CONFIGURATION_FAILURE", parsed.error.message);
      }

      try {
        const outcome = await activeSession.act(parsed.data.action);
        const payload: Record<string, unknown> = {
          ok: outcome.result.ok,
          type: outcome.result.type,
          retried: outcome.retried,
          snapshotId: outcome.snapshot.snapshotId,
          url: outcome.snapshot.url,
          ariaSnapshot: truncate(outcome.snapshot.ariaSnapshot),
          elements: summarizeElements(outcome.snapshot.ariaSnapshot)
        };
        if (!outcome.result.ok) {
          payload["failureKind"] = classifyActFailureKind(outcome.result.failureKind);
          payload["error"] = outcome.result.error;
        }
        return outcome.result.ok ? okResult(payload) : { ...okResult(payload), isError: true };
      } catch (err) {
        if (err instanceof StaleSnapshotError) {
          return errorResult("STALE_SNAPSHOT", err.message);
        }
        const message = err instanceof Error ? err.message : String(err);
        return errorResult("BROWSER_FAILURE", message);
      }
    }
  );

  return server;
}

export async function closeActiveSession(): Promise<void> {
  if (activeSession) {
    await activeSession.close();
    activeSession = undefined;
  }
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();

  const shutdown = async () => {
    await closeActiveSession();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await server.connect(transport);
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  void main();
}
