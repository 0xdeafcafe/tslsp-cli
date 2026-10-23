import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maxServerMemoryBytes, parseTopMem, resolveServerBin } from "../src/engine.js";
import { LspPool } from "../src/workspace.js";

const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
});

describe("parseTopMem", () => {
  const out = "Processes: 612 total\n\nPID    MEM\n76538  2496K\n";
  it("reads the MEM of the pid asked for", () => {
    expect(parseTopMem(out, 76538)).toBe(2496 * 1024);
    expect(parseTopMem("PID MEM\n9 10G\n", 9)).toBe(10 * 1024 ** 3);
    expect(parseTopMem("PID MEM\n9 523M+\n", 9)).toBe(523 * 1024 ** 2);
  });
  it("is 0 for another pid or nonsense", () => {
    expect(parseTopMem(out, 1)).toBe(0);
    expect(parseTopMem("", 1)).toBe(0);
  });
});

describe("maxServerMemoryBytes", () => {
  it("takes TSLSP_MAX_MEMORY_MB, 0 for none", () => {
    process.env.TSLSP_MAX_MEMORY_MB = "3072";
    expect(maxServerMemoryBytes()).toBe(3 * 1024 ** 3);
    process.env.TSLSP_MAX_MEMORY_MB = "0";
    expect(maxServerMemoryBytes()).toBe(0);
  });
  it("defaults to a quarter of memory, at least 2 GiB", () => {
    delete process.env.TSLSP_MAX_MEMORY_MB;
    expect(maxServerMemoryBytes()).toBeGreaterThanOrEqual(2 * 1024 ** 3);
  });
});

describe("resolveServerBin", () => {
  it("prefers tsrs where it's installed, and tsgo when asked", () => {
    delete process.env.TSLSP_ENGINE;
    const auto = resolveServerBin(process.cwd());
    const supported = ["darwin-arm64", "linux-x64", "linux-arm64"].includes(
      `${process.platform}-${process.arch}`,
    );
    expect(auto.engine).toBe(supported ? "tsrs" : "tsgo");
    process.env.TSLSP_ENGINE = "tsgo";
    expect(resolveServerBin(process.cwd()).engine).toBe("tsgo");
  });
});

describe("memory cap", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "tslsp-cap-"));
    writeFileSync(join(root, "tsconfig.json"), "{}", "utf8");
    writeFileSync(join(root, "a.ts"), "export const a = 1;\n", "utf8");
  });

  it("stops a server past its cap, and the pool starts a fresh one after", async () => {
    process.env.TSLSP_MAX_MEMORY_MB = "1";
    const pool = new LspPool({ tsgoIdleMs: 0 });
    try {
      const { client } = await pool.forFile(join(root, "a.ts"));
      // Memory is looked at every 2s, and top is slow on a busy machine.
      for (let i = 0; i < 40 && pool.roots().length > 0; i++) {
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(pool.roots()).toEqual([]);
      await expect(client.request("workspace/symbol", { query: "a" })).rejects.toThrow();
      process.env.TSLSP_MAX_MEMORY_MB = "0";
      const again = await pool.forFile(join(root, "a.ts"));
      expect(again.client).not.toBe(client);
    } finally {
      await pool.disposeAll();
    }
  }, 60_000);
});
