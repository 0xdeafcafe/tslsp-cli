# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm install            # first-time setup
pnpm run build          # clean + tsc → dist/
pnpm run dev            # tsc --watch
pnpm test               # vitest run (all tests)
pnpm test -- <pattern>  # filter by test file: e.g. `pnpm test -- locator`
pnpm test:watch         # watch mode
pnpm run lint           # oxlint
pnpm run format         # oxfmt --write (oxfmt --check via format:check)
node dist/cli.js <cmd>  # invoke the built CLI locally
```

`tests/cli-e2e.test.ts` spawns the built CLI via `node dist/cli.js`, so it runs `pnpm run build` automatically when `dist/cli.js` is missing — but a stale build silently runs the old behavior. **Rebuild before iterating on the e2e suite.**

The package manager is `pnpm@10.29.3` (pinned in `packageManager`). The only runtime dep is `@typescript/native-preview` (tsgo); validation is hand-rolled in `src/schema.ts`. Pinned to a dev build — bump deliberately.

## Architecture

This is a CLI in front of **tsgo** (Microsoft's native Go port of tsserver). It speaks LSP, exposes a small set of code-intelligence commands designed for AI agents, and bills itself as the type-aware replacement for `Grep`/`Edit`/`mv` on TypeScript identifiers.

### Request flow

```
argv → cli.ts → tool dispatch → tools.ts handler → LspPool (workspace.ts)
                                                       ↓
                                                   LspClient (lsp-client.ts) ↔ tsgo subprocess
```

Every position-taking command first runs through **`resolveLocator` (`src/locator.ts`)** which accepts three forms (in priority order):

1. `--file F --line L --character C` — explicit LSP position
2. `--file F --line L --symbol NAME` — scan line L for NAME
3. `--symbol NAME` — workspace symbol search; throws `LocatorError` with candidates if ambiguous

Tool handlers receive an already-resolved `{client, root, uri, position}` so they only deal with LSP, not locator UX.

### Two execution modes

The same tool code is reachable via two paths, selected by a `--daemon` global flag:

- **fresh-process (default):** `runCli` builds an `LspPool`, calls the handler, disposes. One tsgo spawn per invocation.
- **daemon:** `runToolViaDaemon` connects to (or autospawns) a per-workspace Unix socket daemon. The daemon owns a long-lived `LspPool` so subsequent calls reuse warm tsgos.

The daemon side lives in `src/daemon/`:

- `client.ts` — handshake, ensure-spawn, send/receive JSON-line RPC
- `server.ts` — listens on the socket, dispatches `run` requests through the same `getTool(name).handler` as the CLI path
- `control.ts` — `daemon start/stop/restart`, called by both CLI subcommands and tests
- `registry.ts` — session files (`$CACHE/tslsp/daemon/<sha1(tsconfig-dir)>/<session>.sock`)
- `protocol.ts` — `Request`/`Response`/`RunParams` types shared by client and server

**Key invariant:** the daemon path and fresh-process path must produce identical output for the same args. They share `tools.ts` for this reason — when adding behavior, put it in the handler, not the dispatcher.

### Schema layer (`src/schema.ts`)

Hand-rolled replacement for zod. Each tool's `inputSchema` is `Record<string, Schema>` where `Schema` is a tagged union (`StrSchema` | `NumSchema` | …). Construct with `s.str({...})`, `s.int({...})`, `s.arr(element, {...})`, `s.pick([...], {...})`, etc. The factories preserve literal `optional: true` markers so `Infer<typeof shape>` produces the same required-vs-optional split zod did.

The CLI dispatcher (`cli.ts:runTool`) parses argv via `parseArgs` (`cli-args.ts`), then runs `validateShape` against the tool's schema, then hands the validated object to `tool.handler`. The daemon path (`daemon/server.ts:handleRun`) does the same validation server-side so daemon calls don't trust client-supplied JSON.

### Output conventions

Handlers return `ToolResult { text, isError?, empty? }`. `empty: true` signals "no findings" so the `fanout`/`serialJoin` helpers (`tools.ts`) can collapse all-empty batches to a single short line and drop `=== file ===` headers for clean items. `find-symbol` uses `serialJoin` because tsgo's `workspace/symbol` races at cold-start; everything else fans out.

Format helpers in `src/format.ts` are pure — they produce lines like `path:line:col snippet` (locations) or `path (N): l1, l2, l3` (refs `--summary`). Touch these to change agent-facing output shape.

### Agent integration (`src/skill-install.ts` + `skills/tslsp/SKILL.md`)

`tslsp-cli install --skills` copies `skills/tslsp/SKILL.md` into the user's or project's `.claude/skills/tslsp/` and (with `--with-claude-md`) appends a routing nudge to `CLAUDE.md`. The SKILL.md is the **canonical brief** for how an agent should pick between commands — when adding a tool or changing UX, update SKILL.md in the same PR.

## Conventions

- **Style:** `oxfmt` for formatting, `oxlint` for linting. CI runs both via `pnpm run format:check` and `pnpm run lint`.
- **Comments:** explain _why_, not _what_. Several modules carry context-rich comments (the `code_action` resolve fallback in `tools.ts`, the `workspace/symbol` race note above `find-symbol`) — match that bar when adding new ones.
- **Tests:** `tests/cli-e2e.test.ts` runs the real CLI against a tmpdir tsconfig fixture. Unit tests live in sibling files (`schema.test.ts`, `format.test.ts`, `locator.test.ts`, `tools.test.ts` for `fanout`). Prefer unit tests when the logic is a pure helper (extract it if needed) and reserve e2e for argv parsing, exit codes, and dispatch wiring.
- **Releases:** `release-please` manages CHANGELOG and version bumps via Conventional Commits — use `feat:`, `fix:`, `refactor:`, etc., on the merge commit. `feat!:` (or `BREAKING CHANGE:` footer) triggers a minor bump while pre-1.0.
- **Backwards compatibility:** the package is pre-1.0 and recently published. Don't add shims for "old behavior" — change the code.
