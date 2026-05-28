// Minimal LSP client to probe tsgo for rename + references support.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sampleDir = resolve(__dirname, "sample");
const mathPath = resolve(sampleDir, "src/math.ts");
const indexPath = resolve(sampleDir, "src/index.ts");
const mathUri = pathToFileURL(mathPath).toString();
const indexUri = pathToFileURL(indexPath).toString();

const tsgo = spawn(resolve(__dirname, "node_modules/.bin/tsgo"), ["--lsp", "--stdio"], {
  stdio: ["pipe", "pipe", "pipe"],
});

tsgo.stderr.on("data", (d) => process.stderr.write(`[tsgo stderr] ${d}`));

let buf = Buffer.alloc(0);
const pending = new Map();
let nextId = 1;

function send(msg) {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
  tsgo.stdin.write(Buffer.concat([header, body]));
}

function request(method, params, timeoutMs = 5000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout after ${timeoutMs}ms waiting for ${method}`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(t);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(t);
        reject(e);
      },
    });
    process.stderr.write(`[probe] -> ${method} (id=${id})\n`);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

tsgo.stdout.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (true) {
    const sep = buf.indexOf("\r\n\r\n");
    if (sep === -1) return;
    const header = buf.slice(0, sep).toString("utf8");
    const m = /Content-Length: (\d+)/i.exec(header);
    if (!m) return;
    const len = parseInt(m[1], 10);
    const total = sep + 4 + len;
    if (buf.length < total) return;
    const body = buf.slice(sep + 4, total).toString("utf8");
    buf = buf.slice(total);
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(msg.error);
      else resolve(msg.result);
    } else if (msg.method) {
      process.stderr.write(`[probe] <- notif ${msg.method}\n`);
      // Server-initiated requests need a response or the server may stall.
      if (msg.id !== undefined) {
        send({ jsonrpc: "2.0", id: msg.id, result: null });
      }
    } else if (msg.id !== undefined) {
      process.stderr.write(`[probe] <- response id=${msg.id} (no pending)\n`);
    }
  }
});

(async () => {
  const init = await request("initialize", {
    processId: process.pid,
    rootUri: pathToFileURL(sampleDir).toString(),
    capabilities: {
      textDocument: {
        rename: { prepareSupport: true },
        references: {},
        definition: {},
      },
    },
    workspaceFolders: [{ uri: pathToFileURL(sampleDir).toString(), name: "sample" }],
  });

  const caps = init.capabilities ?? {};
  console.log("=== ServerCapabilities (selected) ===");
  console.log(
    JSON.stringify(
      {
        renameProvider: caps.renameProvider,
        referencesProvider: caps.referencesProvider,
        definitionProvider: caps.definitionProvider,
        documentSymbolProvider: caps.documentSymbolProvider,
        workspaceSymbolProvider: caps.workspaceSymbolProvider,
        codeActionProvider: caps.codeActionProvider,
        hoverProvider: caps.hoverProvider,
        completionProvider: caps.completionProvider ? "yes" : undefined,
        signatureHelpProvider: caps.signatureHelpProvider ? "yes" : undefined,
        implementationProvider: caps.implementationProvider,
        typeDefinitionProvider: caps.typeDefinitionProvider,
      },
      null,
      2,
    ),
  );

  notify("initialized", {});

  for (const [uri, path] of [
    [mathUri, mathPath],
    [indexUri, indexPath],
  ]) {
    notify("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: "typescript",
        version: 1,
        text: readFileSync(path, "utf8"),
      },
    });
  }

  // Give the server a moment to project-load.
  await new Promise((r) => setTimeout(r, 1500));

  // `add` symbol is at line 0, char 16 in math.ts ("export function add")
  const addPos = { line: 0, character: 17 };

  console.log("\n=== textDocument/references on `add` ===");
  try {
    const refs = await request("textDocument/references", {
      textDocument: { uri: mathUri },
      position: addPos,
      context: { includeDeclaration: true },
    });
    console.log(JSON.stringify(refs, null, 2));
  } catch (e) {
    console.log("ERROR:", JSON.stringify(e));
  }

  console.log("\n=== textDocument/prepareRename on `add` ===");
  try {
    const prep = await request("textDocument/prepareRename", {
      textDocument: { uri: mathUri },
      position: addPos,
    });
    console.log(JSON.stringify(prep, null, 2));
  } catch (e) {
    console.log("ERROR:", JSON.stringify(e));
  }

  console.log("\n=== textDocument/rename `add` -> `sum` ===");
  try {
    const edit = await request("textDocument/rename", {
      textDocument: { uri: mathUri },
      position: addPos,
      newName: "sum",
    });
    console.log(JSON.stringify(edit, null, 2));
  } catch (e) {
    console.log("ERROR:", JSON.stringify(e));
  }

  await request("shutdown", null).catch(() => {});
  notify("exit", null);
  setTimeout(() => process.exit(0), 200);
})().catch((e) => {
  console.error("probe failed:", e);
  process.exit(1);
});
