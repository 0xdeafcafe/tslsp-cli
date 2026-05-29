import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  CodeAction,
  Diagnostic,
  DocumentSymbol,
  Hover,
  Location,
} from "./lsp-client.js";

const SNIPPET_MAX = 120;

export function uriToRel(uri: string, root: string): string {
  const abs = uri.startsWith("file://") ? fileURLToPath(uri) : uri;
  const rel = relative(root, abs);
  return rel || abs;
}

/** Format a Location with a snippet of the source line. Used for refs/definitions. */
export async function formatLocation(loc: Location, root: string): Promise<string> {
  const rel = uriToRel(loc.uri, root);
  const line = loc.range.start.line;
  const col = loc.range.start.character;
  let snippet = "";
  try {
    const text = await readFile(fileURLToPath(loc.uri), "utf8");
    const lines = text.split(/\r?\n/);
    const raw = lines[line] ?? "";
    snippet = raw.trim();
    if (snippet.length > SNIPPET_MAX) snippet = snippet.slice(0, SNIPPET_MAX - 1) + "…";
  } catch {
    // Best-effort; absence of snippet is fine.
  }
  return snippet ? `${rel}:${line + 1}:${col + 1}  ${snippet}` : `${rel}:${line + 1}:${col + 1}`;
}

export async function formatLocations(
  locs: Location[],
  root: string,
  cap = 200,
): Promise<{ text: string; total: number; returned: number }> {
  const total = locs.length;
  const slice = locs.slice(0, cap);
  const lines = await Promise.all(slice.map((l) => formatLocation(l, root)));
  const truncated =
    total > cap ? `\n(showing ${cap} of ${total} — narrow the query to see more)` : "";
  return { text: lines.join("\n") + truncated, total, returned: slice.length };
}

export function formatHover(hover: Hover | null): string {
  if (!hover) return "no hover information at this position";
  const c = hover.contents;
  let text: string;
  if (typeof c === "string") text = c;
  else if (Array.isArray(c)) {
    text = c
      .map((x) => (typeof x === "string" ? x : ((x as { value?: string }).value ?? "")))
      .filter(Boolean)
      .join("\n\n");
  } else if (c && typeof c === "object" && "value" in c) {
    text = (c as { value: string }).value;
  } else {
    text = "";
  }
  return trimHover(text);
}

/** Strip the noisy bits from tsgo's hover markdown — code fences fine, but drop "Loading..."-style fluff. */
function trimHover(s: string): string {
  return s
    .replace(/```typescript\n/g, "```ts\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const SYMBOL_KIND: Record<number, string> = {
  1: "file",
  2: "module",
  3: "namespace",
  4: "package",
  5: "class",
  6: "method",
  7: "property",
  8: "field",
  9: "constructor",
  10: "enum",
  11: "interface",
  12: "function",
  13: "variable",
  14: "constant",
  15: "string",
  16: "number",
  17: "boolean",
  18: "array",
  19: "object",
  20: "key",
  21: "null",
  22: "enum-member",
  23: "struct",
  24: "event",
  25: "operator",
  26: "type-param",
};

export function kindName(k: number): string {
  return SYMBOL_KIND[k] ?? `kind${k}`;
}

export function formatOutline(symbols: DocumentSymbol[]): string {
  const out: string[] = [];
  const walk = (nodes: DocumentSymbol[], depth: number) => {
    for (const n of nodes) {
      const indent = "  ".repeat(depth);
      const sig = n.detail ? ` ${n.detail}` : "";
      const line = n.range.start.line + 1;
      out.push(`${indent}${kindName(n.kind)} ${n.name}${sig}  (line ${line})`);
      if (n.children?.length) walk(n.children, depth + 1);
    }
  };
  walk(symbols, 0);
  return out.length ? out.join("\n") : "(empty)";
}

const SEVERITY: Record<number, string> = { 1: "error", 2: "warn", 3: "info", 4: "hint" };

export function formatDiagnostic(d: Diagnostic, rel: string): string {
  const sev = SEVERITY[d.severity ?? 1] ?? "error";
  const line = d.range.start.line + 1;
  const col = d.range.start.character + 1;
  const code = d.code !== undefined ? ` (${d.code})` : "";
  return `${rel}:${line}:${col} [${sev}]${code} ${d.message.replace(/\n/g, " ")}`;
}

function callItemLabel(item: CallHierarchyItem, root: string): string {
  const rel = uriToRel(item.uri, root);
  const line = item.selectionRange.start.line + 1;
  return `${rel}:${line}  ${kindName(item.kind)} ${item.name}`;
}

export function formatCallHierarchyIncoming(
  calls: CallHierarchyIncomingCall[],
  root: string,
): string {
  if (!calls.length) return "no callers";
  return calls
    .map((c) => {
      const ranges = c.fromRanges
        .map((r) => r.start.line + 1)
        .slice(0, 5)
        .join(",");
      const extra = c.fromRanges.length > 5 ? `,+${c.fromRanges.length - 5}` : "";
      return `${callItemLabel(c.from, root)}  (calls@${ranges}${extra})`;
    })
    .join("\n");
}

export function formatCallHierarchyOutgoing(
  calls: CallHierarchyOutgoingCall[],
  root: string,
): string {
  if (!calls.length) return "no callees";
  return calls
    .map((c) => {
      const ranges = c.fromRanges
        .map((r) => r.start.line + 1)
        .slice(0, 5)
        .join(",");
      const extra = c.fromRanges.length > 5 ? `,+${c.fromRanges.length - 5}` : "";
      return `${callItemLabel(c.to, root)}  (from@${ranges}${extra})`;
    })
    .join("\n");
}

export function formatCodeActions(actions: CodeAction[]): string {
  if (!actions.length) return "no code actions";
  return actions
    .map((a, i) => {
      const kind = a.kind ? ` [${a.kind}]` : "";
      const pref = a.isPreferred ? " *" : "";
      return `${i}: ${a.title}${kind}${pref}`;
    })
    .join("\n");
}
