import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LspClient, Position, SymbolInformation } from "./lsp-client.js";
import { findProjectRoot, LspPool } from "./workspace.js";

export interface SymbolLocator {
  /** Absolute or workspace-relative path. Required when only `line`/`character` is given. */
  file?: string;
  /** Zero-based. */
  line?: number;
  /** Zero-based. Use with `line`. */
  character?: number;
  /** Identifier text. With `file`+`line`: scan that line. With just `file`: workspace/symbol within file. With just this: workspace search. */
  symbol?: string;
}

export interface ResolvedPosition {
  client: LspClient;
  root: string;
  filePath: string;
  uri: string;
  position: Position;
}

export class LocatorError extends Error {
  constructor(
    message: string,
    public readonly candidates?: SymbolInformation[],
  ) {
    super(message);
  }
}

function relPath(absolute: string, root: string): string {
  if (absolute.startsWith(root + "/")) return absolute.slice(root.length + 1);
  return absolute;
}

function abs(p: string, cwd = process.cwd()): string {
  return isAbsolute(p) ? p : resolve(cwd, p);
}

/**
 * Resolve a symbol locator into a concrete position the LSP can act on.
 * Throws LocatorError with a clear message (and candidates when ambiguous).
 */
export async function resolveLocator(
  pool: LspPool,
  loc: SymbolLocator,
  cwd = process.cwd(),
): Promise<ResolvedPosition> {
  // Mode A: explicit position.
  if (loc.file && loc.line !== undefined && loc.character !== undefined) {
    const filePath = abs(loc.file, cwd);
    const { client, root } = await pool.forFile(filePath);
    const uri = await client.syncOpen(filePath);
    return { client, root, filePath, uri, position: { line: loc.line, character: loc.character } };
  }

  // Mode B: file + line + symbol — scan that line.
  if (loc.file && loc.line !== undefined && loc.symbol) {
    const filePath = abs(loc.file, cwd);
    const { client, root } = await pool.forFile(filePath);
    const uri = await client.syncOpen(filePath);
    const text = await readFile(filePath, "utf8");
    const lines = text.split(/\r?\n/);
    if (loc.line >= lines.length) {
      throw new LocatorError(`line ${loc.line} out of range (file has ${lines.length} lines)`);
    }
    const lineText = lines[loc.line]!;
    const re = new RegExp(`\\b${escapeRegex(loc.symbol)}\\b`);
    const m = re.exec(lineText);
    if (!m) {
      throw new LocatorError(
        `symbol "${loc.symbol}" not found on line ${loc.line} of ${relPath(filePath, root)}`,
      );
    }
    return { client, root, filePath, uri, position: { line: loc.line, character: m.index } };
  }

  // Mode C: name-only (optionally scoped to a file).
  if (loc.symbol) {
    const cwdRoot = abs(loc.file ?? cwd, cwd);
    const { client, root } = loc.file
      ? await pool.forFile(cwdRoot)
      : { client: await pool.forRoot(findRootOrThrow(cwd)), root: findRootOrThrow(cwd) };
    if (loc.file) await client.syncOpen(cwdRoot);
    const matches = await querySymbol(
      client,
      loc.symbol,
      loc.file ? abs(loc.file, cwd) : undefined,
    );
    if (matches.length === 0) {
      const where = loc.file ? ` in ${loc.file}` : "";
      throw new LocatorError(`no workspace symbol matches "${loc.symbol}"${where}`);
    }
    if (matches.length > 1) {
      throw new LocatorError(
        `ambiguous symbol "${loc.symbol}" — ${matches.length} matches. Pass { file, line } to disambiguate.`,
        matches,
      );
    }
    const hit = matches[0]!;
    const filePath = fileURLToPath(hit.location.uri);
    await client.syncOpen(filePath);
    // workspace/symbol's `range` is the symbol's enclosing block per LSP
    // spec — start lands on `export` for `export function foo`. Scan within
    // that range for the actual identifier so hover/definition/references
    // land on the symbol.
    const position = await locateIdentifierInRange(filePath, hit.location.range, hit.name);
    return { client, root, filePath, uri: hit.location.uri, position };
  }

  throw new LocatorError(
    "locator must include at least one of: { file, line, character }, { file, line, symbol }, or { symbol }.",
  );
}

async function querySymbol(
  client: LspClient,
  query: string,
  fileFilter?: string,
): Promise<SymbolInformation[]> {
  const results =
    (await client.request<SymbolInformation[] | null>("workspace/symbol", { query })) ?? [];
  // workspace/symbol does substring/fuzzy. Tighten to exact-name matches first.
  const exact = results.filter((s) => s.name === query);
  const pool = exact.length ? exact : results;
  if (!fileFilter) return pool;
  const targetUri = pathToFileURL(fileFilter).toString();
  return pool.filter((s) => s.location.uri === targetUri);
}

function findRootOrThrow(p: string): string {
  const root = findProjectRoot(p);
  if (!root) throw new LocatorError(`no tsconfig.json found near ${p}`);
  return root;
}

export async function locateIdentifierInRange(
  filePath: string,
  range: { start: Position; end: Position },
  name: string,
): Promise<Position> {
  const text = await readFile(filePath, "utf8");
  const lines = text.split(/\r?\n/);
  const re = new RegExp(`\\b${escapeRegex(name)}\\b`);
  for (let line = range.start.line; line <= range.end.line; line++) {
    const lineText = lines[line] ?? "";
    const startCol = line === range.start.line ? range.start.character : 0;
    const endCol = line === range.end.line ? range.end.character : lineText.length;
    const slice = lineText.slice(startCol, endCol);
    const m = re.exec(slice);
    if (m) return { line, character: startCol + m.index };
  }
  // Fall back to range start — better than throwing.
  return range.start;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
