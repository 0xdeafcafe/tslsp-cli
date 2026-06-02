import type { Schema } from "./schema.js";
import type { ToolDef } from "./tools.js";

export function isBoolean(s: Schema): boolean {
  return s.kind === "boolean";
}

export function isArray(s: Schema): boolean {
  return s.kind === "array";
}

export function arrayInner(s: Schema): Schema {
  // `s.kind === "array"` narrows `s` to ArrSchema via the discriminated
  // union — no cast needed to reach `.element`.
  return s.kind === "array" ? s.element : s;
}

export function enumValues(s: Schema): string[] {
  return s.kind === "enum" ? [...s.values] : [];
}

/** Coerce a string token from argv into the schema's runtime type. Throws
 * with a human-readable message — `parseArgs` lets it bubble so the CLI
 * dispatcher can attach the tool-help footer. */
export function coerce(s: Schema, raw: string): unknown {
  switch (s.kind) {
    case "number": {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`expected number, got "${raw}"`);
      if (s.int && !Number.isInteger(n)) throw new Error(`expected integer, got "${raw}"`);
      return n;
    }
    case "boolean":
      // Only the `--flag=VAL` form lands here. Bare `--flag` is set to true
      // by parseArgs without round-tripping through coerce.
      return raw === "true" || raw === "1";
    case "enum":
      if (!s.values.includes(raw)) {
        throw new Error(`expected one of ${s.values.join("|")}, got "${raw}"`);
      }
      return raw;
    default:
      return raw;
  }
}

export function typeHint(s: Schema): string {
  switch (s.kind) {
    case "array":
      return `${typeHint(arrayInner(s))}[,…]`;
    case "number":
      return "number";
    case "enum":
      return s.values.join("|");
    default:
      return "value";
  }
}

export function fieldDesc(s: Schema): string {
  return s.description ?? "";
}

/** Parse a tool's argv into a record matching its schema. Throws with a
 * human-readable message on malformed input. */
export function parseArgs(tool: ToolDef, argv: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const shape = tool.inputSchema as Record<string, Schema>;
  const positional = (tool.positional ?? []) as string[];
  let posIdx = 0;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    // Loop bound guarantees `tok` is defined; the explicit check satisfies
    // `noUncheckedIndexedAccess` without a `!` assertion. Same pattern below
    // for the `--flag VALUE` lookahead.
    if (tok === undefined) continue;
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      const flag = (eq === -1 ? tok.slice(2) : tok.slice(2, eq)).replace(/-/g, "_");
      const inline = eq === -1 ? undefined : tok.slice(eq + 1);
      const ty = shape[flag];
      if (!ty) throw new Error(`unknown flag: --${flag.replace(/_/g, "-")}`);
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
