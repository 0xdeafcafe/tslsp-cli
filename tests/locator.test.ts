import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSymbolNotOnLineError, locateIdentifierInRange } from "../src/locator.js";

let dir: string;
let file: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tslsp-loc-"));
  file = join(dir, "src.ts");
  writeFileSync(
    file,
    [
      "export function double(x: number): number {",
      "  return x * 2;",
      "}",
      "",
      "// trailing comment with double in it",
    ].join("\n"),
    "utf8",
  );
});

describe("locateIdentifierInRange", () => {
  it("finds the identifier inside a single-line range", async () => {
    const pos = await locateIdentifierInRange(
      file,
      { start: { line: 0, character: 0 }, end: { line: 0, character: 50 } },
      "double",
    );
    expect(pos).toEqual({ line: 0, character: 16 });
  });

  it("scans across a multi-line range and stops at the first hit", async () => {
    const pos = await locateIdentifierInRange(
      file,
      { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
      "double",
    );
    expect(pos.line).toBe(0);
    expect(pos.character).toBe(16);
  });

  it("respects the column window on the start and end lines", async () => {
    // Search starting AFTER the identifier on line 0 → should not find it on line 0,
    // and the range ends before the trailing comment, so should fall back to range start.
    const pos = await locateIdentifierInRange(
      file,
      { start: { line: 0, character: 25 }, end: { line: 0, character: 40 } },
      "double",
    );
    expect(pos).toEqual({ line: 0, character: 25 }); // fallback to range.start
  });

  it("uses word boundaries (no partial matches)", async () => {
    // 'doublewide' should not match 'double'.
    writeFileSync(file, "const doublewide = 1;\n// double\n", "utf8");
    const pos = await locateIdentifierInRange(
      file,
      { start: { line: 0, character: 0 }, end: { line: 1, character: 20 } },
      "double",
    );
    expect(pos.line).toBe(1); // matched the comment, not 'doublewide'
  });
});

describe("buildSymbolNotOnLineError", () => {
  const lines = [
    "// header",
    "",
    "function thing() {",
    "  return runWithContext(() => 1);",
    "}",
    "",
    "// runWithContext is also referenced in the comment",
    "const fn = runWithContext;",
  ];

  it("includes 'zero-based' so off-by-one is obvious", () => {
    const msg = buildSymbolNotOnLineError("runWithContext", 0, lines, "/repo/x.ts", "/repo");
    expect(msg).toMatch(/zero-based; first line is 0/);
    expect(msg).toMatch(/symbol "runWithContext" not found on line 0 of x\.ts/);
  });

  it("lists nearby lines closest-first and proposes the nearest when within ±3", () => {
    // User asked for line 2; symbol is on lines 3, 6, 7. Nearest is 3 (Δ=1).
    const msg = buildSymbolNotOnLineError("runWithContext", 2, lines, "/repo/x.ts", "/repo");
    expect(msg).toMatch(/found "runWithContext" on lines: 3, 6, 7/);
    expect(msg).toMatch(/did you mean --line 3\?/);
  });

  it("omits the --line guess when no hit is within ±3", () => {
    // Asked for line 0; nearest hit is line 3 (Δ=3) — still inside the window,
    // so we DO suggest. Move the asked-for line to 20 to push it outside.
    const padded = [...lines, ...Array(30).fill("")];
    const msg = buildSymbolNotOnLineError("runWithContext", 20, padded, "/repo/x.ts", "/repo");
    expect(msg).toMatch(/found "runWithContext" on lines:/);
    expect(msg).not.toMatch(/did you mean --line/);
  });

  it("says so when the symbol doesn't appear in the file at all", () => {
    const msg = buildSymbolNotOnLineError("nowhereSymbol", 2, lines, "/repo/x.ts", "/repo");
    expect(msg).toMatch(/does not appear anywhere in this file/);
    expect(msg).toMatch(/Drop --line and pass --symbol alone/);
  });
});
