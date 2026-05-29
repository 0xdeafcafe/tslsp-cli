import { z } from "zod";
import type { ToolDef } from "./tools.js";

const WRAPPER_NAMES = new Set([
  "ZodOptional",
  "ZodNullable",
  "ZodDefault",
  "ZodReadonly",
  "ZodCatch",
]);

/** Peel optional-like wrappers. Stops at the first concrete type — important
 * because zod 4's `ZodArray.unwrap()` returns the element, not itself. */
export function unwrap(ty: z.ZodTypeAny): z.ZodTypeAny {
  let cur: any = ty;
  while (cur && WRAPPER_NAMES.has(cur.constructor?.name) && typeof cur.unwrap === "function") {
    try {
      cur = cur.unwrap();
    } catch {
      break;
    }
  }
  return cur;
}

export function isBoolean(ty: z.ZodTypeAny): boolean {
  return unwrap(ty) instanceof z.ZodBoolean;
}

export function isArray(ty: z.ZodTypeAny): boolean {
  return unwrap(ty) instanceof z.ZodArray;
}

export function arrayInner(ty: z.ZodTypeAny): z.ZodTypeAny {
  const root = unwrap(ty) as any;
  // zod 4: .element; zod 3: ._def.type. Fall back to the schema itself so
  // string coercion still works for a malformed shape.
  return root.element ?? root._def?.type ?? root.def?.element ?? root;
}

export function enumValues(ty: z.ZodTypeAny): string[] {
  const root = unwrap(ty) as any;
  const v = root._def?.values ?? root.options ?? root.enum;
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object")
    return Object.values(v).filter((x): x is string => typeof x === "string");
  const entries = root.def?.entries;
  if (entries && typeof entries === "object")
    return Object.values(entries).filter((x): x is string => typeof x === "string");
  return [];
}

export function coerce(ty: z.ZodTypeAny, raw: string): unknown {
  const root = unwrap(ty);
  if (root instanceof z.ZodNumber) {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`expected number, got "${raw}"`);
    return n;
  }
  if (root instanceof z.ZodBoolean) {
    return raw === "true" || raw === "1";
  }
  if (root instanceof z.ZodEnum) {
    const values = enumValues(ty);
    if (values.length && !values.includes(raw)) {
      throw new Error(`expected one of ${values.join("|")}, got "${raw}"`);
    }
    return raw;
  }
  return raw;
}

export function typeHint(ty: z.ZodTypeAny): string {
  const root = unwrap(ty);
  if (root instanceof z.ZodArray) return `${typeHint(arrayInner(ty))}[,…]`;
  if (root instanceof z.ZodNumber) return "number";
  if (root instanceof z.ZodEnum) {
    const values = enumValues(ty);
    return values.length ? values.join("|") : "enum";
  }
  return "value";
}

export function fieldDesc(ty: z.ZodTypeAny): string {
  return (ty as any)._def?.description ?? (ty as any).description ?? "";
}

/** Parse a tool's argv into a record matching its zod input schema. Throws
 * with a human-readable message on malformed input. */
export function parseArgs(tool: ToolDef, argv: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const shape = tool.inputSchema as Record<string, z.ZodTypeAny>;
  const positional = (tool.positional ?? []) as string[];
  let posIdx = 0;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      const flag = (eq === -1 ? tok.slice(2) : tok.slice(2, eq)).replace(/-/g, "_");
      const inline = eq === -1 ? undefined : tok.slice(eq + 1);
      if (!(flag in shape)) throw new Error(`unknown flag: --${flag.replace(/_/g, "-")}`);
      const ty = shape[flag]!;
      if (isBoolean(ty)) {
        if (inline === undefined) out[flag] = true;
        else out[flag] = inline === "true" || inline === "1";
        continue;
      }
      const value = inline ?? argv[++i];
      if (value === undefined) throw new Error(`--${flag.replace(/_/g, "-")} requires a value`);
      if (isArray(ty)) {
        const parts = value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const prev = (out[flag] as unknown[] | undefined) ?? [];
        out[flag] = [...prev, ...parts.map((p) => coerce(arrayInner(ty), p))];
      } else {
        out[flag] = coerce(ty, value);
      }
    } else {
      const cur = positional[posIdx];
      if (cur === undefined) throw new Error(`unexpected argument: ${tok}`);
      const ty = shape[cur];
      if (!ty) throw new Error(`positional maps to unknown flag: ${cur}`);
      if (isArray(ty)) {
        const prev = (out[cur] as unknown[] | undefined) ?? [];
        out[cur] = [...prev, coerce(arrayInner(ty), tok)];
        // stay on the same positional slot so subsequent positionals append
      } else {
        out[cur] = coerce(ty, tok);
        posIdx++;
      }
    }
  }
  return out;
}
