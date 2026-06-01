import { isAbsolute, resolve } from "node:path";
import {
  allKindNames,
  capHover,
  formatCallHierarchyIncoming,
  formatCallHierarchyOutgoing,
  formatCodeActions,
  formatDiagnostic,
  formatHover,
  formatLocations,
  formatLocationsByFile,
  formatOutline,
  kindFromName,
  kindName,
  OUTLINE_PREAMBLE,
  uriToRel,
} from "./format.js";
import {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  CodeAction,
  Diagnostic,
  DocumentSymbol,
  Hover,
  Location,
  SymbolInformation,
  WorkspaceEdit,
} from "./lsp-client.js";
import { LocatorError, resolveLocator, SymbolLocator } from "./locator.js";
import { performFileRename } from "./rename-files.js";
import { applyWorkspaceEdit, summarizeRename } from "./rename.js";
import { expandFileArgs } from "./file-args.js";
import { s, type Infer, type Schema } from "./schema.js";
import { LspPool } from "./workspace.js";

export interface ToolResult {
  text: string;
  isError?: boolean;
  /** Signals "no findings" so fanout can suppress redundant per-item headers
   * when most/all items in a batch came back empty. Set by the per-item helpers
   * (referencesOne, diagnosticsOne, …) when the LSP returned nothing of
   * interest — not when there was an error. */
  empty?: boolean;
}

export type Shape = Record<string, Schema>;

export interface ToolDef<I extends Shape = Shape> {
  name: string;
  /** One-line description. Keep tight; surfaced as the CLI command help. */
  description: string;
  /** Per-tool schema shape. Field descriptions double as CLI flag help. */
  inputSchema: I;
  /** Optional: which fields can be passed as positional args, in order. */
  positional?: (keyof I & string)[];
  handler: (input: Infer<I>, ctx: ToolContext) => Promise<ToolResult>;
}

/** Wraps a tool definition so TypeScript captures each tool's inputSchema
 * generic — otherwise `const x: ToolDef = {...}` collapses field types to
 * unknown and every handler destructure fails to compile. */
function defineTool<I extends Shape>(d: ToolDef<I>): ToolDef<I> {
  return d;
}

export interface ToolContext {
  pool: LspPool;
  cwd: string;
}

const locatorShape = {
  file: s.str({ optional: true, description: "File path." }),
  line: s.int({ nonnegative: true, optional: true, description: "Zero-based line." }),
  character: s.int({
    nonnegative: true,
    optional: true,
    description: "Zero-based column. Use with line.",
  }),
  symbol: s.str({
    optional: true,
    description: "Identifier text. Workspace-wide alone, or scan a line with file+line.",
  }),
};

const ok = (text: string): ToolResult => ({ text });
const okEmpty = (text: string): ToolResult => ({ text, empty: true });
const fail = (text: string): ToolResult => ({ text, isError: true });

function abs(p: string, cwd: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p);
}

async function withLocator(
  ctx: ToolContext,
  loc: SymbolLocator,
  fn: (r: Awaited<ReturnType<typeof resolveLocator>>) => Promise<ToolResult>,
): Promise<ToolResult> {
  try {
    const resolved = await resolveLocator(ctx.pool, loc, ctx.cwd);
    return await fn(resolved);
  } catch (e) {
    if (e instanceof LocatorError) {
      let msg = e.message;
      if (e.candidates?.length) {
        msg += "\ncandidates:";
        for (const c of e.candidates.slice(0, 20)) {
          const where = c.location.uri.replace(/^file:\/\//, "");
          msg += `\n  ${kindName(c.kind)} ${c.name} — ${where}:${c.location.range.start.line + 1}`;
        }
      }
      return fail(msg);
    }
    return fail(String((e as Error).message ?? e));
  }
}

function renderSymbolList(matches: SymbolInformation[], root: string): string {
  if (!matches.length) return "no matches";
  return matches
    .map((s) => {
      const where = uriToRel(s.location.uri, root);
      const line = s.location.range.start.line + 1;
      const container = s.containerName ? `  (${s.containerName})` : "";
      return `${where}:${line}  ${kindName(s.kind)} ${s.name}${container}`;
    })
    .join("\n");
}

function renderRenameSummary(
  s: { files_changed: number; total_edits: number; files: string[]; preview?: string },
  dryRun: boolean,
): string {
  const verb = dryRun ? "would change" : "changed";
  const head = `${dryRun ? "[preview] " : ""}${verb} ${s.total_edits} site${s.total_edits === 1 ? "" : "s"} in ${s.files_changed} file${s.files_changed === 1 ? "" : "s"}`;
  const fileList = s.files.map((f) => `  ${f}`).join("\n");
  return s.preview ? `${head}\n${fileList}\n\n${s.preview}` : `${head}\n${fileList}`;
}

function severityFilter(sev: string): number {
  if (sev === "error") return 1;
  if (sev === "warning") return 2;
  if (sev === "info") return 3;
  return 4;
}

async function waitForDiagnostics(read: () => unknown, ms: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (read() !== undefined) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Run a per-item handler in parallel and join the outputs under labeled
 * headers. The LSP processes requests on one connection but tsgo pipelines
 * them, so fan-out beats sequential round-trips.
 *
 * Output is squeezed for tokens: items whose per-item helper marked
 * `empty: true` are dropped from the labeled block list. If every item was
 * empty (and none errored), the result is a single short line — the empty
 * sentinel from the first item — instead of N redundant `=== file ===\nno X`
 * blocks. Errors are always retained as labeled blocks because the caller
 * needs to know which item failed. */
export async function fanout<T>(
  items: T[],
  label: (item: T) => string,
  run: (item: T) => Promise<ToolResult>,
): Promise<ToolResult> {
  const results = await Promise.all(
    items.map(async (item) => {
      try {
        const r = await run(item);
        return { label: label(item), r };
      } catch (e) {
        return {
          label: label(item),
          r: { text: String((e as Error).message ?? e), isError: true } as ToolResult,
        };
      }
    }),
  );
  const errors = results.filter((x) => x.r.isError);
  const empties = results.filter((x) => !x.r.isError && x.r.empty);
  const findings = results.filter((x) => !x.r.isError && !x.r.empty);

  // All clean (no errors, no findings): collapse to one short line.
  if (!errors.length && !findings.length) {
    return { text: empties[0]?.r.text ?? "no results", empty: true };
  }
  // Emit only items that had something — findings first, then errors.
  const kept = [...findings, ...errors];
  const text = kept.map((x) => `=== ${x.label} ===\n${x.r.text}`).join("\n\n");
  return errors.length ? { text, isError: true } : { text };
}

const symbolsField = {
  symbols: s.arr(s.str({ min: 1 }), {
    optional: true,
    description:
      "Batch: list of symbol names. Runs each as a workspace query in parallel and labels output.",
  }),
};

// ---- tool defs ----

interface FindSymbolFilters {
  file?: string;
  limit?: number;
  kinds?: Set<number>;
  container?: string;
}

async function findSymbolOne(
  query: string,
  filters: FindSymbolFilters,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const { file, limit, kinds, container } = filters;
    const probePath = file ? abs(file, ctx.cwd) : ctx.cwd;
    const { client, root } = file
      ? await ctx.pool.forFile(probePath)
      : await (async () => {
          const c = await ctx.pool.forFile(probePath).catch(() => null);
          return c ?? { client: await ctx.pool.forRoot(probePath), root: probePath };
        })();
    let matches =
      (await client.request<SymbolInformation[] | null>("workspace/symbol", { query })) ?? [];
    if (kinds) matches = matches.filter((s) => kinds.has(s.kind));
    if (container) {
      const needle = container.toLowerCase();
      matches = matches.filter((s) => (s.containerName ?? "").toLowerCase().includes(needle));
    }
    matches = matches.slice(0, limit ?? 50);
    const visible = file
      ? (() => {
          const targetUri = abs(file, ctx.cwd);
          const filtered = matches.filter((s) => s.location.uri.endsWith(targetUri));
          return filtered.length ? filtered : matches;
        })()
      : matches;
    if (!visible.length) return okEmpty("no matches");
    return ok(renderSymbolList(visible, root));
  } catch (e) {
    return fail(String((e as Error).message ?? e));
  }
}

const findSymbol = defineTool({
  name: "find_symbol",
  description:
    "Search the workspace for symbols by name. Returns `path:line  kind name`. Fuzzy match. Pass multiple queries (positional or `--queries a,b,c`). Filter noise with `--kind` and `--container`.",
  positional: ["queries"],
  inputSchema: {
    query: s.str({ min: 1, optional: true, description: "Single substring to match." }),
    queries: s.arr(s.str({ min: 1 }), {
      optional: true,
      description: "Batch: list of substrings. Runs each as a workspace query.",
    }),
    file: s.str({ optional: true, description: "Restrict to this file." }),
    limit: s.int({ positive: true, max: 200, optional: true, description: "Default 50." }),
    kind: s.arr(s.str({ min: 1 }), {
      optional: true,
      description: "Keep only these LSP symbol kinds (class,function,interface,method,variable,…).",
    }),
    container: s.str({
      optional: true,
      description: "Only symbols whose containerName contains this substring (case-insensitive).",
    }),
  },
  handler: async ({ query, queries, file, limit, kind, container }, ctx) => {
    const list = [...(queries ?? []), ...(query ? [query] : [])];
    if (!list.length) return fail("find_symbol requires `query` or `queries`");
    let kinds: Set<number> | undefined;
    if (kind && kind.length) {
      const unknown: string[] = [];
      const set = new Set<number>();
      for (const name of kind) {
        const n = kindFromName(name);
        if (n === undefined) unknown.push(name);
        else set.add(n);
      }
      if (unknown.length) {
        return fail(
          `unknown --kind value(s): ${unknown.join(", ")}\nvalid: ${allKindNames().join(", ")}`,
        );
      }
      kinds = set;
    }
    const filters: FindSymbolFilters = { file, limit, kinds, container };
    if (list.length === 1) return findSymbolOne(list[0]!, filters, ctx);
    // Serialized, not fanout: tsgo's workspace/symbol races at cold-start when
    // multiple queries land concurrently — later queries can come back empty
    // while the index is still being built. Serializing trades a little latency
    // for correctness, and the caller still saves the CLI round-trips.
    return serialJoin(
      list,
      (q) => q,
      (q) => findSymbolOne(q, filters, ctx),
    );
  },
});

/** Serial counterpart to fanout — same output shape and empty-collapse rules,
 * but runs items one after another. Use for tools where the underlying LSP
 * request can't be safely parallelized (see find_symbol). */
async function serialJoin<T>(
  items: T[],
  label: (item: T) => string,
  run: (item: T) => Promise<ToolResult>,
): Promise<ToolResult> {
  const results: { label: string; r: ToolResult }[] = [];
  for (const item of items) {
    try {
      const r = await run(item);
      results.push({ label: label(item), r });
    } catch (e) {
      results.push({
        label: label(item),
        r: { text: String((e as Error).message ?? e), isError: true },
      });
    }
  }
  const errors = results.filter((x) => x.r.isError);
  const empties = results.filter((x) => !x.r.isError && x.r.empty);
  const findings = results.filter((x) => !x.r.isError && !x.r.empty);
  if (!errors.length && !findings.length) {
    return { text: empties[0]?.r.text ?? "no results", empty: true };
  }
  const kept = [...findings, ...errors];
  const text = kept.map((x) => `=== ${x.label} ===\n${x.r.text}`).join("\n\n");
  return errors.length ? { text, isError: true } : { text };
}

interface ReferencesOpts {
  include_declaration?: boolean;
  limit?: number;
  summary?: boolean;
}

/** Above this many refs, an unset `summary` auto-flips to grouped output —
 * 200 snippets for a popular symbol blows the token budget for no gain. The
 * caller can still force snippets with `--summary=false`. */
export const REFERENCES_AUTO_SUMMARY_THRESHOLD = 50;

/** Pure decision helper for the auto-summary flip. Auto kicks in only when
 * the caller didn't pass `summary` either way — an explicit `--summary=false`
 * keeps snippets even on huge ref sets, an explicit `--summary` always groups. */
export function shouldAutoSummarize(summary: boolean | undefined, refCount: number): boolean {
  return summary === undefined && refCount > REFERENCES_AUTO_SUMMARY_THRESHOLD;
}

async function referencesOne(
  loc: SymbolLocator,
  ctx: ToolContext,
  opts: ReferencesOpts,
): Promise<ToolResult> {
  return withLocator(ctx, loc, async ({ client, root, uri, position }) => {
    const refs =
      (await client.request<Location[] | null>("textDocument/references", {
        textDocument: { uri },
        position,
        context: { includeDeclaration: opts.include_declaration ?? true },
      })) ?? [];
    if (!refs.length) return okEmpty("no references");
    const auto = shouldAutoSummarize(opts.summary, refs.length);
    const useSummary = opts.summary === true || auto;
    if (useSummary) {
      // Same default as the non-summary path. Caps FILES, not refs — per-file
      // counts stay accurate even when the file list is truncated.
      const cap = opts.limit ?? 200;
      const { text, files, omitted } = formatLocationsByFile(refs, root, cap);
      const autoTag = auto ? " (auto-summarized; pass --summary=false for snippets)" : "";
      const head = `${refs.length} ref${refs.length === 1 ? "" : "s"} across ${files} file${files === 1 ? "" : "s"}${autoTag}`;
      const trailer = omitted > 0 ? `\n+${omitted} more files (raise --limit)` : "";
      return ok(`${head}\n${text}${trailer}`);
    }
    const f = await formatLocations(refs, root, opts.limit ?? 200);
    return ok(f.text);
  });
}

const references = defineTool({
  name: "references",
  description:
    "All references to a symbol. Single locator, or batch via `symbols`. `--summary` groups by file (`path (N): l1, l2, …`) — huge token cut for popular symbols.",
  inputSchema: {
    ...locatorShape,
    ...symbolsField,
    include_declaration: s.bool({
      optional: true,
      description: "Include declaration. Default true.",
    }),
    limit: s.int({ positive: true, max: 500, optional: true, description: "Default 200." }),
    summary: s.bool({
      optional: true,
      description: `Group refs by file (\`path (N): lines\`); drops snippets. Auto-flips on when refs > ${REFERENCES_AUTO_SUMMARY_THRESHOLD}; pass \`--summary=false\` to keep snippets.`,
    }),
  },
  handler: async ({ symbols, include_declaration, limit, summary, ...loc }, ctx) => {
    const opts: ReferencesOpts = { include_declaration, limit, summary };
    if (symbols && symbols.length) {
      return fanout(
        symbols,
        (s) => s,
        (s) => referencesOne({ symbol: s }, ctx, opts),
      );
    }
    return referencesOne(loc as SymbolLocator, ctx, opts);
  },
});

async function locationsOne(
  method: "textDocument/definition" | "textDocument/typeDefinition" | "textDocument/implementation",
  emptyMsg: string,
  cap: number,
  loc: SymbolLocator,
  ctx: ToolContext,
): Promise<ToolResult> {
  return withLocator(ctx, loc, async ({ client, root, uri, position }) => {
    const result = await client.request<Location | Location[] | null>(method, {
      textDocument: { uri },
      position,
    });
    const arr = !result ? [] : Array.isArray(result) ? result : [result];
    if (!arr.length) return okEmpty(emptyMsg);
    const f = await formatLocations(arr, root, cap);
    return ok(f.text);
  });
}

const definition = defineTool({
  name: "definition",
  description: "Where a symbol is defined. Single locator, or batch via `symbols`.",
  inputSchema: { ...locatorShape, ...symbolsField },
  handler: async ({ symbols, ...loc }, ctx) => {
    if (symbols && symbols.length) {
      return fanout(
        symbols,
        (s) => s,
        (s) => locationsOne("textDocument/definition", "no definition", 20, { symbol: s }, ctx),
      );
    }
    return locationsOne("textDocument/definition", "no definition", 20, loc as SymbolLocator, ctx);
  },
});

const typeDefinition = defineTool({
  name: "type_definition",
  description:
    "Type declaration of a symbol (vs. value declaration). Single locator, or batch via `symbols`.",
  inputSchema: { ...locatorShape, ...symbolsField },
  handler: async ({ symbols, ...loc }, ctx) => {
    if (symbols && symbols.length) {
      return fanout(
        symbols,
        (s) => s,
        (s) =>
          locationsOne("textDocument/typeDefinition", "no type definition", 20, { symbol: s }, ctx),
      );
    }
    return locationsOne(
      "textDocument/typeDefinition",
      "no type definition",
      20,
      loc as SymbolLocator,
      ctx,
    );
  },
});

const implementation = defineTool({
  name: "implementation",
  description:
    "Concrete implementations of an interface/abstract member. Single locator, or batch via `symbols`.",
  inputSchema: { ...locatorShape, ...symbolsField },
  handler: async ({ symbols, ...loc }, ctx) => {
    if (symbols && symbols.length) {
      return fanout(
        symbols,
        (s) => s,
        (s) =>
          locationsOne(
            "textDocument/implementation",
            "no implementations",
            100,
            { symbol: s },
            ctx,
          ),
      );
    }
    return locationsOne(
      "textDocument/implementation",
      "no implementations",
      100,
      loc as SymbolLocator,
      ctx,
    );
  },
});

const rename = defineTool({
  name: "rename",
  description: "Type-aware symbol rename across all files. Pass dry_run for a preview.",
  inputSchema: {
    ...locatorShape,
    new_name: s.str({ min: 1, description: "New identifier." }),
    dry_run: s.bool({ optional: true, description: "Preview without writing." }),
  },
  handler: async ({ new_name, dry_run, ...loc }, ctx) =>
    withLocator(ctx, loc as SymbolLocator, async ({ client, root, uri, position }) => {
      const edit = await client.request<WorkspaceEdit | null>("textDocument/rename", {
        textDocument: { uri },
        position,
        newName: new_name,
      });
      if (!edit || (!edit.changes && !edit.documentChanges)) {
        return ok("no rename available at this position");
      }
      if (dry_run) {
        const summary = await summarizeRename(edit, root, true);
        return ok(renderRenameSummary(summary, true));
      }
      const summary = await applyWorkspaceEdit(client, edit, root);
      return ok(renderRenameSummary(summary, false));
    }),
});

const renameFile = defineTool({
  name: "rename_file",
  description:
    "Move/rename a file or folder and update every import that references it. Pass dry_run to preview.",
  positional: ["old_path", "new_path"],
  inputSchema: {
    old_path: s.str({ min: 1, description: "Existing file or folder path." }),
    new_path: s.str({ min: 1, description: "Destination path." }),
    dry_run: s.bool({
      optional: true,
      description: "Preview moves + import changes without writing.",
    }),
  },
  handler: async ({ old_path, new_path, dry_run }, ctx) => {
    try {
      const oldAbs = abs(old_path, ctx.cwd);
      const newAbs = abs(new_path, ctx.cwd);
      const { client, root } = await ctx.pool.forFile(oldAbs);
      const summary = await performFileRename(client, root, oldAbs, newAbs, dry_run ?? false);
      const moveWord = (n: number) => `${n} path${n === 1 ? "" : "s"}`;
      const editWord = (n: number) => `${n} import${n === 1 ? "" : "s"}`;
      const fileWord = (n: number) => `${n} file${n === 1 ? "" : "s"}`;
      const head = dry_run
        ? `[preview] would move ${moveWord(summary.moves.length)}, update ${editWord(summary.edits_applied)} in ${fileWord(summary.files_with_import_changes)}`
        : `moved ${moveWord(summary.moves.length)}, updated ${editWord(summary.edits_applied)} in ${fileWord(summary.files_with_import_changes)}`;
      const moves = summary.moves.map((m) => `  ${m.from} -> ${m.to}`).join("\n");
      const importBlock = summary.import_files.length
        ? `\nimport changes:\n${summary.import_files.map((f) => `  ${f}`).join("\n")}`
        : "";
      return ok(`${head}\n${moves}${importBlock}`);
    } catch (e) {
      return fail(String((e as Error).message ?? e));
    }
  },
});

async function hoverOne(
  loc: SymbolLocator,
  ctx: ToolContext,
  opts: { full?: boolean },
): Promise<ToolResult> {
  return withLocator(ctx, loc, async ({ client, uri, position }) => {
    const h = await client.request<Hover | null>("textDocument/hover", {
      textDocument: { uri },
      position,
    });
    const text = capHover(formatHover(h), opts.full);
    return h ? ok(text) : okEmpty(text);
  });
}

const hover = defineTool({
  name: "hover",
  description: "Type signature + JSDoc for a symbol. Single locator, or batch via `symbols`.",
  inputSchema: {
    ...locatorShape,
    ...symbolsField,
    full: s.bool({
      optional: true,
      description: "Skip the 800-char hover cap — return the entire JSDoc/type blob.",
    }),
  },
  handler: async ({ symbols, full, ...loc }, ctx) => {
    if (symbols && symbols.length) {
      return fanout(
        symbols,
        (s) => s,
        (s) => hoverOne({ symbol: s }, ctx, { full }),
      );
    }
    return hoverOne(loc as SymbolLocator, ctx, { full });
  },
});

interface OutlineOpts {
  maxDepth?: number;
  kinds?: Set<number>;
}

async function outlineOne(file: string, opts: OutlineOpts, ctx: ToolContext): Promise<ToolResult> {
  try {
    const filePath = abs(file, ctx.cwd);
    const { client } = await ctx.pool.forFile(filePath);
    const uri = await client.syncOpen(filePath);
    const result = await client.request<DocumentSymbol[] | SymbolInformation[] | null>(
      "textDocument/documentSymbol",
      { textDocument: { uri } },
    );
    if (!result || !result.length) return okEmpty("(empty)");
    if ("range" in result[0]!) {
      const text = formatOutline(result as DocumentSymbol[], {
        maxDepth: opts.maxDepth,
        kinds: opts.kinds,
      });
      return text === "(empty)" ? okEmpty(text) : ok(text);
    }
    // SymbolInformation[] (flat). Filter by kind only; depth is meaningless.
    let flat = result as SymbolInformation[];
    if (opts.kinds) flat = flat.filter((s) => opts.kinds!.has(s.kind));
    if (!flat.length) return okEmpty("(empty)");
    return ok(
      flat
        .map((s) => `${s.location.range.start.line + 1}: ${kindName(s.kind)} ${s.name}`)
        .join("\n"),
    );
  } catch (e) {
    return fail(String((e as Error).message ?? e));
  }
}

const outline = defineTool({
  name: "outline",
  description:
    "Indented declaration outline of one or more files. Accepts globs and directories — `outline 'src/**/*.ts'` or `outline src/api/`. Tighten with `--depth` / `--kind`.",
  positional: ["files"],
  inputSchema: {
    file: s.str({ optional: true, description: "Single file path." }),
    files: s.arr(s.str({}), {
      optional: true,
      description:
        "Batch: literal paths, directories (recursive walk), or globs (`'src/**/*.ts'`).",
    }),
    depth: s.int({
      nonnegative: true,
      optional: true,
      description: "Max nesting depth. 0 = top-level only.",
    }),
    kind: s.arr(s.str({ min: 1 }), {
      optional: true,
      description: "Keep only these kinds (class,function,interface,method,…).",
    }),
  },
  handler: async ({ file, files, depth, kind }, ctx) => {
    const inputs = files && files.length ? files : file ? [file] : [];
    if (!inputs.length) return fail("outline requires `file` or `files`");
    let kinds: Set<number> | undefined;
    if (kind && kind.length) {
      const unknown: string[] = [];
      const set = new Set<number>();
      for (const name of kind) {
        const n = kindFromName(name);
        if (n === undefined) unknown.push(name);
        else set.add(n);
      }
      if (unknown.length) {
        return fail(
          `unknown --kind value(s): ${unknown.join(", ")}\nvalid: ${allKindNames().join(", ")}`,
        );
      }
      kinds = set;
    }
    const opts: OutlineOpts = { maxDepth: depth, kinds };
    const list = await expandFileArgs(inputs, ctx.cwd);
    if (!list.length) return okEmpty("no matching files");
    const result =
      list.length === 1
        ? await outlineOne(list[0]!, opts, ctx)
        : await fanout(
            list,
            (f) => f,
            (f) => outlineOne(f, opts, ctx),
          );
    return withOutlinePreamble(result);
  },
});

/** Prepend the format-key preamble once at the top of the outline output —
 * not per-file in batched runs. Skips empty/error results so the preamble
 * never appears alone above a one-liner like `(empty)` or `no matching files`. */
function withOutlinePreamble(r: ToolResult): ToolResult {
  if (r.empty || r.isError || !r.text) return r;
  return { ...r, text: `${OUTLINE_PREAMBLE}\n${r.text}` };
}

/** Prepend a one-line summary (`3 errors, 1 warn across 2 files`) to a
 * batched diagnostics result so Claude can scan severity before reading
 * details. No-op when the batch collapsed to a single short empty marker. */
function prependDiagnosticsHeader(r: ToolResult): ToolResult {
  if (r.empty || !r.text) return r;
  const errors = (r.text.match(/\[error\]/g) ?? []).length;
  const warns = (r.text.match(/\[warn\]/g) ?? []).length;
  const infos = (r.text.match(/\[info\]/g) ?? []).length;
  const hints = (r.text.match(/\[hint\]/g) ?? []).length;
  const files = new Set(r.text.match(/^=== (.+) ===$/gm) ?? []).size || 1;
  const parts: string[] = [];
  if (errors) parts.push(`${errors} error${errors === 1 ? "" : "s"}`);
  if (warns) parts.push(`${warns} warn${warns === 1 ? "" : "s"}`);
  if (infos) parts.push(`${infos} info`);
  if (hints) parts.push(`${hints} hint${hints === 1 ? "" : "s"}`);
  if (!parts.length) return r;
  const head = `${parts.join(", ")} across ${files} file${files === 1 ? "" : "s"}`;
  return { ...r, text: `${head}\n\n${r.text}` };
}

async function diagnosticsOne(file: string, minSev: number, ctx: ToolContext): Promise<ToolResult> {
  try {
    const filePath = abs(file, ctx.cwd);
    const { client, root } = await ctx.pool.forFile(filePath);
    const uri = await client.syncOpen(filePath);
    await waitForDiagnostics(() => client.diagnosticsFor(uri), 2000);
    const diags = (client.diagnosticsFor(uri) ?? []).filter(
      (d: Diagnostic) => (d.severity ?? 1) <= minSev,
    );
    if (!diags.length) return okEmpty("no diagnostics");
    return ok(diags.map((d) => formatDiagnostic(d, uriToRel(uri, root))).join("\n"));
  } catch (e) {
    return fail(String((e as Error).message ?? e));
  }
}

const diagnostics = defineTool({
  name: "diagnostics",
  description:
    "Type errors + warnings. Accepts files, directories, or globs (`diagnostics 'src/**/*.ts'`). With no args, aggregates across every open file.",
  positional: ["files"],
  inputSchema: {
    file: s.str({ optional: true, description: "Single file path." }),
    files: s.arr(s.str({}), {
      optional: true,
      description:
        "Batch: literal paths, directories (recursive walk), or globs (`'src/**/*.ts'`).",
    }),
    severity: s.pick(["error", "warning", "info", "all"] as const, {
      optional: true,
      description: "Default warning+error.",
    }),
  },
  handler: async ({ file, files, severity }, ctx) => {
    const minSev = severityFilter(severity ?? "warning");
    const inputs = files && files.length ? files : file ? [file] : [];
    const list = inputs.length ? await expandFileArgs(inputs, ctx.cwd) : [];
    if (inputs.length && !list.length) return okEmpty("no matching files");
    if (list.length === 1) return diagnosticsOne(list[0]!, minSev, ctx);
    if (list.length > 1) {
      const batched = await fanout(
        list,
        (f) => f,
        (f) => diagnosticsOne(f, minSev, ctx),
      );
      return prependDiagnosticsHeader(batched);
    }
    // No file given — aggregate across every open URI in every pool client.
    try {
      const lines: string[] = [];
      for (const root of ctx.pool.roots()) {
        const client = await ctx.pool.forRoot(root);
        for (const [uri, diags] of client.diagnosticsAll()) {
          const filtered = diags.filter((d: Diagnostic) => (d.severity ?? 1) <= minSev);
          for (const d of filtered) lines.push(formatDiagnostic(d, uriToRel(uri, root)));
        }
      }
      return ok(lines.length ? lines.join("\n") : "no diagnostics");
    } catch (e) {
      return fail(String((e as Error).message ?? e));
    }
  },
});

const callHierarchy = defineTool({
  name: "call_hierarchy",
  description:
    "Callers and/or callees of the function at a position. direction: incoming | outgoing | both (default both).",
  inputSchema: {
    ...locatorShape,
    direction: s.pick(["incoming", "outgoing", "both"] as const, {
      optional: true,
      description: "Default both.",
    }),
  },
  handler: async ({ direction, ...loc }, ctx) =>
    withLocator(ctx, loc as SymbolLocator, async ({ client, root, uri, position }) => {
      const items = await client.request<CallHierarchyItem[] | null>(
        "textDocument/prepareCallHierarchy",
        { textDocument: { uri }, position },
      );
      if (!items || !items.length) return ok("no call hierarchy at this position");
      const dir = direction ?? "both";
      const blocks: string[] = [];
      for (const item of items) {
        blocks.push(`# ${callItemHeader(item, root)}`);
        if (dir === "incoming" || dir === "both") {
          const incoming =
            (await client.request<CallHierarchyIncomingCall[] | null>(
              "callHierarchy/incomingCalls",
              { item },
            )) ?? [];
          blocks.push(`callers:\n${formatCallHierarchyIncoming(incoming, root)}`);
        }
        if (dir === "outgoing" || dir === "both") {
          const outgoing =
            (await client.request<CallHierarchyOutgoingCall[] | null>(
              "callHierarchy/outgoingCalls",
              { item },
            )) ?? [];
          blocks.push(`callees:\n${formatCallHierarchyOutgoing(outgoing, root)}`);
        }
      }
      return ok(blocks.join("\n\n"));
    }),
});

function callItemHeader(item: CallHierarchyItem, root: string): string {
  const rel = uriToRel(item.uri, root);
  const line = item.selectionRange.start.line + 1;
  return `${rel}:${line}  ${kindName(item.kind)} ${item.name}`;
}

const codeAction = defineTool({
  name: "code_action",
  description:
    "List or apply code actions (quick fixes, refactors, organize-imports). `apply: N` applies an index from the most recent list — indices aren't stable across calls.",
  inputSchema: {
    file: s.str({ description: "File path." }),
    line: s.int({
      nonnegative: true,
      optional: true,
      description: "Zero-based line. Omit for whole-file actions.",
    }),
    character: s.int({ nonnegative: true, optional: true, description: "Zero-based column." }),
    end_line: s.int({
      nonnegative: true,
      optional: true,
      description: "Zero-based end line. Defaults to line.",
    }),
    end_character: s.int({
      nonnegative: true,
      optional: true,
      description: "Zero-based end column. Defaults to character.",
    }),
    kind: s.str({
      optional: true,
      description: "Filter by action kind, e.g. source.organizeImports, quickfix.",
    }),
    only_preferred: s.bool({ optional: true, description: "Only return preferred actions." }),
    apply: s.int({
      nonnegative: true,
      optional: true,
      description: "Index of an action to apply (writes to disk).",
    }),
  },
  handler: async (
    { file, line, character, end_line, end_character, kind, only_preferred, apply },
    ctx,
  ) => {
    try {
      const filePath = abs(file, ctx.cwd);
      const { client, root } = await ctx.pool.forFile(filePath);
      const uri = await client.syncOpen(filePath);
      const sl = line ?? 0;
      const sc = character ?? 0;
      const el = end_line ?? sl;
      const ec = end_character ?? sc;
      // Diagnostics arrive async after didOpen. Wait briefly so context-keyed
      // quick-fixes (which depend on overlapping diagnostics) are surfaced.
      await waitForDiagnostics(() => client.diagnosticsFor(uri), 2000);
      const diags = (client.diagnosticsFor(uri) ?? []).filter((d) =>
        overlaps(d.range, sl, sc, el, ec),
      );
      const result =
        (await client.request<(CodeAction & { command?: unknown })[] | null>(
          "textDocument/codeAction",
          {
            textDocument: { uri },
            range: { start: { line: sl, character: sc }, end: { line: el, character: ec } },
            context: {
              diagnostics: diags,
              only: kind ? [kind] : undefined,
            },
          },
        )) ?? [];
      let actions = result.filter(
        (a) => typeof a === "object" && a !== null && "title" in a,
      ) as CodeAction[];
      if (only_preferred) actions = actions.filter((a) => a.isPreferred);
      if (apply !== undefined) {
        const target = actions[apply];
        if (!target) return fail(`no action at index ${apply} (have ${actions.length})`);
        // LSP permits a server to omit `edit` and require `codeAction/resolve`
        // before applying. tsgo sometimes does this for source actions.
        let resolved: CodeAction = target;
        if (!resolved.edit) {
          try {
            const r = await client.request<CodeAction | null>("codeAction/resolve", target);
            if (r) resolved = r;
          } catch {
            // Fall through — we'll surface a clearer error if edit still missing.
          }
        }
        if (resolved.edit) {
          const summary = await applyWorkspaceEdit(client, resolved.edit, root);
          return ok(`applied: ${resolved.title}\n${renderRenameSummary({ ...summary }, false)}`);
        }
        if (resolved.command) {
          // Command-based actions are server-defined; without executeCommand
          // support we can't run them in-process. Surface the command so the
          // caller can choose a different action.
          return fail(
            `action "${resolved.title}" is command-driven (${resolved.command.command}); not yet supported`,
          );
        }
        return fail(`action "${resolved.title}" has no edit attached after resolve`);
      }
      return ok(formatCodeActions(actions));
    } catch (e) {
      return fail(String((e as Error).message ?? e));
    }
  },
});

function overlaps(
  range: Diagnostic["range"],
  sl: number,
  sc: number,
  el: number,
  ec: number,
): boolean {
  const aStart = range.start.line * 1e6 + range.start.character;
  const aEnd = range.end.line * 1e6 + range.end.character;
  const bStart = sl * 1e6 + sc;
  const bEnd = el * 1e6 + ec;
  return aStart <= bEnd && bStart <= aEnd;
}

// `ToolDef<any>` is intentional: each tool's handler is contravariant in its
// input shape, so a `ToolDef<{ query: StrSchema }>` is not assignable to
// `ToolDef<Shape>`. The `defineTool` helper still gives each individual
// declaration full per-tool type-checking — `any` only widens the array slot.
export const TOOLS: ToolDef<any>[] = [
  findSymbol,
  references,
  definition,
  typeDefinition,
  implementation,
  rename,
  renameFile,
  hover,
  outline,
  diagnostics,
  callHierarchy,
  codeAction,
];

export function getTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name || t.name.replace(/_/g, "-") === name);
}
