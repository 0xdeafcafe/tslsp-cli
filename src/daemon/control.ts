import { canConnect, ensureDaemon, sendRequest } from "./client.js";
import {
  deleteSession,
  listAllSessions,
  readSession,
  SessionFile,
} from "./registry.js";

/**
 * Daemon-management helpers used by the `start`/`stop`/`restart`/`list`/
 * `kill-all` subcommands. These bypass the daemon's `run` dispatch — they
 * inspect and manipulate daemon processes directly.
 */

export interface StartResult {
  /** false when an already-running daemon was reused. */
  spawned: boolean;
  session: SessionFile;
}

export async function startDaemon(
  workspaceDir: string,
  sessionName: string,
  version: string,
): Promise<StartResult> {
  const existing = await readSession(workspaceDir, sessionName);
  if (existing && (await canConnect(existing.socketPath))) {
    return { spawned: false, session: existing };
  }
  const session = await ensureDaemon({ workspaceDir, sessionName, version });
  return { spawned: true, session };
}

export interface StopResult {
  /** false when no daemon was found. */
  wasRunning: boolean;
  /** ms we waited for the daemon process to actually exit. */
  waited?: number;
}

export async function stopDaemon(
  workspaceDir: string,
  sessionName: string,
  timeoutMs = 5_000,
): Promise<StopResult> {
  const session = await readSession(workspaceDir, sessionName);
  if (!session) return { wasRunning: false };
  // First try the graceful `stop` RPC. If the socket is dead, fall through.
  try {
    if (await canConnect(session.socketPath)) {
      await sendRequest(session, { method: "stop", params: {} }, Math.min(2000, timeoutMs));
    }
  } catch {
    // Fall through to SIGTERM.
  }
  const exited = await waitForProcessExit(session.pid, timeoutMs);
  if (!exited) {
    try {
      process.kill(session.pid, "SIGTERM");
    } catch {
      // already gone
    }
    await waitForProcessExit(session.pid, 2_000);
  }
  await deleteSession(workspaceDir, sessionName);
  return { wasRunning: true };
}

export async function restartDaemon(
  workspaceDir: string,
  sessionName: string,
  version: string,
): Promise<{ stopped: boolean; session: SessionFile }> {
  const stop = await stopDaemon(workspaceDir, sessionName);
  const session = await ensureDaemon({ workspaceDir, sessionName, version });
  return { stopped: stop.wasRunning, session };
}

export interface LiveDaemon extends SessionFile {
  alive: boolean;
}

export async function listLiveDaemons(): Promise<LiveDaemon[]> {
  const all = await listAllSessions();
  return Promise.all(
    all.map(async (s) => ({ ...s, alive: await canConnect(s.socketPath) })),
  );
}

export interface KillAllResult {
  killed: number;
  cleanedSessions: number;
}

export async function killAllDaemons(): Promise<KillAllResult> {
  const all = await listAllSessions();
  let killed = 0;
  let cleaned = 0;
  for (const s of all) {
    try {
      process.kill(s.pid, "SIGKILL");
      killed++;
    } catch {
      // pid already gone or not ours
    }
    await deleteSession(s.workspaceDir, s.name).catch(() => {});
    cleaned++;
  }
  return { killed, cleanedSessions: cleaned };
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}
