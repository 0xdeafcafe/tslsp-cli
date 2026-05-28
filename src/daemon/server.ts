import { promises as fs } from "node:fs";
import { createServer, Server, Socket } from "node:net";
import { z } from "zod";
import { getTool, ToolResult } from "../tools.js";
import { envIdleMs, LspPool } from "../workspace.js";
import { deleteSession, ensureProfilesDir, socketPathFor, writeSession } from "./registry.js";
import type { Request, Response, RunParams } from "./protocol.js";

export interface ServerOptions {
  workspaceDir: string;
  sessionName: string;
  version: string;
  /** Default 30 min. Override via TSLSP_DAEMON_IDLE_MS. */
  idleTimeoutMs?: number;
  /** Where to write the ready handshake. Defaults to process.stdout. */
  readyStream?: NodeJS.WritableStream;
}

const DEFAULT_IDLE_MS = 30 * 60 * 1000;

/**
 * Spawn the long-lived daemon. Resolves once SIGTERM/SIGINT/idle have caused
 * exit — caller normally just `await`s this and lets it terminate the process.
 * In tests we drive it directly and listen for the ready handshake.
 */
export async function serve(opts: ServerOptions): Promise<void> {
  const idleMs = opts.idleTimeoutMs ?? envIdleMs("TSLSP_DAEMON_IDLE_MS", DEFAULT_IDLE_MS);
  const readyStream = opts.readyStream ?? process.stdout;
  const socketPath = socketPathFor(opts.workspaceDir, opts.sessionName);
  // macOS caps AF_UNIX paths at 104 bytes (Linux 108). Bind() would fail with
  // an obscure ENAMETOOLONG; bail early with something a user can act on.
  const SOCKET_PATH_MAX = process.platform === "linux" ? 108 : 104;
  if (Buffer.byteLength(socketPath, "utf8") > SOCKET_PATH_MAX) {
    const msg = `socket path exceeds ${SOCKET_PATH_MAX} bytes (got ${Buffer.byteLength(socketPath, "utf8")}): ${socketPath}. Set TSLSP_DAEMON_DIR to a shorter path.`;
    readyStream.write(`### Error\n${msg}\n<EOF>\n`);
    throw new Error(msg);
  }
  await ensureProfilesDir(opts.workspaceDir);
  // Stale socket from a crashed prior daemon — bind() will EADDRINUSE without
  // this, even though nothing's listening.
  await fs.rm(socketPath, { force: true });

  const verbose = process.env.TSLSP_VERBOSE === "1";
  const log = verbose ? (line: string) => process.stderr.write(line + "\n") : undefined;
  const pool = new LspPool(log);

  let lastActivity = Date.now();
  let activeConnections = 0;
  let shuttingDown = false;

  const server: Server = createServer((socket) => {
    activeConnections++;
    handleConnection(socket).finally(() => {
      activeConnections = Math.max(0, activeConnections - 1);
      lastActivity = Date.now();
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onErr = (e: Error) => {
      server.off("error", onErr);
      // Surface bind errors via the ready handshake so the parent CLI can
      // report something sensible.
      readyStream.write(`### Error\n${e.message}\n<EOF>\n`);
      reject(e);
    };
    server.once("error", onErr);
    server.listen(socketPath, () => {
      server.off("error", onErr);
      resolve();
    });
  });

  await writeSession(opts.workspaceDir, {
    name: opts.sessionName,
    version: opts.version,
    socketPath,
    pid: process.pid,
    workspaceDir: opts.workspaceDir,
    createdAt: Date.now(),
  });

  readyStream.write(`### Ready\nDaemon listening on ${socketPath}\n<EOF>\n`);

  // Resolves only when shutdown() runs — keeps the awaiting caller (and so
  // the process) alive until then. Without this, serve() would resolve right
  // after wiring listeners and process.exit kills the daemon on the spot.
  let resolveUntilShutdown!: () => void;
  const untilShutdown = new Promise<void>((r) => {
    resolveUntilShutdown = r;
  });

  const idleTimer = setInterval(
    () => {
      if (shuttingDown) return;
      if (activeConnections > 0) {
        lastActivity = Date.now();
        return;
      }
      if (Date.now() - lastActivity > idleMs) {
        void shutdown("idle");
      }
    },
    Math.min(30_000, Math.max(1_000, Math.floor(idleMs / 4))),
  );

  const sigTerm = () => void shutdown("SIGTERM");
  const sigInt = () => void shutdown("SIGINT");
  process.on("SIGTERM", sigTerm);
  process.on("SIGINT", sigInt);

  async function shutdown(_reason: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(idleTimer);
    process.off("SIGTERM", sigTerm);
    process.off("SIGINT", sigInt);
    server.close();
    await deleteSession(opts.workspaceDir, opts.sessionName).catch(() => {});
    await pool.disposeAll().catch(() => {});
    resolveUntilShutdown();
  }

  await untilShutdown;

  async function handleConnection(socket: Socket): Promise<void> {
    socket.setEncoding("utf8");
    const line = await readLine(socket);
    if (line === undefined) {
      socket.destroy();
      return;
    }

    let req: Request;
    try {
      req = JSON.parse(line) as Request;
    } catch (e) {
      writeResponse(socket, {
        ok: false,
        error: `bad request: ${(e as Error).message}`,
        exitCode: 1,
      });
      return;
    }

    try {
      if (req.method === "ping") {
        writeResponse(socket, { ok: true, text: "pong" });
        return;
      }
      if (req.method === "stop") {
        writeResponse(socket, { ok: true, text: "stopping" });
        // Let the response flush before exiting.
        setTimeout(() => void shutdown("stop"), 10);
        return;
      }
      if (req.method === "run") {
        const result = await dispatchRun(pool, req.params);
        if (result.exitCode && result.exitCode !== 0) {
          writeResponse(socket, { ok: false, error: result.text, exitCode: result.exitCode });
        } else {
          writeResponse(socket, { ok: true, text: result.text, exitCode: result.exitCode });
        }
        return;
      }
      writeResponse(socket, {
        ok: false,
        error: `unknown method: ${(req as { method: string }).method}`,
        exitCode: 1,
      });
    } catch (e) {
      writeResponse(socket, {
        ok: false,
        error: String((e as Error).message ?? e),
        exitCode: 1,
      });
    }
  }
}

function writeResponse(socket: Socket, resp: Response): void {
  socket.end(JSON.stringify(resp) + "\n");
}

/**
 * Map a wire `run` request to the matching tool in the shared TOOLS registry.
 * The CLI client already parsed + zod-validated args; we re-validate here so a
 * misbehaving client (or version skew) can't slip past the schema.
 */
async function dispatchRun(
  pool: LspPool,
  params: RunParams,
): Promise<ToolResult & { exitCode?: number }> {
  // Registry names are snake_case; clients should normally send the literal
  // name, but the CLI's help renderer shows kebab-case, so accept either.
  // Try literal first so a future tool with `-` in its name isn't mangled.
  const tool = getTool(params.cmd) ?? getTool(params.cmd.replace(/-/g, "_"));
  if (!tool) {
    return { text: `unknown cmd: ${params.cmd}`, isError: true, exitCode: 1 };
  }
  let validated: Record<string, unknown>;
  try {
    const schema = z.object(tool.inputSchema as z.ZodRawShape);
    validated = schema.parse(params.args) as Record<string, unknown>;
  } catch (e) {
    const msg = e instanceof z.ZodError ? formatZodError(e) : String((e as Error).message ?? e);
    return { text: msg, isError: true, exitCode: 2 };
  }
  const result = await tool.handler(validated as never, { pool, cwd: params.cwd });
  return { ...result, exitCode: result.isError ? 1 : 0 };
}

function formatZodError(e: z.ZodError): string {
  return e.issues
    .map((iss) => {
      const path = iss.path.length ? iss.path.join(".") : "<arg>";
      return `invalid ${String(path)}: ${iss.message}`;
    })
    .join("\n");
}

async function readLine(socket: Socket): Promise<string | undefined> {
  return new Promise((resolve) => {
    let buf = "";
    const onData = (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        socket.off("data", onData);
        resolve(buf.slice(0, nl));
      }
    };
    socket.on("data", onData);
    socket.once("end", () => resolve(buf || undefined));
    socket.once("error", () => resolve(undefined));
  });
}
