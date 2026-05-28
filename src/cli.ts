#!/usr/bin/env node
import { z } from "zod";
import { fieldDesc, isBoolean, parseArgs, typeHint } from "./cli-args.js";
import { DaemonVersionMismatch, ensureDaemon, sendRequest } from "./daemon/client.js";
import {
  killAllDaemons,
  listLiveDaemons,
  restartDaemon,
  startDaemon,
  stopDaemon,
} from "./daemon/control.js";
import { serve as serveDaemon } from "./daemon/server.js";
import { installSkills } from "./skill-install.js";
import { TOOLS, getTool, ToolDef } from "./tools.js";
import { findProjectRoot, LspPool } from "./workspace.js";

const VERBOSE = process.env.TSLSP_VERBOSE === "1" || process.env.TSLSP_MCP_VERBOSE === "1";

export async function runCli(argv: string[]): Promise<number> {
  const args = [...argv];
  if (!args.length || args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    process.stdout.write(rootHelp() + "\n");
    return 0;
  }
  if (args[0] === "--version" || args[0] === "-v") {
    process.stdout.write(`${(await readVersion()) ?? "unknown"}\n`);
    return 0;
  }

  // Global flags consumed before subcommand dispatch so tool arg parsing
  // doesn't trip on them. Keep this list aligned with the rootHelp() flag
  // documentation.
  const useDaemon = takeFlag(args, "--daemon");
  const useJson = takeFlag(args, "--json");
  const sessionName = takeValue(args, "--session") ?? "default";

  const cmd = args.shift()!;

  if (cmd === "install") {
    return runInstall(args);
  }
  if (cmd === "daemon") {
    // Pass the parsed session through so `daemon start --session foo` still
    // works (it consumes the flag itself for backwards compat, but the global
    // pass already stripped it).
    return runDaemonCmd(args, sessionName);
  }

  const tool = getTool(cmd);
  if (!tool) {
    process.stderr.write(`unknown command: ${cmd}\n\n${rootHelp()}\n`);
    return 2;
  }
  return runTool(tool, args, { useDaemon, useJson, sessionName });
}

/** Strip and report a boolean flag (e.g. `--daemon`). */
function takeFlag(argv: string[], flag: string): boolean {
  const i = argv.indexOf(flag);
  if (i < 0) return false;
  argv.splice(i, 1);
  return true;
}

/** Strip and return a `--flag VALUE` pair. Throws-friendly on missing value. */
function takeValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i < 0) return undefined;
  const value = argv[i + 1];
  argv.splice(i, value !== undefined ? 2 : 1);
  return value;
}

async function runInstall(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(installHelp() + "\n");
    return 0;
  }
  if (!argv.includes("--skills")) {
    process.stderr.write(`install requires --skills\n\n${installHelp()}\n`);
    return 2;
  }
  const scope: "user" | "project" =
    argv.includes("--project") || argv.includes("--local") ? "project" : "user";
  const force = argv.includes("--force");
  const result = await installSkills({ scope, force });
  for (const line of result.lines) process.stdout.write(line + "\n");
  return result.ok ? 0 : 1;
}

interface RunToolOpts {
  useDaemon?: boolean;
  useJson?: boolean;
  sessionName?: string;
}

async function runTool(tool: ToolDef, argv: string[], opts: RunToolOpts = {}): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(toolHelp(tool) + "\n");
    return 0;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = parseArgs(tool, argv);
  } catch (e) {
    return emitError(opts.useJson, (e as Error).message, 2, toolHelp(tool));
  }

  // Validate against the tool's zod schema so CLI users get the same
  // constraint checks as historic MCP clients did (e.g. `.min(1)`,
  // `.positive()`, `.max(200)`).
  let validated: Record<string, unknown>;
  try {
    const schema = z.object(tool.inputSchema as z.ZodRawShape);
    validated = schema.parse(parsed) as Record<string, unknown>;
  } catch (e) {
    const msg = e instanceof z.ZodError ? formatZodError(e) : (e as Error).message;
    return emitError(opts.useJson, msg, 2, toolHelp(tool));
  }

  if (opts.useDaemon) {
    return runToolViaDaemon(tool, validated, opts);
  }

  const log = VERBOSE ? (line: string) => process.stderr.write(line + "\n") : undefined;
  const pool = new LspPool(log);
  try {
    const out = await tool.handler(validated as any, { pool, cwd: process.cwd() });
    return emitResult(opts.useJson, out.text, out.isError ? 1 : 0, !!out.isError);
  } finally {
    await pool.disposeAll();
  }
}

async function runToolViaDaemon(
  tool: ToolDef,
  args: Record<string, unknown>,
  opts: RunToolOpts,
): Promise<number> {
  const workspaceDir = findProjectRoot(process.cwd());
  if (!workspaceDir) {
    return emitError(
      opts.useJson,
      `--daemon requires a tsconfig.json; none found walking up from ${process.cwd()}`,
      2,
    );
  }
  const version = (await readVersion()) ?? "0.0.0";
  const sessionName = opts.sessionName ?? "default";
  let session;
  try {
    session = await ensureDaemon({ workspaceDir, sessionName, version });
  } catch (e) {
    if (e instanceof DaemonVersionMismatch) {
      return emitError(opts.useJson, e.message, 2);
    }
    return emitError(opts.useJson, (e as Error).message, 1);
  }
  const resp = await sendRequest(session, {
    method: "run",
    params: { cmd: tool.name, args, cwd: process.cwd() },
  });
  if (resp.ok) {
    return emitResult(opts.useJson, resp.text ?? "", resp.exitCode ?? 0, false);
  }
  return emitError(opts.useJson, resp.error, resp.exitCode ?? 1);
}

/** Stdout result emitter — JSON envelope when --json is set, raw text otherwise. */
function emitResult(
  useJson: boolean | undefined,
  text: string,
  exitCode: number,
  isError: boolean,
): number {
  if (useJson) {
    process.stdout.write(JSON.stringify({ ok: !isError, text, exitCode }) + "\n");
  } else {
    const stream = isError ? process.stderr : process.stdout;
    stream.write(text + (text.endsWith("\n") ? "" : "\n"));
  }
  return exitCode;
}

/** Stderr-only error emitter; in --json mode also emits the envelope to stdout
 * so scripts that ignore stderr still get a parseable result. */
function emitError(
  useJson: boolean | undefined,
  error: string,
  exitCode: number,
  extraHelp?: string,
): number {
  if (useJson) {
    process.stdout.write(JSON.stringify({ ok: false, error, exitCode }) + "\n");
  } else {
    process.stderr.write(`tslsp: ${error}\n`);
    if (extraHelp) process.stderr.write(`\n${extraHelp}\n`);
  }
  return exitCode;
}

async function runDaemonCmd(argv: string[], sessionName: string): Promise<number> {
  const sub = argv.shift();
  if (!sub || sub === "--help" || sub === "-h") {
    process.stdout.write(daemonHelp() + "\n");
    return sub ? 0 : 2;
  }

  // Internal entrypoint used by autospawn; not for humans. `serve` reads
  // --session and --workspace from its own argv tail because it's invoked
  // directly by spawn() before the global flag parser sees anything.
  if (sub === "serve") {
    const serveSession = takeValue(argv, "--session") ?? sessionName;
    const workspaceDir = takeValue(argv, "--workspace") ?? process.cwd();
    const version = (await readVersion()) ?? "0.0.0";
    await serveDaemon({ workspaceDir, sessionName: serveSession, version });
    return 0;
  }

  if (sub === "list") {
    const daemons = await listLiveDaemons();
    if (!daemons.length) {
      process.stdout.write("no daemons\n");
      return 0;
    }
    for (const d of daemons) {
      const status = d.alive ? "alive" : "stale";
      process.stdout.write(
        `${status}  pid=${d.pid}  v${d.version}  session=${d.name}  ${d.workspaceDir}\n`,
      );
    }
    return 0;
  }

  if (sub === "kill-all") {
    const r = await killAllDaemons();
    process.stdout.write(
      `killed ${r.killed} daemon${r.killed === 1 ? "" : "s"}, cleaned ${r.cleanedSessions} session file${r.cleanedSessions === 1 ? "" : "s"}\n`,
    );
    return 0;
  }

  // start/stop/restart act on the current workspace.
  const workspaceDir = findProjectRoot(process.cwd());
  if (!workspaceDir) {
    process.stderr.write(
      `tslsp daemon ${sub}: no tsconfig.json found walking up from ${process.cwd()}\n`,
    );
    return 2;
  }
  const version = (await readVersion()) ?? "0.0.0";

  if (sub === "start") {
    const r = await startDaemon(workspaceDir, sessionName, version);
    process.stdout.write(
      `${r.spawned ? "started" : "already running"}  pid=${r.session.pid}  v${r.session.version}  session=${r.session.name}\n`,
    );
    return 0;
  }
  if (sub === "stop") {
    const r = await stopDaemon(workspaceDir, sessionName);
    process.stdout.write(r.wasRunning ? `stopped session=${sessionName}\n` : "not running\n");
    return 0;
  }
  if (sub === "restart") {
    const r = await restartDaemon(workspaceDir, sessionName, version);
    process.stdout.write(
      `${r.stopped ? "restarted" : "started"}  pid=${r.session.pid}  v${r.session.version}  session=${r.session.name}\n`,
    );
    return 0;
  }

  process.stderr.write(`unknown daemon subcommand: ${sub}\n\n${daemonHelp()}\n`);
  return 2;
}

function daemonHelp(): string {
  return [
    "tslsp daemon <subcommand> [flags]",
    "",
    "Manage the per-workspace daemon that holds a warm tsgo so subsequent",
    "tool calls (with `--daemon`) skip per-invocation LSP startup.",
    "",
    "subcommands:",
    "  start              spawn the daemon for the current workspace",
    "  stop               graceful stop for this workspace",
    "  restart            stop + start (use after upgrading)",
    "  list               every daemon across all workspaces",
    "  kill-all           SIGKILL every daemon (escape hatch)",
    "",
    "flags:",
    '  --session NAME     named session (default: "default")',
  ].join("\n");
}

function formatZodError(e: z.ZodError): string {
  return e.issues
    .map((iss) => {
      const path = iss.path.length ? iss.path.join(".") : "<arg>";
      return `invalid --${String(path).replace(/_/g, "-")}: ${iss.message}`;
    })
    .join("\n");
}

// --- help ---

export function rootHelp(): string {
  const lines = [
    "tslsp — type-aware TypeScript code intelligence CLI",
    "",
    "usage:",
    "  tslsp <command> [args]",
    "  tslsp --daemon <command> [args] route through a warm per-workspace daemon",
    "  tslsp --json <command> [args]   emit a JSON envelope on stdout",
    '  tslsp --session NAME <command>  pick a named daemon session (default: "default")',
    "  tslsp daemon <start|stop|restart|list|kill-all>",
    "  tslsp install --skills [--project] [--force]",
    "  tslsp <command> --help          per-command help",
    "",
    "commands:",
  ];
  const width = Math.max(...TOOLS.map((t) => t.name.length));
  for (const t of TOOLS) {
    lines.push(`  ${t.name.padEnd(width)}  ${t.description}`);
  }
  lines.push("");
  lines.push("global flags:");
  lines.push("  --help, -h     show this message");
  lines.push("  --version, -v  print version");
  lines.push("");
  lines.push("env:");
  lines.push("  TSLSP_VERBOSE=1            forward tsgo stderr to stderr");
  lines.push("  TSLSP_DAEMON_DIR=PATH      override per-platform daemon cache dir");
  lines.push("  TSLSP_DAEMON_IDLE_MS=N     daemon self-exit after N ms idle (default 30m)");
  lines.push("  TSLSP_TSGO_IDLE_MS=N       reap idle tsgos inside a pool (default 10m, 0 off)");
  lines.push("  TSLSP_DAEMON_ENTRY=PATH    override the bin daemons re-exec (testing)");
  return lines.join("\n");
}

export function toolHelp(tool: ToolDef): string {
  const shape = tool.inputSchema as Record<string, z.ZodTypeAny>;
  const positional = (tool.positional ?? []) as string[];
  const flags = Object.keys(shape).filter((k) => !positional.includes(k));
  const lines: string[] = [];
  const posStr = positional.map((p) => `<${p.replace(/_/g, "-")}>`).join(" ");
  lines.push(`tslsp ${tool.name.replace(/_/g, "-")} ${posStr} [flags]`);
  lines.push("");
  lines.push(tool.description);
  if (positional.length) {
    lines.push("");
    lines.push("arguments:");
    for (const k of positional)
      lines.push(`  ${k.replace(/_/g, "-").padEnd(18)}  ${fieldDesc(shape[k]!)}`);
  }
  if (flags.length) {
    lines.push("");
    lines.push("flags:");
    for (const k of flags) {
      const ty = shape[k]!;
      const hint = isBoolean(ty) ? "" : ` <${typeHint(ty)}>`;
      lines.push(
        `  --${k.replace(/_/g, "-")}${hint.padEnd(Math.max(0, 18 - k.length - hint.length))}  ${fieldDesc(ty)}`,
      );
    }
  }
  return lines.join("\n");
}

function installHelp(): string {
  return [
    "tslsp install --skills [--project] [--force]",
    "",
    "Install the tslsp skill so Claude Code (and other skill-aware agents) can",
    "discover it and route TypeScript navigation/refactor work through this CLI.",
    "",
    "flags:",
    "  --skills    required. install the bundled SKILL.md.",
    "  --project   install into ./.claude/skills (default: ~/.claude/skills).",
    "  --local     alias for --project.",
    "  --force     overwrite an existing skill at the target.",
  ].join("\n");
}

async function readVersion(): Promise<string | undefined> {
  try {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { join } = await import("node:path");
    // import.meta.url points at dist/cli.js; package.json is one directory up.
    const here = fileURLToPath(new URL(".", import.meta.url));
    const pkg = JSON.parse(await readFile(join(here, "..", "package.json"), "utf8"));
    return pkg.version;
  } catch {
    return undefined;
  }
}

// Only run when invoked as a binary, not when imported by tests.
const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  const arg1 = process.argv[1];
  return arg1.endsWith("/cli.js") || arg1.endsWith("\\cli.js") || arg1.endsWith("/tslsp");
})();

if (invokedDirectly) {
  runCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(`tslsp fatal: ${e?.stack ?? e}\n`);
      process.exit(1);
    });
}
