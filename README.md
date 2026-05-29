# tslsp-cli

[![npm](https://img.shields.io/npm/v/@0xdeafcafe/tslsp-cli.svg?logo=npm&label=npm)](https://www.npmjs.com/package/@0xdeafcafe/tslsp-cli)
[![CI](https://github.com/0xdeafcafe/tslsp-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/0xdeafcafe/tslsp-cli/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/@0xdeafcafe/tslsp-cli.svg?logo=node.js)](https://github.com/0xdeafcafe/tslsp-cli/blob/main/package.json)

claude finds references by grepping. claude renames things by find-and-replacing. this is fine until your symbol is called `User` or `get` or `value`, at which point it confidently rewrites half your codebase and tells you it's done. thanks, gas-lightyear.

`tslsp-cli` is a CLI in front of [tsgo](https://github.com/microsoft/typescript-go) (microsoft's native go port of tsserver). rename is type-aware. references are real references. moving a file rewrites every import that pointed at it. `outline` is the LSP's structural view, not "read 200 lines and hope." one tsgo per `tsconfig.json`, lazy-spawned, optionally kept warm.

designed in my head, built by claudus, tested on your codebase, cheers.

## install

```bash
npm install -g @0xdeafcafe/tslsp-cli

tslsp-cli install --skills --project --with-claude-md   # recommended
# ↑ writes ./.claude/skills/tslsp/SKILL.md AND appends a routing rule to
# ./CLAUDE.md so claude reaches for tslsp-cli instead of Grep/Edit/mv.
# both are idempotent. drop --project to install user-wide (~/.claude).
# add --force to overwrite an existing skill (e.g. after upgrading).
```

if you'd rather paste a rule than install the skill, the canonical block lives at [`skills/tslsp/SKILL.md`](skills/tslsp/SKILL.md). copy whatever you want into `CLAUDE.md`.

prefer source? `git clone … && pnpm install && pnpm run build`, then point your agent at `./dist/cli.js`.

## commands

| command           | what it does                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| `find-symbol`     | workspace symbol search. multi-query positional or `--queries a,b,c`. `--kind`, `--container` filter.  |
| `references`      | every reference. locator or `--symbols` batch. `--summary` for `path (N): lines` form.                 |
| `definition`      | jump to where a symbol is defined. `--symbols` batch.                                                  |
| `type-definition` | jump to a value's _type_ declaration (vs. value). `--symbols` batch.                                   |
| `implementation`  | concrete implementations of an interface/abstract member. `--symbols` batch.                           |
| `rename`          | type-aware rename across every file. `--dry-run` previews.                                             |
| `rename-file`     | move a file or folder; updates every import. folders walked recursively.                               |
| `hover`           | type signature + JSDoc. `--symbols` batch.                                                             |
| `outline`         | indented declaration outline. files, globs (`'src/**/*.ts'`), directories. `--depth`, `--kind` narrow. |
| `diagnostics`     | type errors. files, globs, directories. no args → aggregate across every open file.                    |
| `call-hierarchy`  | callers and callees. `--direction incoming` / `outgoing` / `both`.                                     |
| `code-action`     | list quick-fixes / refactors / organize-imports; `--apply N` applies one.                              |

`tslsp-cli --help` and `tslsp-cli <command> --help` are authoritative.

## shape

**locator.** position-taking commands accept, in priority order:

```
--file F --line L --character C   # explicit LSP position
--file F --line L --symbol NAME   # scan line L of F for NAME
--symbol NAME                     # workspace search; exits 2 with candidates if ambiguous
```

LLMs know symbol names and (usually) line numbers, not columns. modes 2 and 3 cover the gap.

**batch.** every read-only command takes a list. one CLI call → N parallel LSP queries → one labelled return:

```bash
tslsp-cli find-symbol  add double sum                # multi-positional (grep -E equivalent)
tslsp-cli hover        --symbols User,Account,Session
tslsp-cli references   --symbols add,sum,double
tslsp-cli outline      'src/**/*.ts'                 # glob — QUOTE IT
tslsp-cli diagnostics  src/api/                      # directory walk
```

each block labelled `=== name ===`. `find-symbol` serializes internally (tsgo's workspace/symbol races at cold-start); everything else fans out.

**globs / directories.** filtered through a source-extension set (`.ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs`) and an ignore set (`node_modules`, `.git`, `dist`, `build`, `out`, `.next`, `coverage`). escape hatch: mention an ignored segment in the pattern itself (`node_modules/**/*.ts`) and those hits come back.

**output is squeezed.** batched calls drop dead weight:

- clean items disappear — `diagnostics src/` on 20 files where one has errors emits just that block. the other 19 don't get `=== file ===\nno diagnostics` headers.
- all-clean batches collapse to one line: `no diagnostics`.
- diagnostics findings lead with `3 errors, 1 warn across 2 files`.
- `references --summary` prints `N refs across M files` then `path (N): l1, l2, l3`. drops snippets; ~15KB → a few hundred bytes on heavily-referenced symbols. `--limit` caps the file list with a `+N more files (raise --limit)` trailer.
- truncation is terse: `+47 more (raise --limit)`.

errors are always kept and labelled. you want to see those.

## daemon

```
tslsp-cli <cmd>             ← fresh tsgo, disposes after the call
tslsp-cli --daemon <cmd>    ← per-workspace daemon, RPCs into it
```

fresh-process mode is fine for one-off calls. for a tight refactor loop, pass `--daemon`: the first call autospawns a per-workspace daemon at `$CACHE/tslsp/daemon/<sha1(tsconfig-dir)>/<session>.sock` (macOS `~/Library/Caches`, Linux `$XDG_CACHE_HOME`, Windows `%LOCALAPPDATA%`; override `TSLSP_DAEMON_DIR`). subsequent calls reuse it.

```bash
tslsp-cli --daemon references --symbol User
tslsp-cli daemon list           # running daemons
tslsp-cli daemon restart        # after upgrading tslsp-cli
tslsp-cli daemon stop           # graceful stop for this workspace
tslsp-cli daemon kill-all       # SIGKILL every daemon
```

the daemon self-exits after 30 min idle (`TSLSP_DAEMON_IDLE_MS`); individual tsgos inside reap after 10 min (`TSLSP_TSGO_IDLE_MS`). version-skewed daemons refuse new calls — run `daemon restart` after upgrading.

## gotchas

- pins `@typescript/native-preview` to a specific dev build. tsgo moves fast; bump the version in `package.json` deliberately.
- `rename` and `rename-file` write to disk. `--dry-run` previews first; `git diff` is your friend either way.
- always quote glob patterns (`'src/**/*.ts'`). unquoted globs that match nothing in your shell become literal arguments and the LSP errors instead of the expander finding zero files.
- one tsgo per `tsconfig.json` root. monorepos pay project-load cost the first time each project is hit (~50ms small, more on large).
- `--daemon` keeps files open across calls. external edits between two daemon-routed calls may briefly lag until the next file-open or `didChangeWatchedFiles` event.
- daemon stderr lives at `$CACHE/tslsp/daemon/<hash>/<session>.err` — first place to look if a spawn fails.
- `TSLSP_VERBOSE=1` forwards tsgo's stderr.
- if homebrew installed `tsgo` on your PATH from before, tslsp-cli ignores it and uses the npm-pinned one.
