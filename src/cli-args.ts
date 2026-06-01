import type { ArrSchema, EnumSchema, NumSchema, Schema } from "./schema.js";
import type { ToolDef } from "./tools.js";

export function isBoolean(s: Schema): boolean {
  return s.kind === "boolean";
}

export function isArray(s: Schema): boolean {
  return s.kind === "array";
}

export function arrayInner(s: Schema): Schema {
  return s.kind === "array" ? (s as ArrSchema).element : s;
}

export function enumValues(s: Schema): string[] {
  return s.kind === "enum" ? [...(s as EnumSchema).values] : [];
}

/** Coerce a string token from argv into the schema's runtime type. Throws
 * with a human-readable message — `parseArgs` lets it bubble so the CLI
 * dispatcher can attach the tool-help footer. */
export function coerce(s: Schema, raw: string): unknown {
  switch (s.kind) {
    case "number": {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`expected number, got "${raw}"`);
      if ((s as NumSchema).int && !Number.isInteger(n)) {
        throw new Error(`expected integer, got "${raw}"`);
      }
      return n;
    }
    case "boolean":
      // Only the `--flag=VAL` form lands here. Bare `--flag` is set to true
      // by parseArgs without round-tripping through coerce.
      return raw === "true" || raw === "1";
    case "enum": {
      const values = (s as EnumSchema).values;
      if (!values.includes(raw)) {
        throw new Error(`expected one of ${values.join("|")}, got "${raw}"`);
      }
      return raw;
    }
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
      return (s as EnumSchema).values.join("|");
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
