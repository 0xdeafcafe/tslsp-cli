import { describe, expect, it } from "vitest";
import { fanout, type ToolResult } from "../src/tools.js";

// Direct unit tests for fanout's empty-collapse behavior. Exercising this via
// the real CLI requires a deterministic tool path with real findings AND real
// empties in the same call — diagnostics would be the natural fit, but tsgo's
// native preview doesn't push `publishDiagnostics` for unopened files in the
// timeframe we wait, so the e2e mixed-case isn't reliable. Hitting fanout
// directly with synthetic ToolResults is both deterministic and exact about
// what we're claiming.

const r = (text: string): ToolResult => ({ text });
const e = (text: string): ToolResult => ({ text, empty: true });
const err = (text: string): ToolResult => ({ text, isError: true });

describe("fanout", () => {
  it("collapses all-empty batch to a single short line", async () => {
    const out = await fanout(
      ["a.ts", "b.ts", "c.ts"],
      (f) => f,
      async () => e("no diagnostics"),
    );
    expect(out.text).toBe("no diagnostics");
    expect(out.empty).toBe(true);
    expect(out.isError).toBeFalsy();
    // No `=== file ===` headers when everything was clean — that's the whole
    // point of the collapse.
    expect(out.text).not.toMatch(/===/);
  });

  it("drops empty items but keeps labeled blocks for items with findings", async () => {
    const out = await fanout(
      ["a.ts", "b.ts", "c.ts"],
      (f) => f,
      async (f) => (f === "b.ts" ? r("b.ts:1:1 some finding") : e("no diagnostics")),
    );
    expect(out.text).toMatch(/=== b\.ts ===/);
    expect(out.text).toMatch(/some finding/);
    // a.ts and c.ts were clean → no labeled blocks for them.
    expect(out.text).not.toMatch(/=== a\.ts ===/);
    expect(out.text).not.toMatch(/=== c\.ts ===/);
    expect(out.isError).toBeFalsy();
  });

  it("retains errors as labeled blocks even alongside empties", async () => {
    const out = await fanout(
      ["a.ts", "b.ts"],
      (f) => f,
      async (f) => (f === "a.ts" ? err("boom") : e("no diagnostics")),
    );
    expect(out.text).toMatch(/=== a\.ts ===/);
    expect(out.text).toMatch(/boom/);
    expect(out.text).not.toMatch(/=== b\.ts ===/);
    expect(out.isError).toBe(true);
  });

  it("returns findings before errors in the joined output", async () => {
    const out = await fanout(
      ["x", "y"],
      (f) => f,
      async (f) => (f === "x" ? err("nope") : r("real finding")),
    );
    // findings block first, then the error block — caller-friendly ordering
    // so an isError result still leads with useful output.
    expect(out.text.indexOf("=== y ===")).toBeLessThan(out.text.indexOf("=== x ==="));
    expect(out.isError).toBe(true);
  });

  it("preserves the original error text for thrown handler failures", async () => {
    const out = await fanout(
      ["a"],
      (f) => f,
      async () => {
        throw new Error("explode");
      },
    );
    expect(out.text).toMatch(/=== a ===/);
    expect(out.text).toMatch(/explode/);
    expect(out.isError).toBe(true);
  });
});
