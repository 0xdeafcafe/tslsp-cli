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

/** Drop matches whose path crosses an ignored segment, UNLESS that segment
 * appears literally in the user's pattern (e.g. someone explicitly globbing
 * `node_modules/**\/*.ts` wants those results — but a broad `**\/*.ts`
 * shouldn't drag generated/dependency code in). */
function patternMentions(pattern: string, segments: Set<string>): Set<string> {
  const mentioned = new Set<string>();
  for (const part of pattern.split(/[\\/]/)) {
    if (segments.has(part)) mentioned.add(part);
  }
  return mentioned;
}

function shouldIgnoreRel(rel: string, allowedSegments?: Set<string>): boolean {
  for (const seg of rel.split(sep)) {
    if (!IGNORE_DIRS.has(seg)) continue;
    if (allowedSegments?.has(seg)) continue;
    return true;
  }
  return false;
}

/** Expand a mixed list of literal files, directories, and globs into a sorted,
 * deduped absolute-path list. Used by tools that take `file`/`files` so the
 * caller can say `outline 'src/**\/*.ts'` or `diagnostics src/api/` instead of
 * enumerating every path first.
 *
 * - Literal file → kept as-is (no existence check; the LSP will error nicely).
 * - Directory → recursive walk, filtered by SOURCE_EXTS, IGNORE_DIRS skipped.
 * - Glob (contains `*`, `?`, `[`, `{`) → resolved via `fs.glob` from cwd, with
 *   the same IGNORE_DIRS + SOURCE_EXTS filters applied so a broad `**\/*.ts`
 *   doesn't drag in `node_modules`/`dist`/etc. matches. */
export async function expandFileArgs(paths: string[], cwd: string): Promise<string[]> {
  const out = new Set<string>();
  for (const raw of paths) {
    if (hasGlobChars(raw)) {
      // Pattern-mentioned segments are an escape hatch: someone who explicitly
      // globs `node_modules/**/*.ts` wants those hits. A broad `**/*.ts` does
      // not, so we still filter that case.
      const allowed = patternMentions(raw, IGNORE_DIRS);
      for await (const match of glob(raw, { cwd })) {
        const m = match as string;
        if (shouldIgnoreRel(m, allowed)) continue;
        const full = abs(m, cwd);
        await collect(full, out);
      }
      continue;
    }
    // Literal: trust the user — they typed it on purpose.
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
  // fs.glob's matches here are relative to `dir`, so `dir` itself never
  // appears in them — the ignore filter only catches sub-directories.
  for await (const rel of glob("**/*", { cwd: dir })) {
    const r = rel as string;
    if (shouldIgnoreRel(r)) continue;
    const dot = r.lastIndexOf(".");
    if (dot < 0) continue;
    const ext = r.slice(dot);
    if (!SOURCE_EXTS.has(ext)) continue;
    into.add(resolve(dir, r));
  }
}
