/**
 * Tiny schema + validator that replaces zod for this CLI's narrow needs.
 *
 * What we actually used from zod: string/number/boolean/array/enum, the
 * constraints `min`/`max`/`int`/`positive`/`nonnegative`, `optional`,
 * `describe`, runtime `parse`, and `z.infer`. No transforms, refinements,
 * pipes, discriminated unions, lazy/recursive, or branded types.
 *
 * Schemas are plain tagged structs — easy to inspect (CLI arg parser walks
 * `s.kind` instead of doing `instanceof z.ZodArray`) and easy to type-thread
 * (`Infer<typeof shape>` reads literal `optional: true` markers).
 */

// --- schema kinds ---

export interface StrSchema {
  kind: "string";
  description?: string;
  optional?: boolean;
  /** Minimum string length, inclusive. */
  min?: number;
}

export interface NumSchema {
  kind: "number";
  description?: string;
  optional?: boolean;
  int?: boolean;
  positive?: boolean;
  nonnegative?: boolean;
  /** Minimum value, inclusive. */
  min?: number;
  /** Maximum value, inclusive. */
  max?: number;
}

export interface BoolSchema {
  kind: "boolean";
  description?: string;
  optional?: boolean;
}

export interface ArrSchema<E extends Schema = Schema> {
  kind: "array";
  description?: string;
  optional?: boolean;
  element: E;
  /** Minimum array length, inclusive. */
  min?: number;
}

export interface EnumSchema<V extends string = string> {
  kind: "enum";
  description?: string;
  optional?: boolean;
  values: readonly V[];
}

export type Schema = StrSchema | NumSchema | BoolSchema | ArrSchema | EnumSchema;

// Per-kind "opts without kind" aliases keep the factory signatures readable
// and reusable below. Every field on each schema except `kind` is optional,
// so an empty `{}` always satisfies the constraint.
type StrOpts = Omit<StrSchema, "kind">;
type NumOpts = Omit<NumSchema, "kind">;
type BoolOpts = Omit<BoolSchema, "kind">;
type ArrOpts<E extends Schema> = Omit<ArrSchema<E>, "kind" | "element">;
type EnumOpts<V extends string> = Omit<EnumSchema<V>, "kind" | "values">;

// --- constructors ---
//
// Each `s.*` factory returns `O & { kind: ... }` so the literal `optional: true`
// on the caller's opts flows into the inferred shape — `Field<>` below reads
// that literal to add `| undefined` to optional fields.
//
// We deliberately do NOT provide a `= {}` default on `opts`. Doing so requires
// `opts: O = {} as O` (a cast), and every call site already passes an object
// (often `{}`) so the friction is zero.

export const s = {
  str<O extends StrOpts>(opts: O): O & { kind: "string" } {
    return { kind: "string", ...opts };
  },
  num<O extends NumOpts>(opts: O): O & { kind: "number" } {
    return { kind: "number", ...opts };
  },
  /** Shorthand for `num({ int: true, ...opts })`. */
  int<O extends Omit<NumOpts, "int">>(opts: O): O & { kind: "number"; int: true } {
    return { kind: "number", int: true, ...opts };
  },
  bool<O extends BoolOpts>(opts: O): O & { kind: "boolean" } {
    return { kind: "boolean", ...opts };
  },
  arr<E extends Schema, O extends ArrOpts<E>>(
    element: E,
    opts: O,
  ): O & { kind: "array"; element: E } {
    return { kind: "array", element, ...opts };
  },
  /** Enum (named `pick` since `enum` is a TS reserved word). Preserves the
   * literal string-union type via `values`. */
  pick<V extends string, O extends EnumOpts<V>>(
    values: readonly V[],
    opts: O,
  ): O & { kind: "enum"; values: readonly V[] } {
    return { kind: "enum", values, ...opts };
  },
};

// --- inference ---
//
// `Output<S>` is the runtime value type produced for a given schema.
// `Field<S>` adds `| undefined` for optional schemas (matches how we
// destructure inputs in handlers).

type Output<S> = S extends { kind: "string" }
  ? string
  : S extends { kind: "number" }
    ? number
    : S extends { kind: "boolean" }
      ? boolean
      : S extends { kind: "array"; element: infer E }
        ? Output<E>[]
        : S extends { kind: "enum"; values: readonly (infer V)[] }
          ? V
          : never;

type Field<S> = S extends { optional: true } ? Output<S> | undefined : Output<S>;

/** Object shape: `Infer<typeof shape>` mirrors `z.infer<z.ZodObject<...>>`.
 * Optional fields stay required keys with `| undefined` values — that's how
 * every handler destructures them today, so making the key truly optional
 * would add noise without changing call sites. */
export type Infer<Shape extends Record<string, Schema>> = {
  [K in keyof Shape]: Field<Shape[K]>;
};

// --- validation ---

export interface ValidationError {
  /** Dotted path into the shape (e.g. `"queries.2"`). Empty for the root. */
  path: string;
  message: string;
}

export type ValidateResult<T> = { ok: true; value: T } | { ok: false; errors: ValidationError[] };

function fail(path: string, message: string): { ok: false; errors: ValidationError[] } {
  return { ok: false, errors: [{ path, message }] };
}

/** Validate a single raw value against a schema. Missing (undefined/null) is
 * allowed iff the schema is optional. */
export function validate(schema: Schema, raw: unknown, path = ""): ValidateResult<unknown> {
  if (raw === undefined || raw === null) {
    return schema.optional ? { ok: true, value: undefined } : fail(path, "required");
  }
  switch (schema.kind) {
    case "string":
      return validateStr(schema, raw, path);
    case "number":
      return validateNum(schema, raw, path);
    case "boolean":
      return validateBool(raw, path);
    case "array":
      return validateArr(schema, raw, path);
    case "enum":
      return validateEnum(schema, raw, path);
  }
}

function validateStr(s: StrSchema, raw: unknown, path: string): ValidateResult<string> {
  if (typeof raw !== "string") return fail(path, `expected string, got ${typeName(raw)}`);
  if (s.min !== undefined && raw.length < s.min) {
    // Match zod's "Too small" phrasing for `.min(1)` so error text is familiar.
    return fail(path, `string must contain at least ${s.min} character${s.min === 1 ? "" : "s"}`);
  }
  return { ok: true, value: raw };
}

function validateNum(s: NumSchema, raw: unknown, path: string): ValidateResult<number> {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return fail(path, `expected number, got ${typeName(raw)}`);
  }
  if (s.int && !Number.isInteger(raw)) return fail(path, "expected integer");
  if (s.positive && raw <= 0) return fail(path, "must be positive");
  if (s.nonnegative && raw < 0) return fail(path, "must be non-negative");
  if (s.min !== undefined && raw < s.min) return fail(path, `must be >= ${s.min}`);
  if (s.max !== undefined && raw > s.max) return fail(path, `must be <= ${s.max}`);
  return { ok: true, value: raw };
}

function validateBool(raw: unknown, path: string): ValidateResult<boolean> {
  if (typeof raw !== "boolean") return fail(path, `expected boolean, got ${typeName(raw)}`);
  return { ok: true, value: raw };
}

function validateArr(s: ArrSchema, raw: unknown, path: string): ValidateResult<unknown[]> {
  if (!Array.isArray(raw)) return fail(path, `expected array, got ${typeName(raw)}`);
  if (s.min !== undefined && raw.length < s.min) {
    return fail(path, `array must contain at least ${s.min} item${s.min === 1 ? "" : "s"}`);
  }
  const value: unknown[] = [];
  const errors: ValidationError[] = [];
  for (let i = 0; i < raw.length; i++) {
    const r = validate(s.element, raw[i], path ? `${path}.${i}` : String(i));
    if (r.ok) value.push(r.value);
    else errors.push(...r.errors);
  }
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

function validateEnum(s: EnumSchema, raw: unknown, path: string): ValidateResult<string> {
  if (typeof raw !== "string" || !s.values.includes(raw)) {
    return fail(path, `expected one of ${s.values.join("|")}, got ${typeName(raw)}`);
  }
  return { ok: true, value: raw };
}

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/** Validate an object against a shape. Unlike zod's `.parse`, this returns a
 * Result rather than throwing — the caller (CLI dispatcher) formats errors
 * for stderr, no need for an exception. */
export function validateShape<Shape extends Record<string, Schema>>(
  shape: Shape,
  input: Record<string, unknown>,
): ValidateResult<Infer<Shape>> {
  const value: Record<string, unknown> = {};
  const errors: ValidationError[] = [];
  for (const key of Object.keys(shape)) {
    const r = validate(shape[key]!, input[key], key);
    if (r.ok) {
      if (r.value !== undefined) value[key] = r.value;
    } else {
      errors.push(...r.errors);
    }
  }
  // The one unavoidable type assertion in this module: TypeScript can't follow
  // the per-field validator loop to prove `value` matches the inferred shape,
  // but every value pushed in came from a `validate()` call that returned `ok`
  // for its kind. Safe by construction.
  return errors.length ? { ok: false, errors } : { ok: true, value: value as Infer<Shape> };
}

/** Format a validator error list into a CLI-friendly string. One line per
 * error, with `--field-name: message`. Matches the zod-error formatter we
 * replaced so existing tests keep working. */
export function formatValidationErrors(errors: ValidationError[]): string {
  return errors
    .map((e) => {
      const path = e.path || "<arg>";
      return `invalid --${path.replace(/_/g, "-")}: ${e.message}`;
    })
    .join("\n");
}
