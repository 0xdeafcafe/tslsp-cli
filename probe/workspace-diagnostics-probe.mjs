// Probe: does the tsgo LSP answer whole-project diagnostics without opening
// every file? Sends initialize with LSP 3.17 pull-diagnostics capabilities,
// prints the server's diagnosticProvider capability, then tries
// `workspace/diagnostic`, `textDocument/diagnostic` and a couple of
// tsserver-flavoured aliases.
//
//   node probe/workspace-diagnostics-probe.mjs <tsgo-or-tsc-binary> [project-dir]
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bin = resolve(
  process.argv[2] ?? resolve(here, "node_modules/@typescript/native-preview/bin/tsgo.js"),
);
const projectDir = resolve(process.argv[3] ?? resolve(here, "sample"));
const rootUri = pathToFileURL(projectDir).toString();

const proc = spawn(bin, ["--lsp", "--stdio"], { cwd: projectDir, stdio: ["pipe", "pipe", "pipe"] });
proc.stderr.on("data", (d) => process.stderr.write(`[server stderr] ${d}`));

let buf = Buffer.alloc(0);
let nextId = 1;
const pending = new Map();
const notifications = [];

const send = (msg) => {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
  proc.stdin.write(body);
};
const request = (method, params, timeoutMs = 60_000) => {
  const id = nextId++;
  return new Promise((res, rej) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      rej(new Error(`timeout after ${timeoutMs}ms waiting for ${method}`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => (clearTimeout(timer), res(v)),
      reject: (e) => (clearTimeout(timer), rej(e)),
    });
    send({ jsonrpc: "2.0", id, method, params });
  });
};
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

proc.stdout.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const sep = buf.indexOf("\r\n\r\n");
    if (sep === -1) return;
    const m = /Content-Length: (\d+)/i.exec(buf.slice(0, sep).toString("utf8"));
    if (!m) {
      buf = buf.slice(sep + 4);
      continue;
    }
    const total = sep + 4 + parseInt(m[1], 10);
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
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(msg.error);
      else p.resolve(msg.result);
    } else if (msg.method) {
      notifications.push(msg.method);
      if (msg.method === "textDocument/publishDiagnostics")
        console.log(
          `  <- publishDiagnostics ${msg.params.uri.split("/").pop()} (${msg.params.diagnostics.length})`,
        );
      if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, result: null });
    }
  }
});

const attempt = async (label, method, params) => {
  console.log(`\n=== ${method} (${label}) ===`);
  try {
    const r = await request(method, params, 60_000);
    console.log(JSON.stringify(r, null, 2).slice(0, 4000));
  } catch (e) {
    console.log("ERROR:", JSON.stringify(e));
  }
};

const init = await request("initialize", {
  processId: process.pid,
  rootUri,
  capabilities: {
    textDocument: {
      diagnostic: { dynamicRegistration: true, relatedDocumentSupport: true },
      publishDiagnostics: { relatedInformation: false },
    },
    workspace: {
      diagnostics: { refreshSupport: true },
      workspaceFolders: true,
    },
  },
  workspaceFolders: [{ uri: rootUri, name: "root" }],
});
notify("initialized", {});

console.log(`binary: ${bin}`);
console.log(`project: ${projectDir}`);
console.log("\n=== server capabilities (diagnostic-related) ===");
const caps = init.capabilities ?? {};
console.log(
  JSON.stringify(
    {
      diagnosticProvider: caps.diagnosticProvider ?? null,
      workspaceDiagnostics: caps.diagnosticProvider?.workspaceDiagnostics ?? null,
      workspace: caps.workspace ?? null,
    },
    null,
    2,
  ),
);
console.log("\n=== all capability keys ===");
console.log(Object.keys(caps).sort().join(", "));

await attempt("workspace pull, identifier omitted", "workspace/diagnostic", {
  previousResultIds: [],
});
await attempt("workspace pull, identifier set", "workspace/diagnostic", {
  previousResultIds: [],
  identifier: "tslsp",
});

const firstFile = process.argv[4];
if (firstFile) {
  const uri = pathToFileURL(resolve(firstFile)).toString();
  notify("textDocument/didOpen", {
    textDocument: {
      uri,
      languageId: "typescript",
      version: 1,
      text: readFileSync(firstFile, "utf8"),
    },
  });
  await new Promise((r) => setTimeout(r, 1500));
  await attempt("document pull", "textDocument/diagnostic", { textDocument: { uri } });
  await attempt("after one open", "workspace/diagnostic", {
    previousResultIds: [],
    identifier: "tslsp",
  });
}

for (const method of ["workspace/executeCommand", "tsserver/geterrForProject"]) {
  await attempt(
    "long shot",
    method,
    method === "workspace/executeCommand"
      ? { command: "typescript.projectDiagnostics", arguments: [] }
      : {},
  );
}

console.log(`\nnotifications seen: ${[...new Set(notifications)].join(", ")}`);
await request("shutdown", null, 5000).catch(() => {});
notify("exit", null);
setTimeout(() => process.exit(0), 200);
