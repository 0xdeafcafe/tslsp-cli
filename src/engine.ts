import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { totalmem } from "node:os";
import { dirname, join } from "node:path";
import { resolveTsgoBin } from "./workspace.js";

export type Engine = "tsrs" | "tsgo";

export interface ServerBin {
  engine: Engine;
  bin: string;
}

/**
 * Which language server to run. `TSLSP_ENGINE=tsrs|tsgo` picks one; unset or
 * `auto` prefers tsrs (the Rust port of tsgo) where its binary is installed.
 * On a 54-module monorepo it held 1.9 GiB where tsgo held 4.6 GiB for the
 * same open files, and loaded them in 5s instead of 30s.
 */
export function resolveServerBin(rootPath: string): ServerBin {
  const want = (process.env.TSLSP_ENGINE ?? "auto").trim().toLowerCase();
  if (want !== "tsgo") {
    const tsrs = resolveTsrsBin(rootPath);
    if (tsrs) return { engine: "tsrs", bin: tsrs };
    if (want === "tsrs") {
      throw new Error(
        `TSLSP_ENGINE=tsrs, but no tsrs binary for ${process.platform}-${process.arch}. ` +
          `Install @maschwenk/tsrs, or unset TSLSP_ENGINE to use tsgo.`,
      );
    }
  }
  return { engine: "tsgo", bin: resolveTsgoBin(rootPath) };
}

/** tsrs ships one binary per platform package; there's none for Windows or Intel macOS. */
function tsrsPlatformPackage(): string | undefined {
  const key = `${process.platform}-${process.arch}`;
  return ["darwin-arm64", "linux-x64", "linux-arm64"].includes(key)
    ? `@maschwenk/tsrs-${key}`
    : undefined;
}

/**
 * The workspace's own tsrs first (its pinned version wins), then ours. The
 * platform binary is run directly: the `tsrs` package's bin is a Node shim,
 * which would sit between us and the process whose memory we watch. It's
 * found through the `tsrs` package, as pnpm doesn't hoist its optional deps.
 */
export function resolveTsrsBin(rootPath: string): string | undefined {
  const pkg = tsrsPlatformPackage();
  if (!pkg) return undefined;
  const fromManifest = (manifest: string): string | undefined => {
    try {
      const own = createRequire(manifest).resolve(`${pkg}/package.json`);
      const bin = join(dirname(own), "tsrs");
      return existsSync(bin) ? bin : undefined;
    } catch {
      return undefined;
    }
  };
  let dir = rootPath;
  for (;;) {
    const manifest = join(dir, "node_modules", "@maschwenk", "tsrs", "package.json");
    const bin = existsSync(manifest) ? fromManifest(manifest) : undefined;
    if (bin) return bin;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  try {
    return fromManifest(createRequire(import.meta.url).resolve("@maschwenk/tsrs/package.json"));
  } catch {
    // Not installed: an optional dependency, skipped where there's no binary.
    return undefined;
  }
}

/**
 * The most memory a language server may hold before tslsp stops it:
 * `TSLSP_MAX_MEMORY_MB`, else a quarter of the machine's, at least 2 GiB.
 * 0 turns the cap off. On 2026-10-23 three tsgo servers held 16.7 of 18 GiB
 * between them and hung the machine until its watchdog panicked.
 */
export function maxServerMemoryBytes(): number {
  const raw = process.env.TSLSP_MAX_MEMORY_MB;
  if (raw !== undefined && raw !== "") {
    const mb = parseInt(raw, 10);
    if (Number.isFinite(mb) && mb >= 0) return mb * 1024 * 1024;
    process.stderr.write(
      `tslsp-cli: ignoring invalid TSLSP_MAX_MEMORY_MB=${JSON.stringify(raw)}\n`,
    );
  }
  return Math.max(2 * 1024 ** 3, Math.floor(totalmem() / 4));
}

/**
 * The memory pid holds, in bytes, as Activity Monitor counts it: on macOS
 * top's MEM is the physical footprint, compressed pages included, which RSS
 * leaves out (a tsgo at 10.7 GiB showed 3.9 GiB of RSS). 0 when unknown.
 */
export async function memoryOf(pid: number): Promise<number> {
  if (process.platform === "linux") {
    try {
      const status = await readFile(`/proc/${pid}/status`, "utf8");
      const kb = /^VmRSS:\s+(\d+)\s+kB/m.exec(status)?.[1];
      return kb ? Number(kb) * 1024 : 0;
    } catch {
      return 0;
    }
  }
  if (process.platform !== "darwin") return 0;
  const out = await new Promise<string>((resolve) =>
    execFile("/usr/bin/top", ["-l", "1", "-pid", String(pid), "-stats", "pid,mem"], (err, stdout) =>
      resolve(err ? "" : stdout),
    ),
  );
  return parseTopMem(out, pid);
}

/** The MEM top printed for pid, in bytes: "10G", "523M+", "88K-". */
export function parseTopMem(out: string, pid: number): number {
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+(?:\.\d+)?)([BKMG])[+-]?\s*$/.exec(line);
    if (!m || Number(m[1]) !== pid) continue;
    const unit = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[m[3] as "B" | "K" | "M" | "G"];
    return Math.round(Number(m[2]) * unit);
  }
  return 0;
}
