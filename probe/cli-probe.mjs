// Manual end-to-end probe: exercises every CLI subcommand against
// probe/sample/, prints results. Requires `pnpm run build` first.
// Useful when you've changed CLI/daemon wiring and want to eyeball output
// without writing an assertion.
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliBin = resolve(here, "../dist/cli.js");
const sample = resolve(here, "sample");

const exec = promisify(execFile);

async function run(label, args) {
  process.stdout.write(`\n--- ${label} ---\n`);
  try {
    const { stdout, stderr } = await exec(process.execPath, [cliBin, ...args], {
      cwd: sample,
      env: { ...process.env, TSLSP_VERBOSE: "1" },
    });
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
  } catch (e) {
    if (e.stdout) process.stdout.write(e.stdout);
    if (e.stderr) process.stderr.write(e.stderr);
    process.stderr.write(`(exited ${e.code})\n`);
  }
}

await run("find-symbol add", ["find-symbol", "add"]);
await run("references --symbol add", ["references", "--symbol", "add"]);
await run("definition --file src/index.ts --line 2 --symbol add", [
  "definition",
  "--file",
  "src/index.ts",
  "--line",
  "2",
  "--symbol",
  "add",
]);
await run("hover --symbol double", ["hover", "--symbol", "double"]);
await run("outline --file src/math.ts", ["outline", "--file", "src/math.ts"]);
await run("diagnostics --file src/math.ts", ["diagnostics", "--file", "src/math.ts"]);
await run("rename --dry-run", ["rename", "--symbol", "add", "--new-name", "sum", "--dry-run"]);

// Re-mess messy.ts so tidy has work to do. Otherwise the fixture is already
// organised from the last run and tidy collapses to "clean", which doesn't
// demonstrate the actual rewrite path.
await writeFile(
  resolve(sample, "src/messy.ts"),
  `import { double } from "./math";
import { readFileSync } from "node:fs";
import { add } from "./math";

const _unused = readFileSync;

export function compute(x: number): number {
  return double(add(x, 1));
}
`,
);
await run("tidy organise-imports src/messy.ts", ["tidy", "organise-imports", "src/messy.ts"]);
await run("tidy organise-imports (idempotent re-run)", [
  "tidy",
  "organise-imports",
  "src/messy.ts",
]);
await run("tidy --help", ["tidy", "--help"]);

await run("daemon list", ["daemon", "list"]);
await run("daemon stop", ["daemon", "stop"]);
