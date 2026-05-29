import { glob } from "node:fs/promises";
import { statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

/** Source file extensions we'll auto-walk when a directory is given. Matches
 * tsgo's source scope and keeps us from accidentally typechecking generated
 * `.d.ts` from node_modules. */
const SOURCE_EXTS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

/** Directories we skip when walking. Hard-coded — the common cases swamp any
 * legitimate file you'd want from inside them. */
const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", "coverage"]);

const GLOB_CHARS = /[*?[\]{}]/;

function hasGlobChars(p: string): boolean {
  return GLOB_CHARS.test(p);
}

function abs(p: string, cwd: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p);
}

/** Expand a mixed list of literal files, directories, and globs into a sorted,
 * deduped absolute-path list. Used by tools that take `file`/`files` so the
 * caller can say `outline 'src/**\/*.ts'` or `diagnostics src/api/` instead of
 * enumerating every path first.
 *
 * - Literal file → kept as-is (no existence check; the LSP will error nicely).
 * - Directory → recursive walk, filtered by SOURCE_EXTS, IGNORE_DIRS skipped.
 * - Glob (contains `*`, `?`, `[`, `{`) → resolved via `fs.glob` from cwd. */
export async function expandFileArgs(paths: string[], cwd: string): Promise<string[]> {
  const out = new Set<string>();
  for (const raw of paths) {
    if (hasGlobChars(raw)) {
      const pattern = isAbsolute(raw) ? raw : raw;
      for await (const match of glob(pattern, { cwd })) {
        const full = abs(match as string, cwd);
        await collect(full, out);
      }
      continue;
    }
    const full = abs(raw, cwd);
    await collect(full, out);
  }
  return [...out].sort();
}

async function collect(p: string, into: Set<string>): Promise<void> {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(p);
  } catch {
    // Non-existent paths flow through unchanged — let the tool surface the
    // real error (file not found, etc.) with its own messaging.
    into.add(p);
    return;
  }
  if (st.isDirectory()) {
    await walkDir(p, into);
    return;
  }
  into.add(p);
}

async function walkDir(dir: string, into: Set<string>): Promise<void> {
  // Use fs.glob with the directory as cwd so we benefit from its built-in
  // traversal — but apply our own ignore-dir + ext filter on the relative
  // path it yields.
  for await (const rel of glob("**/*", { cwd: dir })) {
    const r = rel as string;
    if (r.split(sep).some((seg) => IGNORE_DIRS.has(seg))) continue;
    const dot = r.lastIndexOf(".");
    if (dot < 0) continue;
    const ext = r.slice(dot);
    if (!SOURCE_EXTS.has(ext)) continue;
    into.add(resolve(dir, r));
  }
}
