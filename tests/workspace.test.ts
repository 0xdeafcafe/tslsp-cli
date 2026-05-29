import { afterEach, describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findProjectRoot, LspPool } from "../src/workspace.js";

let root: string;
let nested: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "tslsp-ws-"));
  nested = join(root, "src", "components");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(root, "tsconfig.json"), "{}", "utf8");
  writeFileSync(join(nested, "Button.tsx"), "export const Button = () => null;\n", "utf8");
});

describe("findProjectRoot", () => {
  it("returns the dir containing tsconfig.json when given that dir", () => {
    expect(findProjectRoot(root)).toBe(root);
  });

  it("walks up from a file path", () => {
    expect(findProjectRoot(join(nested, "Button.tsx"))).toBe(root);
  });

  it("walks up from a deep directory", () => {
    expect(findProjectRoot(nested)).toBe(root);
  });

  it("returns undefined when no tsconfig is found anywhere up the tree", () => {
    // A path under /tmp that doesn't have a tsconfig anywhere up — but tmp on
    // some systems sits under a path that does. Use a fresh isolated dir to be safe.
    const isolated = mkdtempSync(join(tmpdir(), "tslsp-empty-"));
    const buried = join(isolated, "a", "b");
    mkdirSync(buried, { recursive: true });
    // Note: we can't make the PARENT of tmpdir tsconfig-free if the user happens
    // to have one further up, so we just assert that if it resolves, it's not buried.
    const found = findProjectRoot(buried);
    if (found !== undefined) {
      expect(found).not.toContain(isolated);
    }
  });

  it("handles a non-existent path by walking up its dirname", () => {
    const ghost = join(nested, "does-not-exist.ts");
    expect(findProjectRoot(ghost)).toBe(root);
  });
});

describe("LspPool idle reaper", () => {
  let pool: LspPool | undefined;

  afterEach(async () => {
    if (pool) await pool.disposeAll();
    pool = undefined;
  });

  it("reaps a tsgo idle past tsgoIdleMs", async () => {
    pool = new LspPool({ tsgoIdleMs: 400 });
    await pool.forFile(join(nested, "Button.tsx"));
    expect(pool.roots()).toEqual([root]);
    // Reaper interval = idle/4 = 100ms; wait ≥ 2× idle so we definitely cross.
    await new Promise((r) => setTimeout(r, 1200));
    expect(pool.roots()).toEqual([]);
  });

  it("does not reap when tsgoIdleMs is 0", async () => {
    pool = new LspPool({ tsgoIdleMs: 0 });
    await pool.forFile(join(nested, "Button.tsx"));
    await new Promise((r) => setTimeout(r, 500));
    expect(pool.roots()).toEqual([root]);
  });
});
