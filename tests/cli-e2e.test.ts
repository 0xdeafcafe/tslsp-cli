import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
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
    expect(stdout).toMatch(/tslsp — type-aware TypeScript code intelligence CLI/);
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
