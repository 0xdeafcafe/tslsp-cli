import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  DaemonVersionMismatch,
  ensureDaemon,
  sendRequest,
} from "../src/daemon/client.js";
import {
  baseDaemonDir,
  readSession,
  sessionFilePath,
  socketPathFor,
  writeSession,
} from "../src/daemon/registry.js";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const cliBin = resolve(projectRoot, "dist", "cli.js");

let workspace: string;
let cacheDir: string;

beforeAll(() => {
  if (!existsSync(cliBin)) {
    const build = spawnSync("pnpm", ["run", "build"], { cwd: projectRoot, stdio: "inherit" });
    if (build.status !== 0) throw new Error("pnpm run build failed");
  }
  cacheDir = mkdtempSync(resolve(tmpdir(), "tslsp-daemon-test-"));
  process.env.TSLSP_DAEMON_DIR = cacheDir;
  process.env.TSLSP_DAEMON_ENTRY = cliBin;
  // Long enough that ordinary tests never trip the idle reaper. The idle-exit
  // test overrides this with a shorter window when it spawns its own daemon.
  process.env.TSLSP_DAEMON_IDLE_MS = "30000";
});

afterEach(async () => {
  // Stop any daemon still listening for this workspace.
  if (!workspace) return;
  const session = await readSession(workspace, "default");
  if (session) {
    try {
      await sendRequest(session, { method: "stop", params: {} }, 2000);
    } catch {
      // ignore — may already be down
    }
    // Make sure the process is actually gone.
    try {
      process.kill(session.pid, 0);
      process.kill(session.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
});

function freshWorkspace(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "tslsp-daemon-ws-"));
  writeFileSync(resolve(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "es2022" } }));
  return dir;
}

describe("daemon", () => {
  it("autospawns on ensureDaemon and serves ping", async () => {
    workspace = freshWorkspace();
    const session = await ensureDaemon({ workspaceDir: workspace, sessionName: "default", version: "0.1.0" });
    expect(session.socketPath).toContain(cacheDir);
    expect(session.pid).toBeGreaterThan(0);
    expect(existsSync(session.socketPath)).toBe(true);
    expect(existsSync(sessionFilePath(workspace, "default"))).toBe(true);

    const resp = await sendRequest(session, { method: "ping", params: {} });
    expect(resp).toEqual({ ok: true, text: "pong" });
  });

  it("recovers from a stale .session pointing at a dead socket", async () => {
    workspace = freshWorkspace();
    // Plant a stale session pointing at a socket that doesn't exist.
    await fs.mkdir(dirname(sessionFilePath(workspace, "default")), { recursive: true });
    await writeSession(workspace, {
      name: "default",
      version: "0.1.0",
      socketPath: socketPathFor(workspace, "default"),
      pid: 999999,
      workspaceDir: workspace,
      createdAt: 0,
    });

    const session = await ensureDaemon({ workspaceDir: workspace, sessionName: "default", version: "0.1.0" });
    // The pid in the rewritten .session should be the real (live) daemon, not our planted one.
    expect(session.pid).not.toBe(999999);

    const resp = await sendRequest(session, { method: "ping", params: {} });
    expect(resp).toEqual({ ok: true, text: "pong" });
  });

  it("stops on `stop` request and deletes the .session", async () => {
    workspace = freshWorkspace();
    const session = await ensureDaemon({ workspaceDir: workspace, sessionName: "default", version: "0.1.0" });

    const stopResp = await sendRequest(session, { method: "stop", params: {} });
    expect(stopResp).toEqual({ ok: true, text: "stopping" });

    // Wait for daemon to actually exit.
    for (let i = 0; i < 50; i++) {
      try {
        process.kill(session.pid, 0);
      } catch {
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(() => process.kill(session.pid, 0)).toThrow();
    expect(existsSync(sessionFilePath(workspace, "default"))).toBe(false);
  });

  it("self-exits after idle timeout", async () => {
    workspace = freshWorkspace();
    const prev = process.env.TSLSP_DAEMON_IDLE_MS;
    process.env.TSLSP_DAEMON_IDLE_MS = "1500";
    try {
      const session = await ensureDaemon({ workspaceDir: workspace, sessionName: "default", version: "0.1.0" });

      // Reaper interval = max(1s, idle/4). Wait > idle + one tick.
      await new Promise((r) => setTimeout(r, 3000));

      let alive = true;
      try {
        process.kill(session.pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
      expect(existsSync(sessionFilePath(workspace, "default"))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.TSLSP_DAEMON_IDLE_MS;
      else process.env.TSLSP_DAEMON_IDLE_MS = prev;
    }
  });

  it("refuses to talk to an older daemon (version mismatch)", async () => {
    workspace = freshWorkspace();
    // Start a daemon as if it were a future version.
    await ensureDaemon({ workspaceDir: workspace, sessionName: "default", version: "0.1.0" });
    // Client claims to be newer than the daemon.
    await expect(
      ensureDaemon({ workspaceDir: workspace, sessionName: "default", version: "0.2.0" }),
    ).rejects.toBeInstanceOf(DaemonVersionMismatch);
  });

  it("baseDaemonDir respects TSLSP_DAEMON_DIR override", () => {
    expect(baseDaemonDir()).toBe(cacheDir);
  });
});
