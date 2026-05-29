import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { expandFileArgs } from "../src/file-args.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tslsp-file-args-"));
  mkdirSync(join(dir, "src", "lib"), { recursive: true });
  mkdirSync(join(dir, "src", "api"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "junk"), { recursive: true });
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "src", "lib", "b.tsx"), "export const b = 2;\n");
  writeFileSync(join(dir, "src", "api", "c.js"), "export const c = 3;\n");
  writeFileSync(join(dir, "src", "ignore.md"), "skip me\n");
  writeFileSync(join(dir, "node_modules", "junk", "skip.ts"), "should be ignored\n");
  writeFileSync(join(dir, "dist", "built.ts"), "should be ignored\n");
  return dir;
}

describe("expandFileArgs", () => {
  it("returns literal files unchanged (absolute) and resolves relatives against cwd", async () => {
    const dir = fixture();
    const out = await expandFileArgs(["src/a.ts"], dir);
    expect(out).toEqual([resolve(dir, "src/a.ts")]);
  });

  it("expands a directory recursively, filters to source exts", async () => {
    const dir = fixture();
    const out = await expandFileArgs(["src"], dir);
    // Should include a.ts, b.tsx, c.js — should NOT include ignore.md.
    expect(out).toContain(resolve(dir, "src/a.ts"));
    expect(out).toContain(resolve(dir, "src/lib/b.tsx"));
    expect(out).toContain(resolve(dir, "src/api/c.js"));
    expect(out.some((p) => p.endsWith("ignore.md"))).toBe(false);
  });

  it("skips node_modules / dist / build during directory walks", async () => {
    const dir = fixture();
    const out = await expandFileArgs(["."], dir);
    expect(out.some((p) => p.includes(`${dir}/node_modules`))).toBe(false);
    expect(out.some((p) => p.includes(`${dir}/dist`))).toBe(false);
  });

  it("expands a glob like 'src/**/*.ts' to matching files only", async () => {
    const dir = fixture();
    const out = await expandFileArgs(["src/**/*.ts"], dir);
    // .ts only (a.ts) — not b.tsx, not c.js.
    expect(out).toEqual([resolve(dir, "src/a.ts")]);
  });

  it("dedupes when a literal and glob overlap", async () => {
    const dir = fixture();
    const out = await expandFileArgs(["src/a.ts", "src/**/*.ts"], dir);
    expect(out).toEqual([resolve(dir, "src/a.ts")]);
  });

  it("returns sorted output for deterministic batches", async () => {
    const dir = fixture();
    const out = await expandFileArgs(["src"], dir);
    const sorted = [...out].sort();
    expect(out).toEqual(sorted);
  });
});
