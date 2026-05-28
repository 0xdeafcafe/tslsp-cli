import { copyFile, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface InstallOpts {
  scope: "user" | "project";
  force: boolean;
  cwd?: string;
}

export interface InstallResult {
  ok: boolean;
  lines: string[];
}

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

export async function installSkills(opts: InstallOpts): Promise<InstallResult> {
  const lines: string[] = [];
  const src = findBundledSkill();
  const dst = targetSkillPath(opts.scope, opts.cwd);

  if (existsSync(dst) && !opts.force) {
    const st = await stat(dst);
    lines.push(`skill already installed: ${dst}`);
    lines.push(`  (mtime ${st.mtime.toISOString()}) — pass --force to overwrite`);
    return { ok: true, lines };
  }

  await mkdir(dirname(dst), { recursive: true });
  await copyFile(src, dst);
  lines.push(`installed skill: ${dst}`);
  lines.push(
    opts.scope === "user"
      ? "  available to every project on this machine."
      : "  scoped to this project; commit .claude/skills/tslsp/ to share with your team.",
  );
  return { ok: true, lines };
}
