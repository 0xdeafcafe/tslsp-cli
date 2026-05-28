---
name: tslsp
description: Type-aware TypeScript/JavaScript code intelligence — references, rename, file/folder rename, symbols, diagnostics, call hierarchy, code actions — via tsgo (Microsoft's native TypeScript language server). Use instead of grep/edit/mv for symbol-aware tasks.
allowed-tools: Bash(tslsp:*), Bash(npx:*)
---

# tslsp — TypeScript code intelligence

In any TypeScript/JavaScript project with a `tsconfig.json`, prefer `tslsp` over text tools (`Grep`, `Edit`, `MultiEdit`, `mv`) for symbol-aware work. It talks to the TypeScript language server, so it sees the program, not strings.

If the global `tslsp` binary is missing, fall back to `npx --no-install @0xdeafcafe/tslsp-cli tslsp …`.

## When to use

| task                              | use                        | not                |
| --------------------------------- | -------------------------- | ------------------ |
| find usages of a symbol           | `tslsp references`         | `grep`             |
| search workspace for a symbol     | `tslsp find-symbol`        | `grep`             |
| jump to a definition              | `tslsp definition`         | `grep` + `read`    |
| jump to a value's *type*          | `tslsp type-definition`    | `grep` + `read`    |
| find concrete implementations     | `tslsp implementation`     | `grep`             |
| rename a symbol                   | `tslsp rename`             | `edit`/`multi-edit`/find-and-replace |
| **move/rename a file or folder**  | `tslsp rename-file`        | `mv` / `git mv` (breaks every import) |
| type/JSDoc for a symbol           | `tslsp hover`              | `read`             |
| outline a file before reading     | `tslsp outline`            | full `read`        |
| type errors after an edit         | `tslsp diagnostics`        | ad-hoc `tsc`       |
| trace callers / callees           | `tslsp call-hierarchy`     | repeated `references` |
| organize-imports / quick-fixes    | `tslsp code-action`        | manual edit        |

## Locator forms

Every position-taking command accepts one of:

```
--file F --line N --character C            # explicit LSP position
--file F --line N --symbol NAME            # scan line N for NAME
--symbol NAME                              # workspace symbol search
```

LLMs know lines and names but not columns — use `--symbol`. Ambiguous name-only queries return candidates; pick by file/line and re-run.

## Batch inputs

Most read-only commands accept array inputs that run in parallel. One call beats N round-trips.

```bash
tslsp hover     --symbols User,Repository,AuthService     # comma-separated
tslsp outline   src/api.ts src/db.ts src/cache.ts         # multi-positional
tslsp diagnostics --files src/a.ts,src/b.ts,src/c.ts
tslsp references --symbols add,sum,double
```

Output is labeled with `=== <name> ===` per block.

## Commands

```bash
# symbols
tslsp find-symbol User                          # positional == --query
tslsp find-symbol User --file src/api.ts --limit 20

# navigation
tslsp definition       --symbol User
tslsp type-definition  --file src/x.ts --line 12 --symbol value
tslsp implementation   --symbol IGreeter
tslsp references       --symbol User --include-declaration false

# read what something is
tslsp hover    --symbol User
tslsp outline  src/api.ts                       # positional == --file

# refactor
tslsp rename       --symbol oldName --new-name newName --dry-run
tslsp rename       --symbol oldName --new-name newName
tslsp rename-file  src/old.ts src/new.ts --dry-run
tslsp rename-file  src/old.ts src/new.ts
tslsp rename-file  src/components src/widgets   # folders supported

# correctness
tslsp diagnostics --file src/x.ts
tslsp diagnostics --severity error

# call graph
tslsp call-hierarchy --symbol handleRequest --direction incoming
tslsp call-hierarchy --symbol handleRequest --direction outgoing
tslsp call-hierarchy --symbol handleRequest                    # both

# quick-fixes / organize-imports
tslsp code-action --file src/x.ts --kind source.organizeImports
tslsp code-action --file src/x.ts --line 12 --character 4
tslsp code-action --file src/x.ts --kind source.organizeImports --apply 0
```

## Hard rules

1. **NEVER rename a TypeScript identifier with `Edit` or `MultiEdit`.** Use `tslsp rename`. Pass `--dry-run` first when the symbol has many call sites; review the preview, then apply. This applies to *every* identifier — slice keys (`features.fooUi`), property names, enum members, the lot. If you find yourself string-editing a symbol "just for a couple of files" you have already failed the rule. For bulk renames (e.g., renaming a whole feature), enumerate symbols via `tslsp outline` on each file in the folder first, then call `tslsp rename` once per symbol — ~5× cheaper in tokens than grep+Read+Edit and safer (no false positives in comments / strings / unrelated identifiers).
2. **NEVER `mv` or `git mv` a TypeScript file or folder.** Use `tslsp rename-file` — it walks every `import` that references it and rewrites them. After the move you can still use `tslsp rename` for any identifier inside the file; combine the two passes. Folders are supported and traversed recursively.
3. **NEVER `grep` for a symbol name to find usages or definitions.** Use `tslsp references` / `tslsp definition`. Grep matches strings in comments, in unrelated identifiers, in `.md` files — it lies.
4. **Before reading a large file, call `tslsp outline` first** and use the line numbers to `read` only the slices you need. Do not page through 100s of lines hunting for a function.
5. **After non-trivial edits to a TS file, call `tslsp diagnostics`** to confirm it still type-checks before claiming done.

## Output

Output is line-oriented and minimal: one match per line, `path:line[:col]  kind name`. Designed to fit a small context. Pass `--limit N` to cap reference/symbol lists. Batch results are labeled with `=== <name> ===` per block.

## Fallback

Use the built-in text tools only for: string literals, comments, non-TS files (Markdown, YAML, configs), or projects without a `tsconfig.json`.
