# tslsp-cli

[![npm](https://img.shields.io/npm/v/@0xdeafcafe/tslsp-cli.svg?logo=npm&label=npm)](https://www.npmjs.com/package/@0xdeafcafe/tslsp-cli)
[![CI](https://github.com/0xdeafcafe/tslsp-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/0xdeafcafe/tslsp-cli/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/@0xdeafcafe/tslsp-cli.svg?logo=node.js)](https://github.com/0xdeafcafe/tslsp-cli/blob/main/package.json)

Type-aware TypeScript/JavaScript code intelligence as a CLI. Wraps [tsgo](https://github.com/microsoft/typescript-go) (Microsoft's native Go port of tsserver) and exposes its LSP capabilities — `references`, `definition`, `rename`, `rename-file`, `hover`, `outline`, `diagnostics`, `call-hierarchy`, `code-action` — as a small set of agent-friendly commands.

The point is to give coding agents an alternative to grep/find-and-replace/`mv` on identifier-level work. `rename` updates every reference. `rename-file` rewrites every import. `outline` returns the LSP's structural view, not 200 lines of source.

One tsgo per `tsconfig.json`, lazy-spawned. Optional `--daemon` keeps tsgo warm across calls.

## install

Two clients are first-class: Claude Code (via the bundled plugin marketplace) and Codex (via the CLI + `AGENTS.md`).

### Claude Code

```
/plugin marketplace add 0xdeafcafe/tslsp-cli
/plugin install tslsp@0xdeafcafe-tslsp
```

The plugin bundles a routing skill that tells Claude to use `tslsp-cli` instead of grep / string-edit / `mv` for any TS/JS identifier work — no `CLAUDE.md` editing required. The skill drives the CLI, so install that too:

```bash
npm i -g @0xdeafcafe/tslsp-cli
```

The skill instructs Claude to verify the CLI is on `PATH` at the start of each session; a missing install surfaces immediately rather than mid-refactor. Update the skill with `/plugin marketplace update 0xdeafcafe-tslsp`.

### Codex

Codex reads `AGENTS.md` the same way Claude reads `CLAUDE.md`. Install the CLI and let it write the routing block:

```bash
npm i -g @0xdeafcafe/tslsp-cli

tslsp-cli install --skills --project --with-agents-md   # writes ./AGENTS.md
tslsp-cli install --skills --with-agents-md             # writes ~/.codex/AGENTS.md (user-wide)
```

Idempotent — guarded by a marker comment, so re-runs are no-ops. `--with-claude-md` is the equivalent flag for non-marketplace Claude Code installs; both flags can be passed together.

### Other agents

Cursor, Cline, Aider, anything else that runs a shell and reads an instructions file: install the CLI (`npm i -g @0xdeafcafe/tslsp-cli`), then paste the body of [`skills/tslsp/SKILL.md`](skills/tslsp/SKILL.md) into the host's equivalent file.

### From source

```bash
git clone https://github.com/0xdeafcafe/tslsp-cli.git
cd tslsp-cli && pnpm install && pnpm run build
./dist/cli.js --help
```

## commands

| command           | purpose                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| `find-symbol`     | Workspace symbol search. Multi-query positional or `--queries a,b,c`. `--kind`, `--container`.  |
| `references`      | Every reference. Locator or `--symbols` batch. `--summary` for `path (N): lines`.               |
| `definition`      | Jump to where a symbol is defined. `--symbols` batch.                                           |
| `type-definition` | Jump to a value's _type_ declaration (vs. value). `--symbols` batch.                            |
| `implementation`  | Concrete implementations of an interface/abstract member. `--symbols` batch.                    |
| `rename`          | Type-aware rename across every file. `--dry-run` previews.                                      |
| `rename-file`     | Move a file or folder; updates every import. Folders walked recursively.                        |
| `hover`           | Type signature + JSDoc. `--symbols` batch.                                                      |
| `outline`         | Indented declaration outline. Files, globs (`'src/**/*.ts'`), directories. `--depth`, `--kind`. |
| `diagnostics`     | Type errors. Files, globs, directories. No args → aggregate across every open file.             |
| `call-hierarchy`  | Callers and callees. `--direction incoming` / `outgoing` / `both`.                              |
| `code-action`     | List quick-fixes / refactors / organize-imports; `--apply N` applies one.                       |

`tslsp-cli --help` and `tslsp-cli <command> --help` are authoritative.

## locator

Commands that need a position accept three forms, in priority order:

```
--file F --line L --character C   explicit LSP position
--file F --line L --symbol NAME   scan line L of F for NAME
--symbol NAME                     workspace search; exit 2 with candidates if ambiguous
```

Agents typically know the symbol name and line, not the column. Modes 2 and 3 cover the gap.

## batch

Every read-only command accepts a list. One CLI call → N parallel LSP queries → one labelled return:

```bash
tslsp-cli find-symbol  add double sum                # multi-positional
tslsp-cli hover        --symbols User,Account,Session
tslsp-cli references   --symbols add,sum,double
tslsp-cli outline      'src/**/*.ts'                 # quote the glob
tslsp-cli diagnostics  src/api/                      # directory walk
```

Blocks are labelled `=== name ===`. `find-symbol` serializes internally (tsgo's `workspace/symbol` races at cold-start); everything else fans out.

Glob and directory inputs are filtered through a source-extension set (`.ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs`) and an ignore set (`node_modules`, `.git`, `dist`, `build`, `out`, `.next`, `coverage`). Mention an ignored segment in the pattern itself (e.g. `node_modules/**/*.ts`) to include those hits.

Batched output is squeezed: clean items drop their `=== file ===` headers, all-clean batches collapse to one line, and `references --summary` swaps snippets for `path (N): l1, l2, l3` — ~15KB → a few hundred bytes on heavily-referenced symbols.

## daemon

```
tslsp-cli <cmd>             fresh tsgo per invocation; disposed after the call
tslsp-cli --daemon <cmd>    RPC into a per-workspace daemon
```

Fresh-process mode is fine for one-off calls. For a refactor loop with many calls, `--daemon` autospawns a per-workspace daemon on first use and reuses it after. Socket path: `$CACHE/tslsp/daemon/<sha1(tsconfig-dir)>/<session>.sock` (macOS `~/Library/Caches`, Linux `$XDG_CACHE_HOME`, Windows `%LOCALAPPDATA%`; override with `TSLSP_DAEMON_DIR`).

```bash
tslsp-cli --daemon references --symbol User
tslsp-cli daemon list           # running daemons
tslsp-cli daemon restart        # after upgrading tslsp-cli
tslsp-cli daemon stop           # graceful stop for this workspace
tslsp-cli daemon kill-all       # SIGKILL every daemon
```

The daemon self-exits after 30 min idle (`TSLSP_DAEMON_IDLE_MS`); individual tsgos inside reap after 10 min (`TSLSP_TSGO_IDLE_MS`). Version-skewed daemons refuse new calls — run `daemon restart` after upgrading.

## gotchas

- `@typescript/native-preview` is pinned to a specific dev build. tsgo moves fast; bump it deliberately.
- `rename` and `rename-file` write to disk. `--dry-run` previews first.
- Always quote glob patterns. An unquoted `src/**/*.ts` that matches nothing in your shell becomes a literal argument and the LSP errors instead of the expander finding zero files.
- One tsgo per `tsconfig.json` root. Monorepos pay project-load cost the first time each project is hit (~50ms small, more on large).
- `--daemon` keeps files open across calls. External edits between two daemon-routed calls may briefly lag until the next file-open or `didChangeWatchedFiles` event.
- Daemon stderr lives at `$CACHE/tslsp/daemon/<hash>/<session>.err` — first place to look if a spawn fails.
- `TSLSP_VERBOSE=1` forwards tsgo's stderr to the foreground process.
- A homebrew-installed `tsgo` on `PATH` is ignored; `tslsp-cli` always uses the npm-pinned one.
