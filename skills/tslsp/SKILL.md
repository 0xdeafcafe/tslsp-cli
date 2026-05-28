---
name: tslsp
description: Use for ANY TypeScript/JavaScript symbol-level work in a project with a tsconfig.json — find usages, jump to definition, rename a symbol, move or rename a file (rewrites imports), get type/JSDoc, outline a file, check type errors, organize imports, find implementations, trace call hierarchy. Replaces Grep, Edit, MultiEdit, mv, git mv, and ad-hoc tsc invocations on TS/JS code. Type-aware via tsgo (Microsoft's native TypeScript language server).
allowed-tools: Bash(tslsp-cli:*), Bash(npx:*)
---

# tslsp-cli — TypeScript code intelligence (CLI)

You are working in a project that has a `tsconfig.json`. For anything that touches a TypeScript identifier — find it, follow it, rename it, move the file it lives in, check whether your edit broke its type — use the `tslsp-cli` CLI via `Bash`. It talks to the TypeScript language server, so it sees the _program_, not strings.

## STOP. These reflexes are wrong for TypeScript code.

| You're about to…                      | Why that's broken                                                                                    | What to type instead                                          |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `Grep` for a symbol name              | Matches the name in comments, in `.md`, in unrelated identifiers, in string literals. Silently lies. | `tslsp-cli references --symbol NAME`                          |
| `Edit` / `MultiEdit` to rename        | Misses one import; production breaks. Catastrophic for common names (`User`, `get`, `value`, `id`).  | `tslsp-cli rename --symbol OLD --new-name NEW`                |
| `mv` / `git mv` a `.ts` / `.tsx` file | Every `import` that pointed at the old path still does. TypeScript doesn't re-resolve on move.       | `tslsp-cli rename-file OLD-PATH NEW-PATH`                     |
| `Read` a large file to "look around"  | Wastes tokens; you need the structure, not the body.                                                 | `tslsp-cli outline FILE` → `Read` only the line range         |
| `Bash` running `tsc` to check errors  | Re-spawns the type-checker, slow, no incremental cache.                                              | `tslsp-cli diagnostics --file FILE`                           |
| `Grep` to find a definition           | Same as above, plus you get the import line, not the declaration.                                    | `tslsp-cli definition --symbol NAME`                          |
| `Grep` to find implementations        | Misses anything that isn't a literal `implements X` match.                                           | `tslsp-cli implementation --symbol NAME`                      |
| Read N call sites to trace callers    | Tedious and incomplete.                                                                              | `tslsp-cli call-hierarchy --symbol NAME --direction incoming` |

These are HARD rules. They apply to _every_ identifier — including slice keys (`features.fooUi`), property names, enum members, type aliases, parameter names. "Just a couple of files" is how you ship a broken rename.

## What to type — copy these patterns

```bash
# find every usage of User across the workspace
tslsp-cli references --symbol User

# jump to where User is defined
tslsp-cli definition --symbol User

# rename — ALWAYS --dry-run first when call sites are likely many
tslsp-cli rename --symbol User --new-name Account --dry-run
tslsp-cli rename --symbol User --new-name Account

# move a file (folders work too) — rewrites every import that pointed at it
tslsp-cli rename-file src/old/User.ts src/users/User.ts --dry-run
tslsp-cli rename-file src/old/User.ts src/users/User.ts

# what does this file contain? — outline instead of reading
tslsp-cli outline src/api.ts

# what's the type / JSDoc for this symbol?
tslsp-cli hover --symbol User

# did my edit type-check?
tslsp-cli diagnostics --file src/api.ts

# trace callers / callees
tslsp-cli call-hierarchy --symbol handleRequest --direction incoming
tslsp-cli call-hierarchy --symbol handleRequest --direction outgoing

# find implementations of an interface / abstract method
tslsp-cli implementation --symbol IGreeter

# organize imports / apply quick-fixes
tslsp-cli code-action --file src/x.ts --kind source.organizeImports
tslsp-cli code-action --file src/x.ts --kind source.organizeImports --apply 0
```

Every command takes `--help`. Output is line-oriented: `path:line[:col]  kind name`.

## Locator forms — pick the cheapest you can

When a command takes a position (`references`, `definition`, `rename`, `hover`, `type-definition`, `implementation`, `call-hierarchy`, `code-action`):

```
--symbol NAME                              # workspace search by name
--file F --line L --symbol NAME            # scan line L of F for NAME
--file F --line L --character C            # exact zero-based LSP position
```

You almost always know the name; you almost never know the column. Prefer `--symbol NAME` first; fall back to `--file --line --symbol` when the name is ambiguous. Ambiguous `--symbol` exits with code `2` and prints candidates — read them, pick by file/line, re-call.

## Batch when you can

Most read-only commands accept array inputs that run in parallel. One call beats N round-trips on tokens and latency:

```bash
tslsp-cli hover       --symbols User,Account,Session
tslsp-cli outline     src/api.ts src/db.ts src/cache.ts
tslsp-cli diagnostics --files src/a.ts,src/b.ts,src/c.ts
tslsp-cli references  --symbols add,sum,double
```

Output is labeled `=== NAME ===` per block.

## Verification ritual — after every non-trivial edit

```bash
tslsp-cli diagnostics --file <the file you touched>
```

Run it before you say "done". Code that compiles in your head doesn't always compile in TypeScript, and a missed export / wrong arity / stale signature is exactly what diagnostics catches.

## Speed: `--daemon` for tight refactor loops

The default CLI spawns a fresh tsgo per call (~200ms–2s on real projects). For a refactor with many calls in a row, add `--daemon` to route through a warm per-workspace daemon (autospawned on first call, idle-reaps after 30 min):

```bash
tslsp-cli --daemon references --symbol User
tslsp-cli --daemon rename --symbol User --new-name Account
```

Other helpers: `tslsp-cli daemon list` (running daemons), `tslsp-cli daemon stop` (this workspace), `tslsp-cli daemon restart` (after upgrading the package).

## Fallback to text tools — narrowly

Use `Grep` / `Edit` / `Read` / `mv` for:

- String literals (searching for an error-message string in code)
- Comments and docs (`.md`, `.txt`)
- Configuration files that aren't TS (`.yaml`, plain `.json`)
- Projects with **no** `tsconfig.json`

If the thing you're acting on is an identifier in a TS/JS file under a `tsconfig.json`, **`tslsp-cli`**. No exceptions for "small changes" or "I already know where it is" — those are the cases the type-aware tool exists for.

## If `tslsp-cli` isn't on PATH

```bash
npx --no-install @0xdeafcafe/tslsp-cli tslsp-cli <command> [...]
```
