import { describe, expect, it } from "vitest";
import { applyEditsToText } from "../src/rename.js";
import type { TextEdit } from "../src/lsp-client.js";

const r = (sl: number, sc: number, el: number, ec: number) => ({
  start: { line: sl, character: sc },
  end: { line: el, character: ec },
});

describe("applyEditsToText", () => {
  it("applies a single replacement", () => {
    const text = "const add = 1;\n";
    const edits: TextEdit[] = [{ range: r(0, 6, 0, 9), newText: "sum" }];
    expect(applyEditsToText(text, edits)).toBe("const sum = 1;\n");
  });

  it("applies multiple edits in the same line correctly regardless of input order", () => {
    const text = "add(add(1, 2), 3);\n";
    // Two edits, given in ascending order — should still produce correct text
    // because the function sorts descending internally.
    const edits: TextEdit[] = [
      { range: r(0, 0, 0, 3), newText: "sum" },
      { range: r(0, 4, 0, 7), newText: "sum" },
    ];
    expect(applyEditsToText(text, edits)).toBe("sum(sum(1, 2), 3);\n");
  });

  it("applies edits across multiple lines", () => {
    const text = ["function add(a, b) {", "  return a + b;", "}", ""].join("\n");
    const edits: TextEdit[] = [{ range: r(0, 9, 0, 12), newText: "sum" }];
    expect(applyEditsToText(text, edits)).toBe("function sum(a, b) {\n  return a + b;\n}\n");
  });

  it("handles a multi-line edit (range spans lines)", () => {
    const text = "before\nA\nB\nafter\n";
    const edits: TextEdit[] = [{ range: r(1, 0, 2, 1), newText: "X" }];
    expect(applyEditsToText(text, edits)).toBe("before\nX\nafter\n");
  });

  it("is a no-op for empty edits array", () => {
    const text = "anything";
    expect(applyEditsToText(text, [])).toBe(text);
  });

  it("handles insertion (zero-width range)", () => {
    const text = "foo bar\n";
    const edits: TextEdit[] = [{ range: r(0, 4, 0, 4), newText: "BAZ " }];
    expect(applyEditsToText(text, edits)).toBe("foo BAZ bar\n");
  });
});
