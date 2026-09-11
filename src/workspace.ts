import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { LspClient } from "./lsp-client.js";
import { describeTsBinary, resolveTsBinary, type ResolvedTsBinary } from "./ts-binary.js";

/** Walk up from `start` looking for the nearest tsconfig.json. */
export function findProjectRoot(start: string): string | undefined {
  let dir = isAbsolute(start) ? start : resolve(start);
  try {
    if (statSync(dir).isFile()) dir = dirname(dir);
  } catch {
    // Path may not exist yet — fall back to its parent dir.
    dir = dirname(dir);
  }
  for (;;) {
    if (existsSync(join(dir, "tsconfig.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Resolve the TypeScript binary for a project root and announce it once.
 *
 * Kept as a thin wrapper so the pool has a single seam and the announcement
 * happens exactly where a server is about to be spawned.
 */
export function resolveServerBin(rootPath: string): string {
  const bin = resolveTsBinary(rootPath);
  announceTsBinary(bin);
  return bin.path;
}

const announced = new Set<string>();

/** One line per distinct binary per process — not once per spawned server. */
export function announceTsBinary(bin: ResolvedTsBinary): void {
  if (announced.has(bin.path)) return;
  announced.add(bin.path);
  process.stderr.write(`${describeTsBinary(bin)}\n`);
}

export interface LspPoolOptions {
  log?: (line: string) => void;
  /**
   * Reap any server idle longer than this. The daemon as a whole has its own
   * idle timeout — this is finer-grained, so a daemon serving a monorepo can
   * release a per-package server without tearing down the daemon. 0 disables.
   * Default: 10 min. Override via TSLSP_SERVER_IDLE_MS.
   */
  serverIdleMs?: number;
}

const DEFAULT_SERVER_IDLE_MS = 10 * 60 * 1000;

/**
 * Parse a non-negative integer env var, falling back to a default with a
 * stderr warning on garbage. Setting `setInterval(_, NaN)` in Node coerces
 * to 1ms — a tight reaper loop. Don't do that.
 */
export function envIdleMs(name: string, defaultMs: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultMs;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    process.stderr.write(
      `tslsp-cli: ignoring invalid ${name}=${JSON.stringify(raw)}; using default ${defaultMs}ms\n`,
    );
    return defaultMs;
  }
  return n;
}

export class LspPool {
  private clients = new Map<string, LspClient>();
  private lastUsed = new Map<string, number>();
  private reapTimer?: NodeJS.Timeout;
  private log?: (line: string) => void;
  private serverIdleMs: number;

  constructor(optsOrLog?: LspPoolOptions | ((line: string) => void)) {
    const opts: LspPoolOptions =
      typeof optsOrLog === "function" ? { log: optsOrLog } : (optsOrLog ?? {});
    this.log = opts.log;
    this.serverIdleMs =
      opts.serverIdleMs ?? envIdleMs("TSLSP_SERVER_IDLE_MS", DEFAULT_SERVER_IDLE_MS);
    if (this.serverIdleMs > 0) {
      // Check 4× per idle window, capped at every 30s.
      const interval = Math.min(30_000, Math.max(1_000, Math.floor(this.serverIdleMs / 4)));
      this.reapTimer = setInterval(() => this.reapIdle(), interval);
      // Don't keep the event loop alive just for the reaper.
      this.reapTimer.unref?.();
    }
  }

  /** Resolve a file path to its LSP client, spawning one if needed. */
  async forFile(filePath: string): Promise<{ client: LspClient; root: string }> {
    const abs = isAbsolute(filePath) ? filePath : resolve(filePath);
    const root = findProjectRoot(abs);
    if (!root) {
      throw new Error(
        `no tsconfig.json found walking up from ${abs}. tslsp-cli routes by tsconfig root.`,
      );
    }
    const client = await this.getOrCreate(root);
    this.lastUsed.set(root, Date.now());
    return { client, root };
  }

  /** Resolve by an explicit project root (used for workspace/symbol with no file hint). */
  async forRoot(rootPath: string): Promise<LspClient> {
    const client = await this.getOrCreate(rootPath);
    this.lastUsed.set(rootPath, Date.now());
    return client;
  }

  /**
   * Look up or spawn the LspClient for `root`, then await its readiness and
   * seed. On failure: evict the client from the cache + dispose it so a retry
   * spawns a fresh server instead of reusing a broken one.
   */
  private async getOrCreate(root: string): Promise<LspClient> {
    let client = this.clients.get(root);
    const fresh = !client;
    if (!client) {
      const bin = resolveServerBin(root);
      client = new LspClient({ binPath: bin, rootPath: root, log: this.log });
      this.clients.set(root, client);
    }
    try {
      await client.ready();
      await client.ensureProjectSeeded();
      return client;
    } catch (e) {
      // Only evict if we just created it; otherwise a transient failure on
      // an existing cached client would needlessly tear down a healthy pool.
      if (fresh) {
        this.clients.delete(root);
        this.lastUsed.delete(root);
        await client.dispose().catch(() => {});
      }
      throw e;
    }
  }

  roots(): string[] {
    return [...this.clients.keys()];
  }

  async disposeAll(): Promise<void> {
    if (this.reapTimer) clearInterval(this.reapTimer);
    this.reapTimer = undefined;
    await Promise.allSettled([...this.clients.values()].map((c) => c.dispose()));
    this.clients.clear();
    this.lastUsed.clear();
  }

  private reapIdle(): void {
    if (this.serverIdleMs <= 0 || this.clients.size === 0) return;
    const now = Date.now();
    for (const [root, ts] of this.lastUsed) {
      if (now - ts <= this.serverIdleMs) continue;
      const client = this.clients.get(root);
      if (!client) {
        this.lastUsed.delete(root);
        continue;
      }
      this.log?.(`[lsp-pool] reaping idle server for ${root}`);
      this.clients.delete(root);
      this.lastUsed.delete(root);
      // Fire-and-forget; dispose is best-effort.
      void client.dispose().catch(() => {});
    }
  }
}
