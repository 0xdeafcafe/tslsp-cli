---
name: tslsp
description: REQUIRED for any TypeScript/JavaScript symbol work in a project with tsconfig.json. Use INSTEAD OF Grep/Edit/MultiEdit/mv/git mv/tsc when the target is an identifier in .ts/.tsx/.js/.jsx/.mts/.cts/.mjs/.cjs. Type-aware via tsgo. Triggers — finding usages, jumping to a definition, renaming a symbol, moving or renaming a file (with import rewrites), reading type signatures or JSDoc, outlining a file, checking type errors, organizing imports, finding implementations of an interface, tracing callers or callees, applying a quick-fix.
allowed-tools: Bash(npx:*)
---

# tslsp-cli — your only TypeScript navigation/refactor tool

If there's a `tsconfig.json` in the tree and the thing you're touching is an identifier in TS/JS, you use `tslsp-cli`. Not `Grep`, not `Edit`, not `mv`. tsgo (Microsoft's native TypeScript LSP) actually understands the program; text tools see characters.

This is not "a faster grep." It's the difference between a refactor that compiles and a refactor that bricks production.

## How to invoke

Run every command through `npx --no-install`:

```bash
npx --no-install @0xdeafcafe/tslsp-cli <command> [args...]
```

`--no-install` is deliberate — it uses the project-local or globally-installed `@0xdeafcafe/tslsp-cli` and fails loudly if neither is present, instead of silently fetching a random version mid-refactor. If it errors with "not installed," tell the user to run `npm i -g @0xdeafcafe/tslsp-cli` (or add it as a devDependency) and stop.

In the examples below, `tslsp-cli` is shorthand for `npx --no-install @0xdeafcafe/tslsp-cli`. Type it out in full when you actually invoke it.

## The rule

**Before you Grep/Edit/Read/mv anything in TS/JS code, ask: "is the thing I'm touching an identifier?" If yes → tslsp-cli. No exceptions.**

You will be tempted to use Grep "just to look." Resist. Workspace symbol search through `tslsp-cli find-symbol` is the same shape — and it gives you the declaration, not 40 hits in JSDoc and string literals.

## The substitution table — memorize this

| Your reflex                       | What's wrong with it                                                                          | What you do instead                                            |
| --------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `Grep "User"`                     | Matches comments, markdown, string literals, unrelated identifiers. Silently lies.            | `tslsp-cli find-symbol User`                                   |
| `Grep -E "User\|Account"`         | Same lies, multiple times.                                                                    | `tslsp-cli find-symbol User Account`                           |
| `Grep "User" src/`                | Type-blind.                                                                                   | `tslsp-cli find-symbol User --kind class,interface`            |
| `Grep` to find every usage        | You'll miss a re-export and ship a broken rename.                                             | `tslsp-cli references --symbol User`                           |
| `Grep` to find the definition     | You get the import line, not the declaration.                                                 | `tslsp-cli definition --symbol User`                           |
| `Grep` for `implements X`         | Misses anything that isn't a literal match.                                                   | `tslsp-cli implementation --symbol X`                          |
| `Edit` / `MultiEdit` to rename    | One missed import → prod break. Catastrophic for common names (`User`, `get`, `id`, `value`). | `tslsp-cli rename --symbol Old --new-name New`                 |
| `mv` / `git mv` a `.ts`/`.tsx`    | Every `import` that pointed at the old path still does. TS doesn't re-resolve on move.        | `tslsp-cli rename-file OLD NEW`                                |
| `Read` a 2000-line file to "look" | Wastes tokens. You need the shape, not the bytes.                                             | `tslsp-cli outline FILE` → `Read` only the line range you need |
| `Bash tsc`                        | Spawns the whole compiler. Slow. No cache.                                                    | `tslsp-cli diagnostics --file FILE`                            |
| Reading 5 callers manually        | Tedious and incomplete.                                                                       | `tslsp-cli call-hierarchy --symbol fn --direction incoming`    |

These are HARD rules. They apply to every identifier — slice keys (`features.fooUi`), property names, enum members, type aliases, parameter names. "It's just a few files" is exactly how a missed import ships.

## Copy these patterns

```bash
# Find — workspace search, fuzzy. Filter noise with --kind / --container.
tslsp-cli find-symbol User
tslsp-cli find-symbol User Account Session            # multi-query (grep -E equivalent)
tslsp-cli find-symbol User --kind class,interface     # drop methods/vars named user
tslsp-cli find-symbol stamp --container Util          # only Util.stamp, not other stamps

# Where does this come from / where is it used / who implements it?
tslsp-cli definition     --symbol User
tslsp-cli references     --symbol User
tslsp-cli references     --symbol User --summary      # path (N): lines — huge token cut on popular symbols
tslsp-cli implementation --symbol IGreeter
tslsp-cli type-definition --symbol someValue

# Rename — ALWAYS --dry-run first on common names.
tslsp-cli rename --symbol User --new-name Account --dry-run
tslsp-cli rename --symbol User --new-name Account

# Move a file or folder — rewrites every import that pointed at it.
tslsp-cli rename-file src/old/User.ts src/users/User.ts --dry-run
tslsp-cli rename-file src/old/User.ts src/users/User.ts

# Outline — read structure, not bytes. Accepts globs and directories.
tslsp-cli outline src/api.ts
tslsp-cli outline 'src/**/*.ts'                        # quote the glob
tslsp-cli outline src/api/                             # directory walk
tslsp-cli outline --depth 0 src/big-file.ts            # top-level only
tslsp-cli outline --kind class,function src/big.ts     # skip the noise

# Type signature / JSDoc.
tslsp-cli hover --symbol User
tslsp-cli hover --symbols User,Account,Session         # batch

# Did my edit type-check?
tslsp-cli diagnostics --file src/api.ts
tslsp-cli diagnostics 'src/**/*.ts'                    # whole tree, one call
tslsp-cli diagnostics src/api/                         # directory walk

# Trace control flow.
tslsp-cli call-hierarchy --symbol handleRequest --direction incoming
tslsp-cli call-hierarchy --symbol handleRequest --direction outgoing

# Quick-fixes / organize imports.
tslsp-cli code-action --file src/x.ts --kind source.organizeImports
tslsp-cli code-action --file src/x.ts --kind source.organizeImports --apply 0
```

Every command takes `--help`. Output is line-oriented: `path:line[:col]  kind name`.

## Locator forms — pick the cheapest you can

When a command needs a position (`references`, `definition`, `rename`, `hover`, `type-definition`, `implementation`, `call-hierarchy`):

```
--symbol NAME                              workspace search by name (default — start here)
--file F --line L --symbol NAME            scan line L of F for NAME
--file F --line L --character C            exact zero-based LSP position
```

You almost always know the name; you almost never know the column. Use `--symbol`. If the name is ambiguous, the tool exits with code 2 and prints candidates — read them, pick by file/line, re-call with `--file --line`.

## Batch when you can — the grep -E equivalent

Every read-only command takes a list. One call beats N round-trips and saves tokens. Use this aggressively.

```bash
tslsp-cli find-symbol  add double sum                    # multi-positional
tslsp-cli find-symbol  --queries add,double,sum          # equivalent flag form
tslsp-cli hover        --symbols User,Account,Session
tslsp-cli references   --symbols add,sum,double
tslsp-cli definition   --symbols ParseError,RangeError
tslsp-cli outline      src/api.ts src/db.ts src/cache.ts
tslsp-cli outline      'src/**/*.ts'                     # glob expansion
tslsp-cli diagnostics  'src/api/**/*.ts'
```

Output is labeled `=== NAME ===` per item that had findings. Clean items are dropped — if every item in the batch was empty, you get a single short line (e.g. `no diagnostics`) instead of N redundant blocks. For diagnostics specifically, batched output is prefixed with a count summary (`3 errors, 1 warn across 2 files`) so you can decide whether to drill in.

## Verification — non-optional

After any non-trivial edit:

```bash
tslsp-cli diagnostics --file <the file you touched>
```

Code that compiles in your head isn't code that compiles in TypeScript. A missed export, a wrong arity, a stale signature — diagnostics catches them. Run it before you say "done."

## Speed: `--daemon` for tight refactor loops

Default mode spawns a fresh tsgo per call (~200ms–2s). For a refactor with many calls in a row, add `--daemon` — calls route through a warm per-workspace daemon (autospawned on first call, idle-reaps after 30 min).

```bash
tslsp-cli --daemon references --symbol User
tslsp-cli --daemon rename --symbol User --new-name Account
```

Other helpers: `tslsp-cli daemon list`, `tslsp-cli daemon stop`, `tslsp-cli daemon restart` (after upgrading the package).

## When NOT to use tslsp-cli

Use `Grep` / `Edit` / `Read` / `mv` only for:

- String literals (searching for an error-message string in code)
- Comments and docs (`.md`, `.txt`)
- Config that isn't TS (`.yaml`, plain `.json`)
- Projects with **no** `tsconfig.json`

If the thing you're acting on is an identifier in TS/JS under a `tsconfig.json`, **`tslsp-cli`**. No exceptions for "small changes" or "I already know where it is" — those are the cases this exists for.

## Make Claude reach for this without thinking

```bash
# Project: skill + a CLAUDE.md nudge so Claude routes here every session.
npx --no-install @0xdeafcafe/tslsp-cli install --skills --project --with-claude-md

# User: same, but available to every project on the machine.
npx --no-install @0xdeafcafe/tslsp-cli install --skills --with-claude-md
```

`--with-claude-md` appends a short routing block to `CLAUDE.md` (idempotent — guarded by a marker comment). Project scope writes to `./CLAUDE.md`; user scope writes to `~/.claude/CLAUDE.md`.
