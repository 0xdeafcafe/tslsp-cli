import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

export interface SessionFile {
  /** Session name; "default" if none specified by caller. */
  name: string;
  /** Daemon's tslsp version. Used for version-mismatch checks at client time. */
  version: string;
  /** Path the daemon is listening on. Unix socket; named pipe on Windows. */
  socketPath: string;
  /** Daemon's pid. Used by `tslsp kill-all` for SIGKILL fallback. */
  pid: number;
  /** Absolute path to the tsconfig.json directory the daemon is bound to. */
  workspaceDir: string;
  /** ms since epoch. */
  createdAt: number;
}

export function baseDaemonDir(): string {
  if (process.env.TSLSP_DAEMON_DIR) return process.env.TSLSP_DAEMON_DIR;
  const home = homedir();
  if (platform() === "darwin") return join(home, "Library", "Caches", "tslsp", "daemon");
  if (platform() === "win32") {
    const local = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
    return join(local, "tslsp", "daemon");
  }
  return join(process.env.XDG_CACHE_HOME || join(home, ".cache"), "tslsp", "daemon");
}

export function workspaceHash(workspaceDir: string): string {
  return createHash("sha1").update(workspaceDir).digest("hex").substring(0, 16);
}

export function profilesDirFor(workspaceDir: string): string {
  return join(baseDaemonDir(), workspaceHash(workspaceDir));
}

export function sessionFilePath(workspaceDir: string, sessionName: string): string {
  return join(profilesDirFor(workspaceDir), `${sessionName}.session`);
}

export function socketPathFor(workspaceDir: string, sessionName: string): string {
  // macOS AF_UNIX path limit is 104 chars. We keep paths short by design
  // (cache dir + 16-char hash + short name) but a long homedir could still
  // overflow — callers should sanity-check before binding.
  return join(profilesDirFor(workspaceDir), `${sessionName}.sock`);
}

export function errLogPath(workspaceDir: string, sessionName: string): string {
  return join(profilesDirFor(workspaceDir), `${sessionName}.err`);
}

export async function readSession(
  workspaceDir: string,
  sessionName: string,
): Promise<SessionFile | undefined> {
  try {
    const data = await fs.readFile(sessionFilePath(workspaceDir, sessionName), "utf8");
    return JSON.parse(data) as SessionFile;
  } catch {
    return undefined;
  }
}

export async function writeSession(workspaceDir: string, session: SessionFile): Promise<void> {
  await fs.mkdir(profilesDirFor(workspaceDir), { recursive: true });
  await fs.writeFile(
    sessionFilePath(workspaceDir, session.name),
    JSON.stringify(session, null, 2),
    "utf8",
  );
}

export async function deleteSession(workspaceDir: string, sessionName: string): Promise<void> {
  await fs.rm(sessionFilePath(workspaceDir, sessionName), { force: true });
  // Best-effort socket cleanup. Server unlinks on graceful shutdown; this
  // catches the "previous run crashed" case.
  await fs.rm(socketPathFor(workspaceDir, sessionName), { force: true });
}

export async function listAllSessions(): Promise<SessionFile[]> {
  const base = baseDaemonDir();
  const out: SessionFile[] = [];
  let hashes: string[];
  try {
    hashes = await fs.readdir(base);
  } catch {
    return out;
  }
  for (const hash of hashes) {
    let files: string[];
    try {
      files = await fs.readdir(join(base, hash));
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".session")) continue;
      try {
        const data = await fs.readFile(join(base, hash, file), "utf8");
        out.push(JSON.parse(data) as SessionFile);
      } catch {
        // Skip corrupt session files.
      }
    }
  }
  return out;
}

export async function ensureProfilesDir(workspaceDir: string): Promise<void> {
  await fs.mkdir(profilesDirFor(workspaceDir), { recursive: true });
}

// Re-exported helper so callers can wipe a whole workspace's daemon footprint.
export async function deleteProfilesDir(workspaceDir: string): Promise<void> {
  await fs.rm(profilesDirFor(workspaceDir), { recursive: true, force: true });
}

export function dirOf(p: string): string {
  return dirname(p);
}
