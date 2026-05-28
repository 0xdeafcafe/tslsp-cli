import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import {
  formatCallHierarchyIncoming,
  formatCallHierarchyOutgoing,
  formatCodeActions,
  formatDiagnostic,
  formatHover,
  formatLocations,
  formatOutline,
  kindName,
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
import { LspPool } from "./workspace.js";

export interface ToolResult {
  text: string;
  isError?: boolean;
}

export interface ToolDef<I extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  /** One-line MCP description. Keep tight; the CLI uses the same text. */
  description: string;
  /** Per-tool zod shape. Field descriptions double as CLI flag help. */
  inputSchema: I;
  /** Optional: which fields can be passed as positional args, in order. */
  positional?: (keyof I & string)[];
  handler: (input: z.infer<z.ZodObject<I>>, ctx: ToolContext) => Promise<ToolResult>;
}

/** Wraps a tool definition so TypeScript captures each tool's inputSchema
 * generic — otherwise `const x: ToolDef = {...}` collapses field types to
 * unknown and every handler destructure fails to compile. */
function defineTool<I extends z.ZodRawShape>(d: ToolDef<I>): ToolDef<I> {
  return d;
}

export interface ToolContext {
  pool: LspPool;
  cwd: string;
}

const locatorShape = {
  file: z.string().optional().describe("File path."),
  line: z.number().int().nonnegative().optional().describe("Zero-based line."),
  character: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Zero-based column. Use with line."),
  symbol: z
    .string()
    .optional()
    .describe("Identifier text. Workspace-wide alone, or scan a line with file+line."),
};

const ok = (text: string): ToolResult => ({ text });
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
 * them, so fan-out beats sequential round-trips. */
async function fanout<T>(
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
  const text = results.map((x) => `=== ${x.label} ===\n${x.r.text}`).join("\n\n");
  const anyError = results.some((x) => x.r.isError);
  return anyError ? { text, isError: true } : { text };
}

const symbolsField = {
  symbols: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Batch: list of symbol names. Runs each as a workspace query in parallel and labels output.",
    ),
};

// ---- tool defs ----

const findSymbol = defineTool({
  name: "find_symbol",
  description:
    "Search the workspace for symbols by name. Returns `path:line  kind name`. Fuzzy match.",
  positional: ["query"],
  inputSchema: {
    query: z.string().min(1).describe("Substring to match."),
    file: z.string().optional().describe("Restrict to this file."),
    limit: z.number().int().positive().max(200).optional().describe("Default 50."),
  },
  handler: async ({ query, file, limit }, ctx) => {
    try {
      const probePath = file ? abs(file, ctx.cwd) : ctx.cwd;
      const { client, root } = file
        ? await ctx.pool.forFile(probePath)
        : await (async () => {
            const c = await ctx.pool.forFile(probePath).catch(() => null);
            return c ?? { client: await ctx.pool.forRoot(probePath), root: probePath };
          })();
      const matches = (
        (await client.request<SymbolInformation[] | null>("workspace/symbol", { query })) ?? []
      ).slice(0, limit ?? 50);
      if (file) {
        const targetUri = abs(file, ctx.cwd);
        const filtered = matches.filter((s) => s.location.uri.endsWith(targetUri));
        return ok(renderSymbolList(filtered.length ? filtered : matches, root));
      }
      return ok(renderSymbolList(matches, root));
    } catch (e) {
      return fail(String((e as Error).message ?? e));
    }
  },
});

async function referencesOne(
  loc: SymbolLocator,
  ctx: ToolContext,
  include_declaration: boolean | undefined,
  limit: number | undefined,
): Promise<ToolResult> {
  return withLocator(ctx, loc, async ({ client, root, uri, position }) => {
    const refs =
      (await client.request<Location[] | null>("textDocument/references", {
        textDocument: { uri },
        position,
        context: { includeDeclaration: include_declaration ?? true },
      })) ?? [];
    if (!refs.length) return ok("no references");
    const f = await formatLocations(refs, root, limit ?? 200);
    return ok(f.text);
  });
}

const references = defineTool({
  name: "references",
  description:
    "All references to a symbol. Single locator, or batch via `symbols` (array, parallel).",
  inputSchema: {
    ...locatorShape,
    ...symbolsField,
    include_declaration: z.boolean().optional().describe("Include declaration. Default true."),
    limit: z.number().int().positive().max(500).optional().describe("Default 200."),
  },
  handler: async ({ symbols, include_declaration, limit, ...loc }, ctx) => {
    if (symbols && symbols.length) {
      return fanout(
        symbols,
        (s) => s,
        (s) => referencesOne({ symbol: s }, ctx, include_declaration, limit),
      );
    }
    return referencesOne(loc as SymbolLocator, ctx, include_declaration, limit);
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
    if (!arr.length) return ok(emptyMsg);
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
    new_name: z.string().min(1).describe("New identifier."),
    dry_run: z.boolean().optional().describe("Preview without writing."),
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
    old_path: z.string().min(1).describe("Existing file or folder path."),
    new_path: z.string().min(1).describe("Destination path."),
    dry_run: z.boolean().optional().describe("Preview moves + import changes without writing."),
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

async function hoverOne(loc: SymbolLocator, ctx: ToolContext): Promise<ToolResult> {
  return withLocator(ctx, loc, async ({ client, uri, position }) => {
    const h = await client.request<Hover | null>("textDocument/hover", {
      textDocument: { uri },
      position,
    });
    return ok(formatHover(h));
  });
}

const hover = defineTool({
  name: "hover",
  description: "Type signature + JSDoc for a symbol. Single locator, or batch via `symbols`.",
  inputSchema: { ...locatorShape, ...symbolsField },
  handler: async ({ symbols, ...loc }, ctx) => {
    if (symbols && symbols.length) {
      return fanout(
        symbols,
        (s) => s,
        (s) => hoverOne({ symbol: s }, ctx),
      );
    }
    return hoverOne(loc as SymbolLocator, ctx);
  },
});

async function outlineOne(file: string, ctx: ToolContext): Promise<ToolResult> {
  try {
    const filePath = abs(file, ctx.cwd);
    const { client } = await ctx.pool.forFile(filePath);
    const uri = await client.syncOpen(filePath);
    const result = await client.request<DocumentSymbol[] | SymbolInformation[] | null>(
      "textDocument/documentSymbol",
      { textDocument: { uri } },
    );
    if (!result || !result.length) return ok("(empty)");
    if ("range" in result[0]!) return ok(formatOutline(result as DocumentSymbol[]));
    const flat = result as SymbolInformation[];
    return ok(
      flat
        .map((s) => `${kindName(s.kind)} ${s.name}  (line ${s.location.range.start.line + 1})`)
        .join("\n"),
    );
  } catch (e) {
    return fail(String((e as Error).message ?? e));
  }
}

const outline = defineTool({
  name: "outline",
  description: "Indented declaration outline of one or more files. Use before reading a big file.",
  positional: ["files"],
  inputSchema: {
    file: z.string().optional().describe("Single file path."),
    files: z.array(z.string()).optional().describe("Batch: list of files. Runs in parallel."),
  },
  handler: async ({ file, files }, ctx) => {
    const list = files && files.length ? files : file ? [file] : [];
    if (!list.length) return fail("outline requires `file` or `files`");
    if (list.length === 1) return outlineOne(list[0]!, ctx);
    return fanout(
      list,
      (f) => f,
      (f) => outlineOne(f, ctx),
    );
  },
});

async function diagnosticsOne(file: string, minSev: number, ctx: ToolContext): Promise<ToolResult> {
  try {
    const filePath = abs(file, ctx.cwd);
    const { client, root } = await ctx.pool.forFile(filePath);
    const uri = await client.syncOpen(filePath);
    await waitForDiagnostics(() => client.diagnosticsFor(uri), 2000);
    const diags = (client.diagnosticsFor(uri) ?? []).filter(
      (d: Diagnostic) => (d.severity ?? 1) <= minSev,
    );
    if (!diags.length) return ok("no diagnostics");
    return ok(diags.map((d) => formatDiagnostic(d, uriToRel(uri, root))).join("\n"));
  } catch (e) {
    return fail(String((e as Error).message ?? e));
  }
}

const diagnostics = defineTool({
  name: "diagnostics",
  description:
    "Type errors + warnings. Pass `file`, an array of `files`, or neither (aggregates across all open files).",
  inputSchema: {
    file: z.string().optional().describe("Single file path."),
    files: z.array(z.string()).optional().describe("Batch: list of files. Runs in parallel."),
    severity: z
      .enum(["error", "warning", "info", "all"])
      .optional()
      .describe("Default warning+error."),
  },
  handler: async ({ file, files, severity }, ctx) => {
    const minSev = severityFilter(severity ?? "warning");
    const list = files && files.length ? files : file ? [file] : [];
    if (list.length === 1) return diagnosticsOne(list[0]!, minSev, ctx);
    if (list.length > 1)
      return fanout(
        list,
        (f) => f,
        (f) => diagnosticsOne(f, minSev, ctx),
      );
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
    direction: z.enum(["incoming", "outgoing", "both"]).optional().describe("Default both."),
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
    file: z.string().describe("File path."),
    line: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Zero-based line. Omit for whole-file actions."),
    character: z.number().int().nonnegative().optional().describe("Zero-based column."),
    end_line: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Zero-based end line. Defaults to line."),
    end_character: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Zero-based end column. Defaults to character."),
    kind: z
      .string()
      .optional()
      .describe("Filter by action kind, e.g. source.organizeImports, quickfix."),
    only_preferred: z.boolean().optional().describe("Only return preferred actions."),
    apply: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Index of an action to apply (writes to disk)."),
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
// input shape, so a `ToolDef<{query: ZodString}>` is not assignable to
// `ToolDef<ZodRawShape>`. The `defineTool` helper still gives each individual
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
