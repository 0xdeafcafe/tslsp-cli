import { ChildProcess, spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { memoryOf } from "./engine.js";

export interface Location {
  uri: string;
  range: Range;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Position {
  line: number;
  character: number;
}

export interface Diagnostic {
  range: Range;
  severity?: 1 | 2 | 3 | 4;
  code?: string | number;
  source?: string;
  message: string;
}

export interface WorkspaceEdit {
  changes?: Record<string, TextEdit[]>;
  documentChanges?: Array<{
    textDocument: { uri: string; version: number | null };
    edits: TextEdit[];
  }>;
}

export interface TextEdit {
  range: Range;
  newText: string;
}

export interface DocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}

export interface SymbolInformation {
  name: string;
  kind: number;
  location: Location;
  containerName?: string;
}

export interface Hover {
  contents: { kind: "markdown" | "plaintext"; value: string } | string | Array<unknown>;
  range?: Range;
}

export interface CallHierarchyItem {
  name: string;
  kind: number;
  detail?: string;
  uri: string;
  range: Range;
  selectionRange: Range;
  data?: unknown;
}

export interface CallHierarchyIncomingCall {
  from: CallHierarchyItem;
  fromRanges: Range[];
}

export interface CallHierarchyOutgoingCall {
  to: CallHierarchyItem;
  fromRanges: Range[];
}

export interface CodeAction {
  title: string;
  kind?: string;
  diagnostics?: Diagnostic[];
  isPreferred?: boolean;
  edit?: WorkspaceEdit;
  command?: { title: string; command: string; arguments?: unknown[] };
}

export interface FileRename {
  oldUri: string;
  newUri: string;
}

export type ServerCapabilities = Record<string, unknown>;

interface PendingRequest {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  method: string;
  timer: NodeJS.Timeout;
}

export interface LspClientOptions {
  binPath: string;
  rootPath: string;
  /** Which server binPath is, for messages: "tsrs" or "tsgo". */
  engine?: string;
  /** Bytes the server may hold before it's stopped; 0 or unset for no cap. */
  maxMemoryBytes?: number;
  /** Told once when the server process has gone, however it went. */
  onExit?: () => void;
  /** Optional logger for diagnostics; default silent. */
  log?: (line: string) => void;
}

export class LspClient {
  private proc: ChildProcess;
  private buf = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private opened = new Map<string, { mtimeMs: number; version: number }>();
  private diagnostics = new Map<string, Diagnostic[]>();
  private initialized: Promise<void>;
  private projectSeeded = false;
  private closed = false;
  private log: (line: string) => void;
  private serverCaps: ServerCapabilities = {};
  private memoryTimer?: NodeJS.Timeout;
  private stoppedFor?: Error;

  constructor(private opts: LspClientOptions) {
    this.log = opts.log ?? (() => {});
    this.proc = spawn(opts.binPath, ["--lsp", "--stdio"], {
      cwd: opts.rootPath,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const engine = opts.engine ?? "tsgo";
    this.proc.stderr?.on("data", (d: Buffer) =>
      this.log(`[${engine} stderr] ${d.toString().trimEnd()}`),
    );
    this.proc.stdout?.on("data", (chunk: Buffer) => this.onStdout(chunk));
    this.proc.on("exit", (code, signal) => {
      this.closed = true;
      if (this.memoryTimer) clearInterval(this.memoryTimer);
      const err =
        this.stoppedFor ??
        new Error(`${engine} exited (${signal ? `signal ${signal}` : `code=${code}`})`);
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
      opts.onExit?.();
    });
    if (opts.maxMemoryBytes && opts.maxMemoryBytes > 0)
      this.watchMemory(opts.maxMemoryBytes, engine);
    this.initialized = this.handshake();
  }

  private async handshake(): Promise<void> {
    const rootUri = pathToFileURL(this.opts.rootPath).toString();
    const init = await this.request<{ capabilities?: ServerCapabilities }>("initialize", {
      processId: process.pid,
      rootUri,
      capabilities: {
        textDocument: {
          rename: { prepareSupport: true },
          references: {},
          definition: { linkSupport: false },
          implementation: { linkSupport: false },
          typeDefinition: { linkSupport: false },
          hover: { contentFormat: ["markdown", "plaintext"] },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          callHierarchy: { dynamicRegistration: false },
          codeAction: {
            codeActionLiteralSupport: {
              codeActionKind: {
                valueSet: [
                  "",
                  "quickfix",
                  "refactor",
                  "refactor.extract",
                  "refactor.inline",
                  "refactor.rewrite",
                  "source",
                  "source.organizeImports",
                  "source.fixAll",
                ],
              },
            },
            resolveSupport: { properties: ["edit"] },
          },
          publishDiagnostics: { relatedInformation: false },
        },
        workspace: {
          symbol: {},
          workspaceFolders: true,
          didChangeWatchedFiles: { dynamicRegistration: true },
          fileOperations: {
            willRename: true,
            didRename: true,
          },
          applyEdit: true,
        },
      },
      workspaceFolders: [{ uri: rootUri, name: "root" }],
    });
    this.serverCaps = init?.capabilities ?? {};
    this.notify("initialized", {});
  }

  capabilities(): ServerCapabilities {
    return this.serverCaps;
  }

  private send(msg: unknown): void {
    if (this.closed || !this.proc.stdin) return;
    const body = Buffer.from(JSON.stringify(msg), "utf8");
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
    this.proc.stdin.write(Buffer.concat([header, body]));
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs = 15_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error("LSP closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout after ${timeoutMs}ms waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, method, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private onStdout(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (true) {
      const sep = this.buf.indexOf("\r\n\r\n");
      if (sep === -1) return;
      const header = this.buf.slice(0, sep).toString("utf8");
      const m = /Content-Length: (\d+)/i.exec(header);
      if (!m) {
        // Drop garbage header; resync.
        this.buf = this.buf.slice(sep + 4);
        continue;
      }
      const len = parseInt(m[1]!, 10);
      const total = sep + 4 + len;
      if (this.buf.length < total) return;
      const body = this.buf.slice(sep + 4, total).toString("utf8");
      this.buf = this.buf.slice(total);
      let msg: any;
      try {
        msg = JSON.parse(body);
      } catch {
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: any): void {
    if (typeof msg.id !== "undefined" && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message ?? "lsp error"}`));
      else p.resolve(msg.result);
      return;
    }
    if (typeof msg.method === "string") {
      // Server-initiated request: must respond or some servers stall.
      if (typeof msg.id !== "undefined") {
        this.send({ jsonrpc: "2.0", id: msg.id, result: null });
        return;
      }
      // Notification.
      this.onNotification(msg.method, msg.params);
    }
  }

  private onNotification(method: string, params: any): void {
    if (method === "textDocument/publishDiagnostics" && params?.uri) {
      this.diagnostics.set(params.uri, params.diagnostics ?? []);
    } else if (method === "window/logMessage" || method === "window/showMessage") {
      this.log(`[tsgo ${method}] ${params?.message ?? ""}`);
    }
  }

  /** Open the file (or reopen if mtime changed). Idempotent. */
  async syncOpen(filePath: string): Promise<string> {
    const uri = pathToFileURL(filePath).toString();
    const st = await stat(filePath);
    const cur = this.opened.get(uri);
    if (cur && cur.mtimeMs === st.mtimeMs) return uri;
    const text = await readFile(filePath, "utf8");
    if (cur) {
      this.notify("textDocument/didClose", { textDocument: { uri } });
    }
    const version = (cur?.version ?? 0) + 1;
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: "typescript", version, text },
    });
    this.opened.set(uri, { mtimeMs: st.mtimeMs, version });
    return uri;
  }

  /**
   * Notify the server that files moved on disk and that any open documents at
   * the old URIs are closed. Used by file/folder rename.
   */
  async filesRenamedOnDisk(renames: FileRename[]): Promise<void> {
    for (const { oldUri } of renames) {
      if (this.opened.has(oldUri)) {
        this.notify("textDocument/didClose", { textDocument: { uri: oldUri } });
        this.opened.delete(oldUri);
      }
    }
    this.notify("workspace/didRenameFiles", { files: renames });
    this.notify("workspace/didChangeWatchedFiles", {
      changes: [
        ...renames.map((r) => ({ uri: r.oldUri, type: 3 /* Deleted */ })),
        ...renames.map((r) => ({ uri: r.newUri, type: 1 /* Created */ })),
      ],
    });
    await new Promise((r) => setTimeout(r, 300));
  }

  /**
   * Force-refresh files we just wrote on disk. Send didClose+didOpen with new
   * content for each file, then workspace/didChangeWatchedFiles. All sends
   * happen back-to-back without yielding (read every file's content first),
   * because yielding between close/open pairs lets server-initiated requests
   * interleave and seems to confuse tsgo's index refresh.
   */
  async filesChangedOnDisk(filePaths: string[]): Promise<void> {
    // Read all file content + stats up-front so the send loop doesn't yield.
    const items = await Promise.all(
      filePaths.map(async (filePath) => {
        const uri = pathToFileURL(filePath).toString();
        const cur = this.opened.get(uri);
        const [text, st] = await Promise.all([readFile(filePath, "utf8"), stat(filePath)]);
        return { filePath, uri, cur, text, mtimeMs: st.mtimeMs };
      }),
    );

    for (const it of items) {
      const version = (it.cur?.version ?? 0) + 1;
      if (it.cur) this.notify("textDocument/didClose", { textDocument: { uri: it.uri } });
      this.notify("textDocument/didOpen", {
        textDocument: { uri: it.uri, languageId: "typescript", version, text: it.text },
      });
      this.opened.set(it.uri, { mtimeMs: it.mtimeMs, version });
    }
    this.notify("workspace/didChangeWatchedFiles", {
      changes: items.map((it) => ({ uri: it.uri, type: 2 /* Changed */ })),
    });
    // Brief settle for tsgo to reproject its workspace symbol index.
    await new Promise((r) => setTimeout(r, 300));
  }

  diagnosticsFor(uri: string): Diagnostic[] | undefined {
    return this.diagnostics.get(uri);
  }

  diagnosticsAll(): IterableIterator<[string, Diagnostic[]]> {
    return this.diagnostics.entries();
  }

  async ready(): Promise<void> {
    await this.initialized;
  }

  /**
   * tsgo's workspace/symbol only sees files that have been didOpen'd. Open one
   * .ts file in the project so tsgo loads the program and indexes everything
   * reachable from it. Idempotent.
   */
  async ensureProjectSeeded(): Promise<void> {
    if (this.projectSeeded) return;
    this.projectSeeded = true;
    const seed = await findFirstTsFile(this.opts.rootPath);
    if (seed) await this.syncOpen(seed);
  }

  /**
   * Stop the server once it holds more than max: a query over a whole
   * monorepo (a workspace symbol search loads every project) grows it past
   * what the machine has. The call in flight fails with what to do instead.
   */
  private watchMemory(max: number, engine: string): void {
    let looking = false;
    this.memoryTimer = setInterval(() => {
      const pid = this.proc.pid;
      if (looking || this.closed || pid === undefined) return;
      looking = true;
      void memoryOf(pid)
        .then((held) => {
          if (held <= max || this.closed) return;
          const gib = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GiB`;
          this.stoppedFor = new Error(
            `the ${engine} language server for ${this.opts.rootPath} held ${gib(held)}, past its ${gib(max)} cap, ` +
              `so tslsp-cli stopped it. Narrow the query: give --file and --line rather than --symbol alone ` +
              `(that searches every project), and work one package at a time. TSLSP_MAX_MEMORY_MB raises the cap.`,
          );
          this.log(`[lsp-client] ${this.stoppedFor.message}`);
          this.proc.kill("SIGKILL");
        })
        .finally(() => {
          looking = false;
        });
    }, 2000);
    this.memoryTimer.unref?.();
  }

  async dispose(): Promise<void> {
    if (this.memoryTimer) clearInterval(this.memoryTimer);
    if (this.closed) return;
    try {
      await this.request("shutdown", null, 2000);
    } catch {
      /* ignore */
    }
    this.notify("exit", null);
    this.proc.kill();
    this.closed = true;
  }
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

async function findFirstTsFile(root: string): Promise<string | undefined> {
  const queue: string[] = [root];
  while (queue.length) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".") continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) queue.push(full);
      } else if (e.isFile() && /\.(ts|tsx|mts|cts)$/.test(e.name) && !e.name.endsWith(".d.ts")) {
        return full;
      }
    }
  }
  return undefined;
}
