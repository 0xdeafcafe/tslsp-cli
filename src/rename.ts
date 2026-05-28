import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { LspClient, TextEdit, WorkspaceEdit } from "./lsp-client.js";
import { uriToRel } from "./format.js";

interface FileEdits {
  uri: string;
  filePath: string;
  edits: TextEdit[];
}

function collectEdits(edit: WorkspaceEdit): FileEdits[] {
  const out: FileEdits[] = [];
  if (edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) {
      out.push({ uri, filePath: fileURLToPath(uri), edits });
    }
  }
  if (edit.documentChanges) {
    for (const dc of edit.documentChanges) {
      out.push({
        uri: dc.textDocument.uri,
        filePath: fileURLToPath(dc.textDocument.uri),
        edits: dc.edits,
      });
    }
  }
  return out;
}

export interface RenameSummary {
  files_changed: number;
  total_edits: number;
  files: string[]; // relative paths
  preview?: string; // only for dry runs
}

export async function summarizeRename(
  edit: WorkspaceEdit,
  root: string,
  withPreview: boolean,
): Promise<RenameSummary> {
  const groups = collectEdits(edit);
  const total = groups.reduce((n, g) => n + g.edits.length, 0);
  const files = groups.map((g) => uriToRel(g.uri, root));
  if (!withPreview) {
    return { files_changed: groups.length, total_edits: total, files };
  }
  const preview = await buildPreview(groups, root);
  return { files_changed: groups.length, total_edits: total, files, preview };
}

async function buildPreview(groups: FileEdits[], root: string): Promise<string> {
  const out: string[] = [];
  for (const g of groups) {
    const rel = uriToRel(g.uri, root);
    let text: string;
    try {
      text = await readFile(g.filePath, "utf8");
    } catch {
      out.push(`# ${rel}\n  (file unreadable)`);
      continue;
    }
    const lines = text.split(/\r?\n/);
    const sorted = [...g.edits].sort((a, b) => a.range.start.line - b.range.start.line);
    const blocks: string[] = [`# ${rel}`];
    for (const e of sorted) {
      const ln = e.range.start.line;
      const before = lines[ln] ?? "";
      const after = applyEditOnLine(before, e);
      blocks.push(`  L${ln + 1}: ${before.trim()}`);
      blocks.push(`     ${after.trim()}`);
    }
    out.push(blocks.join("\n"));
  }
  return out.join("\n\n");
}

function applyEditOnLine(line: string, e: TextEdit): string {
  if (e.range.start.line !== e.range.end.line) return line; // multi-line edit; preview source only
  return line.slice(0, e.range.start.character) + e.newText + line.slice(e.range.end.character);
}

/** Apply a WorkspaceEdit to disk and notify the LSP so its index reprojects. */
export async function applyWorkspaceEdit(
  client: LspClient,
  edit: WorkspaceEdit,
  root: string,
): Promise<RenameSummary> {
  const groups = collectEdits(edit);
  let total = 0;
  for (const g of groups) {
    const text = await readFile(g.filePath, "utf8");
    const updated = applyEditsToText(text, g.edits);
    await writeFile(g.filePath, updated, "utf8");
    total += g.edits.length;
  }
  await client.filesChangedOnDisk(groups.map((g) => g.filePath));
  return {
    files_changed: groups.length,
    total_edits: total,
    files: groups.map((g) => uriToRel(g.uri, root)),
  };
}

/** Apply edits sorted descending by start position so earlier edits don't shift later ones. */
export function applyEditsToText(text: string, edits: TextEdit[]): string {
  const offsets = lineStartOffsets(text);
  const indexed = edits.map((e) => ({
    e,
    startOff: offsets[e.range.start.line]! + e.range.start.character,
    endOff: offsets[e.range.end.line]! + e.range.end.character,
  }));
  indexed.sort((a, b) => b.startOff - a.startOff);
  let out = text;
  for (const { e, startOff, endOff } of indexed) {
    out = out.slice(0, startOff) + e.newText + out.slice(endOff);
  }
  return out;
}

function lineStartOffsets(text: string): number[] {
  const offsets = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) offsets.push(i + 1);
  }
  return offsets;
}
