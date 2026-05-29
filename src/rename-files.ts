import { mkdir, readdir, rename as fsRename, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { uriToRel } from "./format.js";
import { FileRename, LspClient, WorkspaceEdit } from "./lsp-client.js";
import { applyWorkspaceEdit } from "./rename.js";

export interface FileRenameSummary {
  moves: { from: string; to: string }[];
  edits_applied: number;
  files_with_import_changes: number;
  /** Relative paths of files whose imports were (or would be) rewritten. */
  import_files: string[];
}

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  ".git",
  ".next",
  ".turbo",
  "coverage",
]);
const TS_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/** Walk a directory and return every TS/JS file path. Used to expand a folder
 * rename into per-file pairs, since LSP willRenameFiles operates per file. */
async function listSourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const queue: string[] = [dir];
  while (queue.length) {
    const cur = queue.shift()!;
    let entries;
    try {
      entries = await readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(cur, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) queue.push(full);
      } else if (e.isFile() && TS_FILE.test(e.name)) {
        out.push(full);
      }
    }
  }
  return out;
}

/** Expand an old→new path pair into per-file FileRename entries. Handles both
 * single-file renames and directory renames. */
export async function expandRenames(oldPath: string, newPath: string): Promise<FileRename[]> {
  const st = await stat(oldPath);
  if (st.isFile()) {
    return [
      { oldUri: pathToFileURL(oldPath).toString(), newUri: pathToFileURL(newPath).toString() },
    ];
  }
  if (!st.isDirectory()) throw new Error(`${oldPath} is neither a file nor a directory`);
  const files = await listSourceFiles(oldPath);
  return files.map((f) => {
    const rel = relative(oldPath, f);
    const dst = join(newPath, rel);
    return { oldUri: pathToFileURL(f).toString(), newUri: pathToFileURL(dst).toString() };
  });
}

/** Ask the server what import edits are needed for these renames. Server
 * returns a WorkspaceEdit; some servers (older tsgo builds) return null when
 * the capability isn't enabled — caller decides what to do. */
export async function getWillRenameEdit(
  client: LspClient,
  renames: FileRename[],
): Promise<WorkspaceEdit | null> {
  const caps = client.capabilities() as {
    workspace?: { fileOperations?: { willRename?: unknown } };
  };
  if (!caps.workspace?.fileOperations?.willRename) return null;
  return await client.request<WorkspaceEdit | null>("workspace/willRenameFiles", {
    files: renames,
  });
}

/** Move file/folder on disk. Creates the parent directory of the destination
 * if needed. Throws on collision (destination already exists) except when the
 * "collision" is the same inode as the source on a case-insensitive
 * filesystem — that's a case-only rename, which we route via a tmp name so
 * APFS/NTFS don't refuse it. */
export async function moveOnDisk(oldPath: string, newPath: string): Promise<void> {
  const oldAbs = resolve(oldPath);
  const newAbs = resolve(newPath);
  if (oldAbs === newAbs) return; // no-op
  await mkdir(dirname(newAbs), { recursive: true });

  const caseOnly = oldAbs.toLowerCase() === newAbs.toLowerCase() && oldAbs !== newAbs;
  if (caseOnly) {
    // On case-insensitive FS the destination "exists" because it IS the source.
    // Do a two-step rename via a sibling tmp name.
    const tmp = `${oldAbs}.tslsp-rename-${process.pid}-${Date.now()}`;
    await fsRename(oldAbs, tmp);
    await fsRename(tmp, newAbs);
    return;
  }

  try {
    await stat(newAbs);
    throw new Error(`destination already exists: ${newAbs}`);
  } catch (e: any) {
    if (e?.code !== "ENOENT") throw e;
  }
  await fsRename(oldAbs, newAbs);
}

export async function performFileRename(
  client: LspClient,
  root: string,
  oldPath: string,
  newPath: string,
  dryRun: boolean,
): Promise<FileRenameSummary> {
  const renames = await expandRenames(oldPath, newPath);
  const moves = renames.map((r) => ({
    from: uriToRel(r.oldUri, root),
    to: uriToRel(r.newUri, root),
  }));

  const edit = await getWillRenameEdit(client, renames);
  const editsApplied = edit ? countEdits(edit) : 0;
  const importFiles = edit ? listEditFiles(edit, root) : [];

  if (dryRun) {
    return {
      moves,
      edits_applied: editsApplied,
      files_with_import_changes: importFiles.length,
      import_files: importFiles,
    };
  }

  // CRITICAL: apply the WorkspaceEdit BEFORE moving files. The edit's URIs
  // refer to the pre-rename state; for a moved file with internal relative
  // imports tsgo emits edits keyed by the OLD URI. Reading that URI after a
  // move would ENOENT, leaving the rename half-done. Applying first writes
  // the post-move content into the file at its current (old) path; the move
  // then carries the already-updated content to its destination.
  if (edit) await applyWorkspaceEdit(client, edit, root);
  await moveOnDisk(oldPath, newPath);
  await client.filesRenamedOnDisk(renames);

  return {
    moves,
    edits_applied: editsApplied,
    files_with_import_changes: importFiles.length,
    import_files: importFiles,
  };
}

function countEdits(edit: WorkspaceEdit): number {
  let n = 0;
  if (edit.changes) for (const e of Object.values(edit.changes)) n += e.length;
  if (edit.documentChanges) for (const dc of edit.documentChanges) n += dc.edits.length;
  return n;
}

function listEditFiles(edit: WorkspaceEdit, root: string): string[] {
  const uris = new Set<string>();
  if (edit.changes) for (const u of Object.keys(edit.changes)) uris.add(u);
  if (edit.documentChanges) for (const dc of edit.documentChanges) uris.add(dc.textDocument.uri);
  return [...uris].map((u) => uriToRel(u, root)).sort();
}
