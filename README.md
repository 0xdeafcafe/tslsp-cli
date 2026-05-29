# tslsp-cli

[![npm](https://img.shields.io/npm/v/@0xdeafcafe/tslsp-cli.svg?logo=npm&label=npm)](https://www.npmjs.com/package/@0xdeafcafe/tslsp-cli)
[![CI](https://github.com/0xdeafcafe/tslsp-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/0xdeafcafe/tslsp-cli/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/@0xdeafcafe/tslsp-cli.svg?logo=node.js)](https://github.com/0xdeafcafe/tslsp-cli/blob/main/package.json)

claude finds references by grepping. claude renames things by find-and-replacing. this is fine until your symbol is called `User` or `get` or `value`, at which point it confidently rewrites half your codebase and tells you it's done. thanks, gas-lightyear.

how do real editors function? they ask the typescript language server, which actually understands what's a reference vs what's just a string. `tslsp-cli` gives claude that same superpower from a regular CLI. rename is type-aware. references are real references. moving a file rewrites every import that pointed at it. `outline` is the LSP's structural view, not "read 200 lines and hope."

it spawns [tsgo](https://github.com/microsoft/typescript-go), microsoft's native go port of tsserver, per `tsconfig.json` it sees, keeps it warm, and routes tool calls to the right one. one process per project, lazy-spawned, not one per request.

designed in my head, built by claudus, tested on your codebase, cheers.

## you need

- node 22+
- a typescript project (anything with a `tsconfig.json`)
- [claude code](https://claude.com/claude-code), or any other agent that can shell out

## install

```bash
npm install -g @0xdeafcafe/tslsp-cli

# drop the skill where claude code will find it
tslsp-cli install --skills                       # ~/.claude/skills/tslsp/SKILL.md
tslsp-cli install --skills --project             # ./.claude/skills/tslsp/ (commit it)

# extra credit: also append a one-liner to CLAUDE.md so claude routes here
# without re-reading the skill. idempotent — guarded by a marker comment.
tslsp-cli install --skills --with-claude-md
tslsp-cli install --skills --project --with-claude-md

# overwrite an already-installed skill (e.g. after upgrading tslsp-cli)
tslsp-cli install --skills --force
```

the skill tells claude when to reach for `tslsp-cli` instead of `Grep`/`Edit`/`mv`. `--with-claude-md` is the belt to that skill's braces: a few lines in `CLAUDE.md` so the routing rule survives any session where claude doesn't get round to loading skills. `tslsp-cli --help` lists every command; the agent can drive it raw from `--help` if you skip both.

prefer source? clone, build, point your tool at the built bin:

```bash
git clone https://github.com/0xdeafcafe/tslsp-cli.git
cd tslsp-cli && pnpm install && pnpm run build
./dist/cli.js --help
```

## make claude actually use it

claude won't reach for an external tool just because it exists. you have to tell it, and you have to be explicit about which built-in tool it replaces. `tslsp-cli install --skills` drops a ready-made SKILL.md that does exactly that. if you'd rather paste it yourself, here's the block — works in `~/.claude/CLAUDE.md` or a project's `CLAUDE.md`:

```markdown
## TypeScript code intelligence (tslsp)

In any TS/JS project with a `tsconfig.json`, the `tslsp-cli` CLI is type-aware
and MUST be used (via `Bash`) instead of the built-in text tools for the
operations below. Text tools see strings; tslsp-cli sees the program.

| Task                          | DO use                              | DO NOT use                             |
| ----------------------------- | ----------------------------------- | -------------------------------------- |
| Find every usage of a symbol  | `tslsp-cli references --symbol N`   | `Grep`, `Glob`                         |
| Search for a symbol by name   | `tslsp-cli find-symbol NAME`        | `Grep`                                 |
| Jump to a definition          | `tslsp-cli definition --symbol N`   | `Grep` + `Read`                        |
| Jump to a value's _type_      | `tslsp-cli type-definition …`       | `Grep` + `Read`                        |
| Find concrete implementations | `tslsp-cli implementation --symbol` | `Grep`                                 |
| Rename a symbol               | `tslsp-cli rename … --new-name N`   | `Edit`, find-and-replace               |
| Rename/move a file or folder  | `tslsp-cli rename-file OLD NEW`     | `mv` / `git mv` (won't update imports) |
| Type / JSDoc for a symbol     | `tslsp-cli hover --symbol NAME`     | `Read`                                 |
| Outline a file before reading | `tslsp-cli outline FILE`            | `Read` on the whole file               |
| Type errors after an edit     | `tslsp-cli diagnostics --file F`    | `Bash` running `tsc` ad-hoc            |
| Trace callers / callees       | `tslsp-cli call-hierarchy --symbol` | repeated `references` calls            |
| Organize imports / quick-fix  | `tslsp-cli code-action …`           | manual edit                            |

Hard rules:

1. NEVER rename a TypeScript identifier with `Edit` or `MultiEdit`. Use
   `tslsp-cli rename --symbol OLD --new-name NEW`. Pass `--dry-run` first
   when the symbol has many call sites; review the preview, then apply.
   This applies to every identifier — slice keys (`features.fooUi`),
   property names, enum members, the lot.
2. NEVER `mv` or `git mv` a TypeScript file or folder. Use
   `tslsp-cli rename-file OLD NEW` — it walks every import that references
   the file and rewrites them.
3. NEVER `Grep` for a symbol name to find usages or definitions. Use
   `tslsp-cli references --symbol NAME` or
   `tslsp-cli definition --symbol NAME`. Grep matches strings in comments,
   in unrelated identifiers, in `.md` files — it lies.
4. Before reading a large file, call `tslsp-cli outline FILE` first and use
   the line numbers to `Read` only the slices you need.
5. After non-trivial edits to a TS file, call
   `tslsp-cli diagnostics --file FILE` to confirm it still type-checks
   before claiming the change is done.

Batch by default. Most read-only commands take a list (positional or
`--symbols`/`--files`/`--queries`). One call beats N round-trips:

- `tslsp-cli find-symbol User Account Session` # grep -E equivalent
- `tslsp-cli hover --symbols User,Account,Session`
- `tslsp-cli outline 'src/**/*.ts'` # glob expansion
- `tslsp-cli diagnostics src/api/` # directory walk
- `tslsp-cli references --symbol User --summary` # `path (N): lines`

Filter, don't drown. Workspace symbol search is fuzzy and noisy by default:

- `tslsp-cli find-symbol User --kind class,interface` # drop the matches you don't want
- `tslsp-cli find-symbol stamp --container Util` # only `Util.stamp`, not other `stamp`s
- `tslsp-cli outline --depth 0 src/big.ts` # top-level only on huge files

Fall back to the built-in text tools only for: string literals, comments,
non-TS files (Markdown, YAML, configs), or projects without a `tsconfig.json`.
```

## commands

| command           | what it does                                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| `find-symbol`     | workspace symbol search by name. multi-query positional or `--queries a,b,c`. `--kind`, `--container` to trim.    |
| `references`      | every reference to a symbol. locator or `--symbols` batch. `--summary` for `path (N): lines` form.                |
| `definition`      | jump to where a symbol is defined. batches via `--symbols`.                                                       |
| `type-definition` | jump to a value's _type_ declaration (vs. its value declaration). batches via `--symbols`.                        |
| `implementation`  | concrete implementations of an interface/abstract member. batches via `--symbols`.                                |
| `rename`          | type-aware rename across every file. `--dry-run` previews without writing.                                        |
| `rename-file`     | move a file or folder; updates every import that referenced it. folders walked recursively.                       |
| `hover`           | type signature + JSDoc for a symbol. batches via `--symbols`.                                                     |
| `outline`         | indented declaration outline. accepts files, globs (`'src/**/*.ts'`), directories. `--depth`, `--kind` to narrow. |
| `diagnostics`     | type errors. files, globs, directories. omit args to aggregate across every open file.                            |
| `call-hierarchy`  | callers and callees of a function. `--direction incoming` / `outgoing` / `both`.                                  |
| `code-action`     | list quick-fixes / refactors / organize-imports; pass `--apply N` to apply by index.                              |

### symbol locator

every position-taking command takes one of three forms, in priority order:

```
--file F --line L --character C   # explicit LSP position
--file F --line L --symbol NAME   # scan line L of F for NAME
--symbol NAME                     # workspace symbol search; exits 2 with candidates if ambiguous
```

LLMs know line numbers and symbol names but not character columns. modes 2 and 3 cover the gap.

### batching

most read-only commands take an array variant. one CLI call → N parallel LSP queries → one labelled return:

```bash
tslsp-cli find-symbol  User Account Session              # multi-positional
tslsp-cli find-symbol  --queries User,Account,Session    # equivalent flag form
tslsp-cli hover        --symbols User,Account,Session
tslsp-cli references   --symbols add,sum,double
tslsp-cli outline      src/api.ts src/db.ts src/cache.ts
tslsp-cli outline      'src/**/*.ts'                     # glob (quote it)
tslsp-cli outline      src/api/                          # directory walk
tslsp-cli diagnostics  'src/**/*.ts'
tslsp-cli diagnostics  src/api/
```

each block labelled `=== name ===`.

`find-symbol` is the one exception: its batch is serialized, not parallel, because tsgo's `workspace/symbol` races at cold-start when concurrent queries land before the index is built. you still save the CLI round-trips and the agent tokens — just don't expect internal parallelism.

### output is squeezed for tokens

batched calls drop dead weight so claude doesn't burn context on emptiness:

- **clean items disappear**: `diagnostics src/` on 20 files where only one has errors emits just that one labelled block. the other 19 don't get `=== file ===\nno diagnostics` headers.
- **all-clean collapses**: `diagnostics 'src/**/*'` on a clean tree returns a single line, `no diagnostics`. not 200 redundant blocks.
- **diagnostics findings get a count header**: when there _are_ errors, the batch leads with `3 errors, 1 warn across 2 files` so the agent can decide whether to drill in before reading details.
- **`references --summary`** prints `N refs across M files` then `path (N): line, line, line` per file. drops snippets. a heavily-referenced symbol drops from ~15KB to a few hundred bytes. `--limit` caps the file list (not the refs themselves — per-file counts stay accurate), with a `+N more files (raise --limit)` trailer.
- **truncation is terse**: `+47 more (raise --limit)` instead of `(showing 200 of 247 — narrow the query to see more)`.

errors are always kept and labelled, even in batches that otherwise collapsed. you want to see those.

### globs and directory walks

`outline` and `diagnostics` take any mix of literal files, directories, and globs:

```bash
tslsp-cli diagnostics 'src/**/*.ts'      # whole tree, one call
tslsp-cli outline     src/api/           # recursive directory walk
tslsp-cli outline     src/a.ts 'lib/**/*.tsx' src/cache/
```

source-extension filter (`.ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs`) and an ignore set (`node_modules`, `.git`, `dist`, `build`, `out`, `.next`, `coverage`) keep generated and dependency code out. if you _do_ want to look inside an ignored directory, name it explicitly in the pattern — `node_modules/**/*.ts` is honoured.

## CLI

```bash
tslsp-cli find-symbol User                              # positional == --query
tslsp-cli find-symbol User Account Session              # multi-query batch
tslsp-cli find-symbol User --kind class,interface       # filter by symbol kind
tslsp-cli find-symbol stamp --container Util            # only members of `Util`
tslsp-cli references --symbol User
tslsp-cli references --symbol User --summary            # file:count:lines, no snippets
tslsp-cli definition --symbol User
tslsp-cli rename --symbol oldName --new-name newName --dry-run
tslsp-cli rename-file src/old.ts src/new.ts --dry-run
tslsp-cli rename-file src/components src/widgets       # folders supported
tslsp-cli hover --symbol User
tslsp-cli outline src/api.ts
tslsp-cli outline 'src/**/*.ts'                         # globs
tslsp-cli outline --depth 0 src/big.ts                  # top-level only
tslsp-cli outline --kind class,function src/big.ts      # filter by kind
tslsp-cli diagnostics --file src/x.ts
tslsp-cli diagnostics 'src/**/*.ts'                     # batch via glob
tslsp-cli call-hierarchy --symbol handleRequest --direction incoming
tslsp-cli code-action --file src/x.ts --kind source.organizeImports
tslsp-cli code-action --file src/x.ts --kind source.organizeImports --apply 0

tslsp-cli --help                                        # all commands
tslsp-cli <command> --help                              # per-command flags
tslsp-cli install --skills                              # SKILL.md → ~/.claude/skills/tslsp/
tslsp-cli install --skills --project --with-claude-md   # skill + CLAUDE.md nudge
tslsp-cli --daemon <command>                            # route through a warm daemon
tslsp-cli --json <command>                              # wrap stdout in a JSON envelope
tslsp-cli --session NAME <cmd>                          # pick a named daemon session
tslsp-cli daemon start                                  # explicit spawn (autospawn works too)
tslsp-cli daemon list                                   # show running daemons
tslsp-cli daemon stop                                   # graceful stop for this workspace
tslsp-cli daemon restart                                # stop + start (use after upgrading)
tslsp-cli daemon kill-all                               # SIGKILL every daemon (escape hatch)
```

## how it works

```
tslsp-cli <cmd>             ← fresh process, fresh LspPool, disposes after the call
tslsp-cli --daemon <cmd>    ← autospawns a per-workspace daemon, RPCs into it
                              ↓
                        LspPool → tsgo (project A)
                                → tsgo (project B)
                                → ...
```

on first call against a file, the host walks up to the nearest `tsconfig.json`, spawns tsgo there, opens a seed file so the workspace symbol index populates, and caches the process. subsequent calls in the same process reuse it. when you edit files via `rename` or `rename-file`, it pushes `didClose`/`didOpen` + `workspace/didChangeWatchedFiles` (and `didRenameFiles` for moves) so the index reprojects.

`--daemon` mode keeps the LspPool alive between CLI calls via a unix socket at `$CACHE/tslsp/daemon/<sha1(tsconfig-dir)>/<session>.sock` (macOS: `~/Library/Caches`, Linux: `$XDG_CACHE_HOME`, Windows: `%LOCALAPPDATA%`; override with `TSLSP_DAEMON_DIR`). The daemon self-exits after 30 min idle (`TSLSP_DAEMON_IDLE_MS`); individual tsgos within it reap after 10 min (`TSLSP_TSGO_IDLE_MS`). After upgrading the published version, run `tslsp-cli daemon restart` so the daemon picks up the new build (otherwise you'll get a friendly version-mismatch error).

## gotchas

- pins `@typescript/native-preview` to a specific dev build. tsgo moves fast and dev builds shift. bump the version in `package.json` deliberately.
- if you have an older homebrew-installed `tsgo` on your PATH, tslsp-cli ignores it and uses the npm-pinned one. earlier versions had behavior we explicitly don't want.
- `rename` and `rename-file` write to disk. `--dry-run` previews first; `git diff` is your friend either way.
- one tsgo process per `tsconfig.json` root. monorepos with many tsconfigs spawn many tsgos lazily; first hit per project pays project-load cost (~50ms on small, more on large).
- the CLI spawns a fresh tsgo per invocation by default. fine for one-off calls; for a tight refactor loop, pass `--daemon` for a warm tsgo via unix socket.
- `--daemon` keeps files open across calls. if you edit files externally between two daemon-routed calls, the daemon's view may briefly lag until the next file-open or `didChangeWatchedFiles` event.
- daemon stderr lives at `$CACHE/tslsp/daemon/<hash>/<session>.err` — first place to look if a spawn fails.
- set `TSLSP_VERBOSE=1` to forward tsgo's stderr.
- always quote glob patterns (`'src/**/*.ts'`) so your shell doesn't expand them before tslsp-cli sees them. unquoted globs that match no files become literal arguments and the LSP errors instead of the glob expander matching nothing.
