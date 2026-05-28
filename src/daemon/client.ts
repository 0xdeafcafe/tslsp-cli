import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import {
  deleteSession,
  ensureProfilesDir,
  errLogPath,
  readSession,
  SessionFile,
} from "./registry.js";
import type { Request, Response } from "./protocol.js";

export interface EnsureOptions {
  workspaceDir: string;
  sessionName: string;
  /** Client's tslsp version; used to refuse talking to an older daemon. */
  version: string;
}

export class DaemonVersionMismatch extends Error {
  constructor(
    public readonly clientVersion: string,
    public readonly daemonVersion: string,
    public readonly sessionName: string,
  ) {
    super(
      `Daemon is v${daemonVersion}; client is v${clientVersion}. ` +
        `Run \`tslsp restart${sessionName !== "default" ? ` --session ${sessionName}` : ""}\` to upgrade the daemon.`,
    );
  }
}

/**
 * Make sure a daemon is running for this workspace/session. Autospawns if
 * none. Cleans up stale .session files left by a crashed daemon.
 *
 * Throws DaemonVersionMismatch when the running daemon is older than the
 * client — never auto-restarts (would race in-flight calls; phase plan calls
 * for explicit `tslsp restart`).
 */
export async function ensureDaemon(opts: EnsureOptions): Promise<SessionFile> {
  const existing = await readSession(opts.workspaceDir, opts.sessionName);
  if (existing && (await canConnect(existing.socketPath))) {
    if (compareVersion(opts.version, existing.version) > 0) {
      throw new DaemonVersionMismatch(opts.version, existing.version, opts.sessionName);
    }
    return existing;
  }
  // Stale session file or never started. Clean and spawn.
  await deleteSession(opts.workspaceDir, opts.sessionName);
  return await spawnDaemon(opts);
}

async function spawnDaemon(opts: EnsureOptions): Promise<SessionFile> {
  await ensureProfilesDir(opts.workspaceDir);
  const errFd = openSync(errLogPath(opts.workspaceDir, opts.sessionName), "w");
  const args = [
    daemonEntryPoint(),
    "daemon",
    "serve",
    "--session",
    opts.sessionName,
    "--workspace",
    opts.workspaceDir,
  ];

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", "pipe", errFd],
    cwd: opts.workspaceDir,
  });

  await new Promise<void>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => {
      reject(new Error(`daemon spawn timed out after 10s (pid=${child.pid})`));
    }, 10_000);
    const onData = (chunk: Buffer) => {
      out += chunk.toString("utf8");
      if (!out.includes("<EOF>")) return;
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      const errMatch = out.match(/### Error\n([\s\S]*)<EOF>/);
      if (errMatch) {
        reject(new Error(`daemon failed to start: ${errMatch[1]?.trim() ?? "unknown"}`));
        return;
      }
      if (out.includes("### Ready")) {
        resolve();
        return;
      }
      reject(new Error(`daemon emitted unexpected handshake:\n${out}`));
    };
    child.stdout?.on("data", onData);
    child.once("close", (code) => {
      clearTimeout(timer);
      reject(new Error(`daemon exited with code ${code} before ready`));
    });
  });

  child.stdout?.destroy();
  child.unref();

  // Re-read so we hand back the file the daemon actually wrote (pid, socketPath).
  const session = await readSession(opts.workspaceDir, opts.sessionName);
  if (!session) {
    throw new Error("daemon reported ready but .session is missing — likely a race; retry");
  }
  return session;
}

export async function canConnect(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection(socketPath);
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
}

export async function sendRequest(
  session: SessionFile,
  request: Request,
  timeoutMs = 60_000,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const s = createConnection(session.socketPath);
    let buf = "";
    s.setEncoding("utf8");
    const timer = setTimeout(() => {
      s.destroy();
      reject(new Error(`daemon request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    s.on("connect", () => s.write(JSON.stringify(request) + "\n"));
    s.on("data", (chunk) => {
      buf += chunk;
    });
    s.on("end", () => {
      clearTimeout(timer);
      try {
        const nl = buf.indexOf("\n");
        const line = nl >= 0 ? buf.slice(0, nl) : buf;
        resolve(JSON.parse(line) as Response);
      } catch (e) {
        reject(e);
      }
    });
    s.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/**
 * Locate the bin entry that re-invokes us in daemon-serve mode. The `tslsp`
 * CLI lives at dist/cli.js. Tests can override via TSLSP_DAEMON_ENTRY.
 */
function daemonEntryPoint(): string {
  if (process.env.TSLSP_DAEMON_ENTRY) return process.env.TSLSP_DAEMON_ENTRY;
  return fileURLToPath(new URL("../cli.js", import.meta.url));
}

function compareVersion(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}
