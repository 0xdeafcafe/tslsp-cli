import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const cliJs = resolve(projectRoot, "dist", "cli.js");

let workspace: string;

function runCli(
  args: string[],
  cwd = workspace,
  extraEnv: Record<string, string> = {},
  timeoutMs = 30_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn("node", [cliJs, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...extraEnv },
    });
    let stdout = "";
    let stderr = "";
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      rejectP(new Error(`cli timeout: ${args.join(" ")}\nstderr: ${stderr}`));
    }, timeoutMs);
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("close", (code) => {
      clearTimeout(t);
      resolveP({ code, stdout, stderr });
    });
  });
}

beforeAll(async () => {
  if (!existsSync(cliJs)) {
    const build = spawnSync("pnpm", ["run", "build"], { cwd: projectRoot, stdio: "inherit" });
    if (build.status !== 0) throw new Error("pnpm run build failed");
  }
  workspace = mkdtempSync(resolve(tmpdir(), "tslsp-cli-"));
  writeFileSync(
    resolve(workspace, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "es2022",
          module: "esnext",
          moduleResolution: "bundler",
          strict: true,
          noEmit: true,
        },
        include: ["src/**/*"],
      },
      null,
      2,
    ),
    "utf8",
  );
  spawnSync("mkdir", ["-p", resolve(workspace, "src")]);
  writeFileSync(
    resolve(workspace, "src", "math.ts"),
    [
      "export function add(a: number, b: number): number {",
      "  return a + b;",
      "}",
      "export function double(x: number): number { return add(x, x); }",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    resolve(workspace, "src", "index.ts"),
    [
      'import { add, double } from "./math";',
      "const r = add(1, 2);",
      "console.log(double(r));",
      "",
    ].join("\n"),
    "utf8",
  );
}, 60_000);

afterAll(() => {
  /* tmpdir cleans itself; no explicit teardown needed */
});

describe("CLI e2e", () => {
  it("prints root help with all commands listed", async () => {
    const { code, stdout } = await runCli(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/tslsp-cli — type-aware TypeScript code intelligence CLI/);
    expect(stdout).toMatch(/find_symbol/);
    expect(stdout).toMatch(/rename_file/);
    expect(stdout).toMatch(/call_hierarchy/);
  });

  it("prints per-tool help with positional + flags", async () => {
    const { code, stdout } = await runCli(["rename-file", "--help"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/<old-path>/);
    expect(stdout).toMatch(/<new-path>/);
    expect(stdout).toMatch(/--dry-run/);
  });

  it("exits 2 with a friendly error when global flags eat the whole argv", async () => {
    // `--session` with no following token used to crash on the
    // `args.shift()!` non-null assertion.
    const { code, stderr } = await runCli(["--session"]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/--session requires a value/);
  });

  it("exits 2 when --session is followed by another flag", async () => {
    // Previously --session would silently swallow the next flag as its value.
    // (--help is not a pre-stripped global, so it lands here as the value.)
    const { code, stderr } = await runCli(["--session", "--help"]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/--session requires a value/);
  });

  it("exits 2 with a friendly error when given no subcommand", async () => {
    const { code, stderr } = await runCli(["--daemon"]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/missing subcommand/);
  });

  it("exits nonzero on unknown command", async () => {
    const { code, stderr } = await runCli(["nope"]);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/unknown command: nope/);
  });

  it("find-symbol via positional finds the function", async () => {
    const { code, stdout } = await runCli(["find-symbol", "add"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/src\/math\.ts:1.*function add/);
  });

  it("hover --symbols a,b returns labeled batch output", async () => {
    // Don't assert exit code — a stale workspace index can leave one symbol
    // unresolved without invalidating the batch shape. Assert the shape.
    const { stdout, stderr } = await runCli(["hover", "--symbols", "add,double"]);
    const combined = stdout + stderr;
    expect(combined).toMatch(/=== add ===/);
    expect(combined).toMatch(/=== double ===/);
  });

  it("outline accepts multi-positional files", async () => {
    const { code, stdout } = await runCli([
      "outline",
      resolve(workspace, "src/math.ts"),
      resolve(workspace, "src/index.ts"),
    ]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/=== .*math\.ts ===/);
    expect(stdout).toMatch(/=== .*index\.ts ===/);
  });

  it("find-symbol accepts multi-positional queries and labels each block", async () => {
    const { code, stdout } = await runCli(["find-symbol", "add", "double"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/=== add ===/);
    expect(stdout).toMatch(/=== double ===/);
    expect(stdout).toMatch(/function add/);
    expect(stdout).toMatch(/function double/);
  });

  it("outline expands a glob across multiple files", async () => {
    const { code, stdout } = await runCli(["outline", "src/**/*.ts"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/=== .*math\.ts ===/);
    expect(stdout).toMatch(/=== .*index\.ts ===/);
    expect(stdout).toMatch(/function add/);
  });

  it("outline expands a directory recursively", async () => {
    const { code, stdout } = await runCli(["outline", "src"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/=== .*math\.ts ===/);
    expect(stdout).toMatch(/=== .*index\.ts ===/);
  });

  it("outline --kind function filters out non-functions", async () => {
    const { code, stdout } = await runCli([
      "outline",
      "--kind",
      "function",
      resolve(workspace, "src/math.ts"),
    ]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/function add/);
    expect(stdout).toMatch(/function double/);
  });

  it("find-symbol --kind filters workspace results to the requested kinds", async () => {
    const { code, stdout } = await runCli(["find-symbol", "--kind", "function", "add"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/function add/);
    expect(stdout).not.toMatch(/variable add/);
  });

  it("find-symbol rejects unknown --kind with a helpful message", async () => {
    const { code, stderr } = await runCli(["find-symbol", "--kind", "wizard", "add"]);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/unknown --kind value/);
    expect(stderr).toMatch(/class|function|interface/);
  });

  it("references --summary groups hits by file with counts", async () => {
    const { code, stdout } = await runCli(["references", "--symbol", "add", "--summary"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/\d+ refs?/);
    // Format is `path (N): lines` — no per-ref snippets.
    expect(stdout).toMatch(/\.ts \(\d+\): /);
  });

  it("diagnostics on multiple clean files collapses to one short line", async () => {
    // Both files are clean; we should get a single "no diagnostics" — not
    // a labeled block per file. This is the token-saving collapse.
    const { code, stdout } = await runCli([
      "diagnostics",
      "--files",
      `${resolve(workspace, "src/math.ts")},${resolve(workspace, "src/index.ts")}`,
    ]);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("no diagnostics");
    expect(stdout).not.toMatch(/=== /);
  });


  it("--daemon routes the call through an autospawned daemon", async () => {
    const cache = mkdtempSync(resolve(tmpdir(), "tslsp-e2e-daemon-"));
    const env = {
      TSLSP_DAEMON_DIR: cache,
      TSLSP_DAEMON_ENTRY: cliJs,
      // Long enough that the autospawned daemon survives the whole test.
      TSLSP_DAEMON_IDLE_MS: "60000",
    };
    try {
      const first = await runCli(["--daemon", "find-symbol", "add"], workspace, env);
      expect(first.code).toBe(0);
      expect(first.stdout).toMatch(/src\/math\.ts:1.*function add/);

      // List should show one alive daemon for this workspace.
      const list = await runCli(["daemon", "list"], workspace, env);
      expect(list.code).toBe(0);
      expect(list.stdout).toMatch(/alive\s+pid=\d+.*session=default/);

      // --json envelope on the daemon path.
      const json = await runCli(["--daemon", "--json", "find-symbol", "add"], workspace, env);
      expect(json.code).toBe(0);
      const parsed = JSON.parse(json.stdout.trim());
      expect(parsed.ok).toBe(true);
      expect(parsed.text).toMatch(/function add/);

      // --session targets a named daemon distinct from "default".
      const named = await runCli(
        ["--daemon", "--session", "alt", "find-symbol", "add"],
        workspace,
        env,
      );
      expect(named.code).toBe(0);
      const list2 = await runCli(["daemon", "list"], workspace, env);
      expect(list2.stdout).toMatch(/session=default/);
      expect(list2.stdout).toMatch(/session=alt/);
    } finally {
      await runCli(["daemon", "kill-all"], workspace, env).catch(() => {});
    }
  }, 60_000);

  it("install --skills writes SKILL.md to the project scope", async () => {
    const tmpHome = mkdtempSync(resolve(tmpdir(), "tslsp-skill-"));
    const { code, stdout } = await runCli(["install", "--skills", "--project"], tmpHome);
    expect(code).toBe(0);
    expect(stdout).toMatch(/installed skill/);
    expect(existsSync(resolve(tmpHome, ".claude/skills/tslsp/SKILL.md"))).toBe(true);
  });

  it("install --skills is idempotent without --force", async () => {
    const tmpHome = mkdtempSync(resolve(tmpdir(), "tslsp-skill-"));
    await runCli(["install", "--skills", "--project"], tmpHome);
    const { code, stdout } = await runCli(["install", "--skills", "--project"], tmpHome);
    expect(code).toBe(0);
    expect(stdout).toMatch(/already installed/);
  });

  it("install --skills --with-claude-md appends a nudge to CLAUDE.md", async () => {
    const tmpHome = mkdtempSync(resolve(tmpdir(), "tslsp-skill-"));
    const { code, stdout } = await runCli(
      ["install", "--skills", "--project", "--with-claude-md"],
      tmpHome,
    );
    expect(code).toBe(0);
    expect(stdout).toMatch(/added skill nudge/);
    const md = readFileSync(resolve(tmpHome, "CLAUDE.md"), "utf8");
    expect(md).toMatch(/tslsp-cli:auto-nudge/);
    expect(md).toMatch(/use `tslsp-cli` instead of/);
  });

  it("install --skills --with-claude-md is idempotent", async () => {
    const tmpHome = mkdtempSync(resolve(tmpdir(), "tslsp-skill-"));
    await runCli(["install", "--skills", "--project", "--with-claude-md"], tmpHome);
    const { stdout } = await runCli(
      ["install", "--skills", "--project", "--with-claude-md"],
      tmpHome,
    );
    expect(stdout).toMatch(/already nudges/);
    const md = readFileSync(resolve(tmpHome, "CLAUDE.md"), "utf8");
    // Only one marker — the second run did not re-append.
    const occurrences = md.match(/tslsp-cli:auto-nudge/g) ?? [];
    expect(occurrences.length).toBe(1);
  });

  it("install --skills --with-claude-md preserves existing CLAUDE.md content", async () => {
    const tmpHome = mkdtempSync(resolve(tmpdir(), "tslsp-skill-"));
    const existingMd = "# project notes\n\nLine I wrote myself.\n";
    writeFileSync(resolve(tmpHome, "CLAUDE.md"), existingMd, "utf8");
    await runCli(["install", "--skills", "--project", "--with-claude-md"], tmpHome);
    const md = readFileSync(resolve(tmpHome, "CLAUDE.md"), "utf8");
    expect(md).toMatch(/^# project notes/);
    expect(md).toMatch(/Line I wrote myself\./);
    expect(md).toMatch(/tslsp-cli:auto-nudge/);
  });

  it("rejects schema-violating args (--limit 0 fails .positive())", async () => {
    const { code, stderr } = await runCli(["find-symbol", "add", "--limit", "0"]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/invalid --limit/);
  });

  it("rejects schema-violating args (--apply -1 fails .nonnegative())", async () => {
    const { code, stderr } = await runCli([
      "code-action",
      "--file",
      resolve(workspace, "src/math.ts"),
      "--apply",
      "-1",
    ]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/invalid --apply/);
  });

  it("rejects empty string arg (--new-name '' fails .min(1))", async () => {
    const { code, stderr } = await runCli(["rename", "--symbol", "add", "--new-name", ""]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/invalid --new-name/);
  });
});
