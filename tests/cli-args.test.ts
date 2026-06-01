import { describe, expect, it } from "vitest";
import {
  arrayInner,
  coerce,
  enumValues,
  isArray,
  isBoolean,
  parseArgs,
  typeHint,
} from "../src/cli-args.js";
import { s } from "../src/schema.js";
import type { ToolDef } from "../src/tools.js";

describe("type predicates", () => {
  it("isBoolean", () => {
    expect(isBoolean(s.bool({ optional: true }))).toBe(true);
    expect(isBoolean(s.str({ optional: true }))).toBe(false);
  });

  it("isArray", () => {
    expect(isArray(s.arr(s.str({}), { optional: true }))).toBe(true);
    expect(isArray(s.str({ optional: true }))).toBe(false);
  });
});

describe("arrayInner", () => {
  it("returns the element schema for an array", () => {
    expect(arrayInner(s.arr(s.str({})))).toMatchObject({ kind: "string" });
  });
  it("returns the element schema for an optional array", () => {
    expect(arrayInner(s.arr(s.num({}), { optional: true }))).toMatchObject({ kind: "number" });
  });
});

describe("enumValues", () => {
  it("extracts the value list", () => {
    expect(enumValues(s.pick(["a", "b", "c"])).sort()).toEqual(["a", "b", "c"]);
  });
  it("works on an optional enum", () => {
    expect(enumValues(s.pick(["x", "y"], { optional: true })).sort()).toEqual(["x", "y"]);
  });
});

describe("coerce", () => {
  it("parses numbers", () => {
    expect(coerce(s.num({}), "42")).toBe(42);
    expect(coerce(s.num({ optional: true }), "0")).toBe(0);
  });
  it("rejects non-integer when int: true", () => {
    expect(() => coerce(s.int({}), "3.14")).toThrow(/expected integer/);
  });
  it("throws on non-numeric", () => {
    expect(() => coerce(s.num({}), "abc")).toThrow(/expected number/);
  });
  it("parses booleans", () => {
    expect(coerce(s.bool({}), "true")).toBe(true);
    expect(coerce(s.bool({}), "1")).toBe(true);
    expect(coerce(s.bool({}), "false")).toBe(false);
  });
  it("validates enums", () => {
    const e = s.pick(["a", "b"]);
    expect(coerce(e, "a")).toBe("a");
    expect(() => coerce(e, "z")).toThrow(/expected one of/);
  });
  it("passes strings through", () => {
    expect(coerce(s.str({}), "hello")).toBe("hello");
  });
});

describe("typeHint", () => {
  it("renders enum values", () => {
    expect(typeHint(s.pick(["a", "b", "c"]))).toBe("a|b|c");
  });
  it("renders number", () => {
    expect(typeHint(s.num({}))).toBe("number");
  });
  it("renders arrays as value[,…]", () => {
    expect(typeHint(s.arr(s.str({}), { optional: true }))).toMatch(/\[,…\]/);
  });
});

// minimal tool fixtures for parseArgs
const stringTool: ToolDef = {
  name: "stringy",
  description: "",
  positional: ["q"],
  inputSchema: {
    q: s.str({ description: "query" }),
    file: s.str({ optional: true, description: "file" }),
    limit: s.int({ optional: true, description: "limit" }),
    flag: s.bool({ optional: true, description: "flag" }),
  },
  handler: async () => ({ text: "" }),
};

const arrayTool: ToolDef = {
  name: "arrayy",
  description: "",
  positional: ["files"],
  inputSchema: {
    files: s.arr(s.str({}), { description: "files" }),
    symbols: s.arr(s.str({}), { optional: true, description: "symbols" }),
  },
  handler: async () => ({ text: "" }),
};

describe("parseArgs", () => {
  it("parses positional + flags + booleans", () => {
    const out = parseArgs(stringTool, ["foo", "--file", "src/x.ts", "--limit", "10", "--flag"]);
    expect(out).toEqual({ q: "foo", file: "src/x.ts", limit: 10, flag: true });
  });

  it("supports --flag=value inline form", () => {
    const out = parseArgs(stringTool, ["foo", "--file=src/x.ts", "--limit=5"]);
    expect(out).toEqual({ q: "foo", file: "src/x.ts", limit: 5 });
  });

  it("supports --flag=false for booleans", () => {
    const out = parseArgs(stringTool, ["foo", "--flag=false"]);
    expect(out.flag).toBe(false);
  });

  it("accepts kebab-case flags and maps them to snake_case fields", () => {
    const tool: ToolDef = {
      name: "t",
      description: "",
      inputSchema: { new_name: s.str({ description: "" }) },
      handler: async () => ({ text: "" }),
    };
    expect(parseArgs(tool, ["--new-name", "X"])).toEqual({ new_name: "X" });
  });

  it("rejects unknown flags", () => {
    expect(() => parseArgs(stringTool, ["foo", "--bogus", "x"])).toThrow(/unknown flag/);
  });

  it("rejects flags missing a value", () => {
    expect(() => parseArgs(stringTool, ["foo", "--file"])).toThrow(/requires a value/);
  });

  it("rejects extra positional args", () => {
    expect(() => parseArgs(stringTool, ["foo", "bar"])).toThrow(/unexpected/);
  });

  it("splits comma-separated array flags", () => {
    const out = parseArgs(arrayTool, ["a.ts", "--symbols", "x,y,z"]);
    expect(out.files).toEqual(["a.ts"]);
    expect(out.symbols).toEqual(["x", "y", "z"]);
  });

  it("collects multi-positional into an array slot", () => {
    const out = parseArgs(arrayTool, ["a.ts", "b.ts", "c.ts"]);
    expect(out.files).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("accepts repeated array flags (appending)", () => {
    const out = parseArgs(arrayTool, ["a.ts", "--symbols", "x", "--symbols", "y"]);
    expect(out.symbols).toEqual(["x", "y"]);
  });
});
