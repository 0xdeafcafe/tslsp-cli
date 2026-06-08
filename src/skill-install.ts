import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface InstallOpts {
  scope: "user" | "project";
  force: boolean;
  /** If true, also append a one-line nudge to CLAUDE.md so Claude routes
   * identifier work through this CLI even without re-reading SKILL.md. */
  withClaudeMd?: boolean;
  /** Codex parallel to `withClaudeMd`. Appends the same nudge block to
   * AGENTS.md (project: `./AGENTS.md`; user: `~/.codex/AGENTS.md`). */
  withAgentsMd?: boolean;
  cwd?: string;
}

export interface InstallResult {
  ok: boolean;
  lines: string[];
}

const NUDGE_MARKER = "<!-- tslsp-cli:auto-nudge -->";
// Shared by CLAUDE.md (Claude Code) and AGENTS.md (Codex et al.). Phrasing is
// deliberately agent-neutral — no `Grep` / `Edit` / `MultiEdit` / `Read` (those
// are Claude Code tool names that don't exist in Codex), and no reference to
// the `.claude/skills/...` install path (which Codex doesn't write). One
// canonical block means future edits don't drift between the two files.
const NUDGE_BLOCK = [
  "## TypeScript / JavaScript",
  "",
  "For any TS/JS identifier work in a `tsconfig.json` project, use `tslsp-cli` instead of grep, string-edit, `mv` / `git mv`, or `tsc`. tsgo actually understands the program; text tools see characters.",
  "",
  "- find usages → `tslsp-cli references --symbol NAME`",
  "- jump to definition → `tslsp-cli definition --symbol NAME`",
  "- rename → `tslsp-cli rename --symbol OLD --new-name NEW --dry-run` then drop `--dry-run`",
  "- move a file → `tslsp-cli rename-file OLD NEW` (rewrites every import)",
  "- type-check a file → `tslsp-cli diagnostics --file FILE`",
  "- look around a big file → `tslsp-cli outline FILE` before reading the whole thing",
  "",
  "grep is type-blind and lies about identifiers; a string-edit rename misses re-exports and ships broken refactors. Don't use them for identifier-level work.",
].join("\n");

/** Locate the SKILL.md shipped with the package. dist/cli.js → ../skills/tslsp/SKILL.md */
export function findBundledSkill(): string {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const candidates = [
    join(here, "..", "skills", "tslsp", "SKILL.md"),
    join(here, "..", "..", "skills", "tslsp", "SKILL.md"),
  ];
  for (const c of candidates) if (existsSync(c)) return resolve(c);
  throw new Error(`could not find bundled SKILL.md — looked in:\n  ${candidates.join("\n  ")}`);
}

export function targetSkillPath(scope: "user" | "project", cwd = process.cwd()): string {
  const base = scope === "user" ? join(homedir(), ".claude") : join(cwd, ".claude");
  return join(base, "skills", "tslsp", "SKILL.md");
}

/** Where the Claude nudge lands. Project scope writes to the repo's CLAUDE.md
 * (the convention Claude Code already reads); user scope writes to
 * ~/.claude/CLAUDE.md. */
export function targetClaudeMdPath(scope: "user" | "project", cwd = process.cwd()): string {
  return scope === "user" ? join(homedir(), ".claude", "CLAUDE.md") : join(cwd, "CLAUDE.md");
}

/** Where the Codex nudge lands. Mirrors `targetClaudeMdPath` for the AGENTS.md
 * convention: project scope writes to ./AGENTS.md (Codex walks up from cwd to
 * find it); user scope writes to ~/.codex/AGENTS.md. */
export function targetAgentsMdPath(scope: "user" | "project", cwd = process.cwd()): string {
  return scope === "user" ? join(homedir(), ".codex", "AGENTS.md") : join(cwd, "AGENTS.md");
}

export async function installSkills(opts: InstallOpts): Promise<InstallResult> {
  const lines: string[] = [];
  const src = findBundledSkill();
  const dst = targetSkillPath(opts.scope, opts.cwd);

  let skillInstalled = false;
  if (existsSync(dst) && !opts.force) {
    const st = await stat(dst);
    lines.push(`skill already installed: ${dst}`);
    lines.push(`  (mtime ${st.mtime.toISOString()}) — pass --force to overwrite`);
  } else {
    await mkdir(dirname(dst), { recursive: true });
    await copyFile(src, dst);
    skillInstalled = true;
    lines.push(`installed skill: ${dst}`);
    lines.push(
      opts.scope === "user"
        ? "  available to every project on this machine."
        : "  scoped to this project; commit .claude/skills/tslsp/ to share with your team.",
    );
  }

  // Tips fire only on a brand-new skill install when the user didn't already
  // pick an md target — once they've signalled which host they care about, we
  // don't pester them about the other one.
  const showTips = skillInstalled && !opts.withClaudeMd && !opts.withAgentsMd;

  if (opts.withClaudeMd) {
    const r = await ensureNudge(targetClaudeMdPath(opts.scope, opts.cwd));
    if (r.updated) lines.push(`updated ${r.path} (added skill nudge)`);
    else lines.push(`${r.path} already nudges; left as-is`);
  } else if (showTips) {
    const md = targetClaudeMdPath(opts.scope, opts.cwd);
    lines.push(`  tip: pass --with-claude-md to auto-add the routing nudge to ${md}`);
  }

  if (opts.withAgentsMd) {
    const r = await ensureNudge(targetAgentsMdPath(opts.scope, opts.cwd));
    if (r.updated) lines.push(`updated ${r.path} (added skill nudge)`);
    else lines.push(`${r.path} already nudges; left as-is`);
  } else if (showTips) {
    const md = targetAgentsMdPath(opts.scope, opts.cwd);
    lines.push(`  tip: pass --with-agents-md to do the same for Codex's ${md}`);
  }

  return { ok: true, lines };
}

/** Append (or no-op) a marked nudge block to the given Markdown file so the
 * host agent routes identifier work through tslsp-cli even without re-reading
 * SKILL.md. The marker comment makes re-runs idempotent and the block easy to
 * remove. Used for both CLAUDE.md (Claude Code) and AGENTS.md (Codex). */
async function ensureNudge(path: string): Promise<{ updated: boolean; path: string }> {
  let existing = "";
  try {
    existing = await readFile(path, "utf8");
  } catch {
    // Missing file — we'll create it.
  }
  if (existing.includes(NUDGE_MARKER)) return { updated: false, path };

  const sep = existing.length === 0 ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  const block = `${sep}${NUDGE_MARKER}\n${NUDGE_BLOCK}\n`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, existing + block, "utf8");
  return { updated: true, path };
}
