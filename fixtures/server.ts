import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");

const DEFAULT_PORT = 4300;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8"
};

export interface FixtureServerHandle {
  url: string;
  port: number;
  close: () => Promise<void>;
}

/**
 * "buggy" (default) preserves every existing Phase 0-3B fixture behavior
 * unchanged. "fixed" is a minimal, deterministic toggle added for Phase
 * 4A's fail-on-bug/pass-on-fix regression-test verification — it makes
 * the same triggering actions (force-error checkbox, transport-fail
 * button, throw-error button) behave correctly instead of reproducing
 * the bug, without changing which DOM elements exist or how flows target
 * them, so the *same* scripted flow / generated test replays against
 * both modes unmodified.
 */
export type FixtureMode = "buggy" | "fixed";

export interface FixtureServerOptions {
  mode?: FixtureMode;
}

interface LoginRequestBody {
  email?: string;
  password?: string;
  forceError?: boolean;
}

function readJsonBody(req: IncomingMessage): Promise<LoginRequestBody> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
        resolve((parsed ?? {}) as LoginRequestBody);
      } catch (err) {
        reject(err instanceof Error ? err : new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

async function serveStatic(reqPath: string, res: ServerResponse, mode: FixtureMode): Promise<void> {
  const relativePath = reqPath === "/" ? "index.html" : reqPath.replace(/^\/+/, "");
  const resolved = path.join(PUBLIC_DIR, relativePath);

  // Reject any traversal outside the public directory.
  if (!resolved.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  try {
    const body = await fs.readFile(resolved);
    const ext = path.extname(resolved);
    const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";

    // Only index.html carries the mode flag — every other static asset
    // (app.js, styles.css) is served byte-identical regardless of mode,
    // so the fixture's DOM/markup never differs between "buggy" and
    // "fixed", only the runtime behavior app.js reads at startup.
    if (path.basename(resolved) === "index.html") {
      const withMode = body
        .toString("utf-8")
        .replace(
          "<script src=\"/app.js\"></script>",
          `<script>window.__WEBCHECK_FIXTURE_MODE__ = ${JSON.stringify(mode)};</script>\n    <script src="/app.js"></script>`
        );
      res.writeHead(200, { "Content-Type": contentType }).end(withMode);
      return;
    }

    res.writeHead(200, { "Content-Type": contentType }).end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
  }
}

async function handleLogin(req: IncomingMessage, res: ServerResponse, mode: FixtureMode): Promise<void> {
  let body: LoginRequestBody;
  try {
    body = await readJsonBody(req);
  } catch {
    res
      .writeHead(400, { "Content-Type": "application/json" })
      .end(JSON.stringify({ error: "Invalid JSON body" }));
    return;
  }

  // In "fixed" mode the server ignores forceError entirely — the same
  // scripted flow (which still sends forceError: true) reproduces the
  // bug in "buggy" mode and no longer reproduces it in "fixed" mode,
  // without the flow itself changing.
  if (body.forceError === true && mode === "buggy") {
    res
      .writeHead(500, { "Content-Type": "application/json" })
      .end(JSON.stringify({ error: "Internal Server Error" }));
    return;
  }

  res
    .writeHead(200, { "Content-Type": "application/json" })
    .end(JSON.stringify({ ok: true, email: body.email ?? null }));
}

function handleTransportFail(req: IncomingMessage, res: ServerResponse, mode: FixtureMode): void {
  if (mode === "fixed") {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
    return;
  }

  // No HTTP response is written at all: the raw socket is torn down mid
  // request, producing a genuine transport-level failure (e.g.
  // net::ERR_EMPTY_RESPONSE / net::ERR_CONNECTION_RESET) rather than an
  // HTTP error status. This does not depend on internet access.
  req.socket.destroy();
}

function handleSensitive(res: ServerResponse): void {
  // Evidence-pipeline fixture: exists purely so a flow can trigger a
  // request whose URL carries sensitive-looking query parameters, to
  // prove the network collector's URL redaction end to end. The response
  // itself carries nothing sensitive.
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
}

function requestListener(req: IncomingMessage, res: ServerResponse, mode: FixtureMode): void {
  const url = req.url ?? "/";

  if (url === "/api/transport-fail") {
    handleTransportFail(req, res, mode);
    return;
  }

  if (url === "/api/login" && req.method === "POST") {
    void handleLogin(req, res, mode);
    return;
  }

  if (url.startsWith("/api/sensitive")) {
    handleSensitive(res);
    return;
  }

  if (req.method === "GET") {
    void serveStatic(url, res, mode);
    return;
  }

  res.writeHead(404).end("Not found");
}

function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.removeListener("listening", onListening);
      if (err.code === "EADDRINUSE" && port !== 0) {
        resolve(listen(server, 0));
        return;
      }
      reject(err);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      const address = server.address();
      if (address && typeof address === "object") {
        resolve(address.port);
      } else {
        reject(new Error("Failed to determine fixture server port"));
      }
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

export async function startFixtureServer(
  preferredPort: number = DEFAULT_PORT,
  options: FixtureServerOptions = {}
): Promise<FixtureServerHandle> {
  const mode = options.mode ?? "buggy";
  const server = http.createServer((req, res) => requestListener(req, res, mode));
  const port = await listen(server, preferredPort);
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        // Force-close any lingering sockets (e.g. from the
        // transport-failure route) so close() cannot hang.
        server.closeAllConnections?.();
      })
  };
}

async function main(): Promise<void> {
  const handle = await startFixtureServer();
  // eslint-disable-next-line no-console
  console.log(`Fixture server listening on ${handle.url}`);

  const shutdown = async () => {
    await handle.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  void main();
}
