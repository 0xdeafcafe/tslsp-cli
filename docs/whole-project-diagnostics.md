# can the resident LSP type-check a whole project?

**No.** Neither tsgo build implements the LSP 3.17 workspace pull-diagnostics
request, and both say so in their own capabilities. A "type-check this project"
command has to either open every file over the LSP or shell out to the compiler.

Probed 2026-09-07 with `probe/workspace-diagnostics-probe.mjs` against a
two-file fixture (`src/good.ts` exports `add(a, b)`, `src/bad.ts` misuses it):

| server                                                        | binary                                        |
| ------------------------------------------------------------- | --------------------------------------------- |
| `@typescript/native-preview` `7.0.0-dev.20260506.1` (bundled) | `native-preview-darwin-arm64/lib/tsgo`        |
| `typescript` `7.0.2` (released, langwatch's node_modules)     | `@typescript/typescript-darwin-arm64/lib/tsc` |

Run it yourself:

```bash
node probe/workspace-diagnostics-probe.mjs <binary> <project-dir> [file-to-open]
```

## what the server advertises

Both builds return the same shape from `initialize` — pull diagnostics per
document, **not** per workspace:

```jsonc
// 7.0.0-dev.20260506.1
"diagnosticProvider": { "interFileDependencies": true, "workspaceDiagnostics": false }

// 7.0.2
"diagnosticProvider": { "identifier": "typescript", "interFileDependencies": true,
                        "workspaceDiagnostics": false }
```

`workspaceDiagnostics: false` is the whole answer. `interFileDependencies: true`
means a single document's report may depend on other files — the server loads the
program — but it will only ever report on the document you asked about.

## what the server does when you ask anyway

`workspace/diagnostic` →

```jsonc
// request
{"jsonrpc":"2.0","id":2,"method":"workspace/diagnostic",
 "params":{"previousResultIds":[],"identifier":"tslsp"}}

// response, both builds, before and after opening a file
{"code":-32600,"message":"InvalidRequest"}
```

`-32600` is "no handler for this method", not "bad arguments" — an earlier probe
that sent `"identifier": null` got `-32602 InvalidParams: … null value is not
allowed for field "identifier"` from the dev build, i.e. the params type is
generated but nothing dispatches the method.

The strings in the binaries agree. `workspace/diagnostic` appears only inside
the generated lsproto method table:

```
$ strings -a …/native-preview-darwin-arm64/lib/tsgo | grep -oE 'WorkspaceDiagnostic[A-Za-z]*' | sort -u
WorkspaceDiagnosticParams
WorkspaceDiagnosticReport
WorkspaceDiagnostics

$ strings -a …/typescript-darwin-arm64/lib/tsc | grep -oE 'WorkspaceDiagnostic[A-Za-z]*' | sort -u
WorkspaceDiagnostics
```

The released 7.0.2 build has dropped even the params/report types — only the
capability field survives. Also tried and rejected with `-32600`:
`workspace/executeCommand` (`typescript.projectDiagnostics`) and
`tsserver/geterrForProject`.

Curiously, 7.0.2 _sends_ `workspace/diagnostic/refresh` at us (it asks the client
to re-pull), and still won't answer the pull it is asking for.

## what does work

`textDocument/diagnostic` — one document, full report, program-wide analysis:

```jsonc
// request
{"jsonrpc":"2.0","id":4,"method":"textDocument/diagnostic",
 "params":{"textDocument":{"uri":"file:///tmp/tslsp-diag-fixture/src/bad.ts"}}}

// response (identical on both builds)
{"kind":"full","items":[
  {"range":{"start":{"line":2,"character":13},"end":{"line":2,"character":18}},
   "severity":1,"code":2322,"source":"ts",
   "message":"Type 'number' is not assignable to type 'string'."},
  {"range":{"start":{"line":3,"character":23},"end":{"line":3,"character":26}},
   "severity":1,"code":2554,"source":"ts",
   "message":"Expected 2 arguments, but got 1."}]}
```

This is what `tslsp-cli diagnostics` already drives, via `didOpen` +
`publishDiagnostics`. Nothing about it scales to a project: N files is N opens,
and the server holds every one of them in memory afterwards.

## `tsgo --watch --noEmit -p <tsconfig>`

Exists on both builds and behaves like `tsc --watch`. One-shot form first:

```
$ tsc --noEmit --pretty false -p tsconfig.json
src/bad.ts(3,14): error TS2322: Type 'number' is not assignable to type 'string'.
$ echo $?
1
```

Watch form, human-formatted, incremental on change:

```
[03:25:00 AM] Starting compilation in watch mode...
src/bad.ts:3:14 - error TS2322: Type 'number' is not assignable to type 'string'.
Found 1 error in src/bad.ts:3
[03:25:00 AM] Found 1 error. Watching for file changes.
   ← edit src/bad.ts
[03:25:06 AM] File change detected. Starting incremental compilation...
[03:25:06 AM] Found 0 errors. Watching for file changes.
```

There is no JSON output mode and no exit code while it runs; the parseable
surface is `--pretty false` line format plus the `File change detected` /
`Found N errors` markers. Two gotchas found while probing:

- the watcher missed edits entirely when the project lived under `/tmp` on macOS
  (a symlink to `/private/tmp`); the same test in a home directory picked up
  changes in ~6s. Resolve the project path before watching.
- clearing the screen is on by default (`\x1b[2J\x1b[3J\x1b[H` at each rebuild),
  so a log-scraping consumer must strip ANSI.

## recommendation

**Don't build "typecheck this project through the resident server."** The
resident server cannot answer it; the only implementation is a fan-out of
`didOpen` + `textDocument/diagnostic` over every file in the program, which
duplicates the compiler's own work, holds every file open in the LSP afterwards,
and gets slower than `tsc` on any project big enough to want the feature. It also
degrades the thing the daemon is good at — warm, low-latency answers about one
symbol — by ballooning its resident set.

If a project-wide typecheck is wanted, shell out to the same binary
`src/ts-binary.ts` already resolves:

```
<resolved binary> --noEmit --pretty false -p <tsconfig>
```

That is exactly the compiler the project uses, it is one process that exits, and
the output is one error per line. Parse it into the existing `format.ts` shape and
the command looks native. A `--watch` daemon is the wrong trade for a CLI:
it needs its own supervision, its own idle policy, its own log scraping and its
own answer to the `/tmp` watcher problem, in exchange for saving a cold program
load that `--incremental`/`tsBuildInfo` already mostly saves.

Revisit if `diagnosticProvider.workspaceDiagnostics` ever comes back `true` — the
probe script prints it first, so re-running it after a compiler bump is the whole
check.
