import { describe, expect, it } from "vitest";
import { formatValidationErrors, s, validate, validateShape, type Infer } from "../src/schema.js";

describe("validate (single field)", () => {
  it("required field rejects undefined", () => {
    const r = validate(s.str({}), undefined, "name");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatchObject({ path: "name", message: "required" });
  });

  it("optional field allows undefined", () => {
    const r = validate(s.str({ optional: true }), undefined);
    expect(r).toEqual({ ok: true, value: undefined });
  });

  it("string min enforced", () => {
    expect(validate(s.str({ min: 1 }), "").ok).toBe(false);
    expect(validate(s.str({ min: 3 }), "ab").ok).toBe(false);
    expect(validate(s.str({ min: 3 }), "abc").ok).toBe(true);
  });

  it("number constraints", () => {
    expect(validate(s.num({ positive: true }), 0).ok).toBe(false);
    expect(validate(s.num({ positive: true }), 1).ok).toBe(true);
    expect(validate(s.num({ nonnegative: true }), -1).ok).toBe(false);
    expect(validate(s.num({ nonnegative: true }), 0).ok).toBe(true);
    expect(validate(s.num({ int: true }), 3.14).ok).toBe(false);
    expect(validate(s.num({ int: true }), 3).ok).toBe(true);
    expect(validate(s.num({ max: 10 }), 11).ok).toBe(false);
    expect(validate(s.num({ min: 5 }), 4).ok).toBe(false);
  });

  it("rejects NaN/Infinity as not-a-number", () => {
    expect(validate(s.num({}), NaN).ok).toBe(false);
    expect(validate(s.num({}), Infinity).ok).toBe(false);
  });

  it("boolean must be a real boolean", () => {
    expect(validate(s.bool({}), true).ok).toBe(true);
    expect(validate(s.bool({}), "true").ok).toBe(false);
    expect(validate(s.bool({}), 1).ok).toBe(false);
  });

  it("array validates each element and aggregates per-element errors", () => {
    const r = validate(s.arr(s.str({ min: 1 })), ["a", "", "b", ""]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // Two empty strings at indices 1 and 3 — both should appear.
      expect(r.errors.map((e) => e.path)).toEqual(["1", "3"]);
    }
  });

  it("array min length enforced", () => {
    expect(validate(s.arr(s.str({}), { min: 1 }), []).ok).toBe(false);
    expect(validate(s.arr(s.str({}), { min: 1 }), ["x"]).ok).toBe(true);
  });

  it("enum rejects values outside the set", () => {
    expect(validate(s.pick(["a", "b"]), "c").ok).toBe(false);
    expect(validate(s.pick(["a", "b"]), "a").ok).toBe(true);
  });
});

describe("validateShape", () => {
  const shape = {
    name: s.str({ min: 1 }),
    age: s.int({ nonnegative: true, optional: true }),
    tags: s.arr(s.str({ min: 1 }), { optional: true }),
  };

  it("accepts a valid object", () => {
    const r = validateShape(shape, { name: "alice", age: 30, tags: ["a", "b"] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ name: "alice", age: 30, tags: ["a", "b"] });
  });

  it("omits optional keys when missing rather than emitting `undefined`", () => {
    // Handlers destructure `({ name, age })` — having undefined in the object
    // vs key-absent is equivalent. We strip undefineds so the validated object
    // matches the shape of e.g. `JSON.parse` of a partial input.
    const r = validateShape(shape, { name: "alice" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ name: "alice" });
  });

  it("aggregates errors from multiple fields, not just the first", () => {
    const r = validateShape(shape, { name: "", age: -1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const paths = r.errors.map((e) => e.path).sort();
      expect(paths).toEqual(["age", "name"]);
    }
  });

  it("formatValidationErrors renders --kebab-case field names", () => {
    const r = validateShape({ new_name: s.str({ min: 1 }) }, { new_name: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const out = formatValidationErrors(r.errors);
      expect(out).toMatch(/invalid --new-name:/);
    }
  });
});

describe("Infer<>", () => {
  // Type-only assertions — these never run, but `tsc` fails the build if the
  // inferred shape diverges from what handlers expect.
  it("preserves required vs optional in the inferred type", () => {
    const shape = {
      name: s.str({ min: 1 }),
      age: s.int({ optional: true }),
      mode: s.pick(["fast", "slow"], { optional: true }),
    };
    type Out = Infer<typeof shape>;
    const _ok: Out = { name: "x", age: 1, mode: "fast" };
    const _alsoOk: Out = { name: "x", age: undefined, mode: undefined };
    // @ts-expect-error name is required
    const _bad1: Out = { age: 1 };
    // @ts-expect-error mode literal not in the enum
    const _bad2: Out = { name: "x", mode: "fasr" };
    expect(true).toBe(true);
  });
});
