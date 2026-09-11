import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * Where the TypeScript binary we speak LSP to came from, in preference order.
 * The served workspace always wins: an LSP answering from a different compiler
 * than the project's own `tsc` disagrees with it on real code.
 */
export type TsBinarySource =
  | "workspace-typescript"
  | "workspace-native-preview"
  | "bundled-typescript";

export interface ResolvedTsBinary {
  /** Executable to spawn with `--lsp --stdio`. */
  path: string;
  source: TsBinarySource;
  /** Version of the package the binary belongs to, e.g. `7.0.2`. */
  version: string;
  /** Package name the binary came from. */
  packageName: string;
  /** Directory of that package. */
  packageDir: string;
}

export interface ResolveTsBinaryOptions {
  /**
   * Directory whose `node_modules` holds the bundled fallback. Defaults to
   * resolving `typescript` the way Node does from tslsp-cli's own install.
   */
  bundledDir?: string;
}

const SOURCE_LABELS: Record<TsBinarySource, string> = {
  "workspace-typescript": "workspace typescript",
  "workspace-native-preview": "workspace @typescript/native-preview",
  "bundled-typescript": "bundled typescript",
};

/** One line for the log, naming what we picked and where it came from. */
export function describeTsBinary(bin: ResolvedTsBinary): string {
  return `tslsp-cli: using ${bin.packageName} ${bin.version} (${SOURCE_LABELS[bin.source]}) at ${bin.path}`;
}

/**
 * Find the TypeScript native binary to run as an LSP server, resolved from the
 * workspace being served rather than from tslsp-cli's own bundle.
 *
 * Order:
 *   1. the workspace's own `typescript` (7.x ships the native binary as `tsc`)
 *   2. the workspace's `@typescript/native-preview` (`tsgo`), for a project
 *      still on the pre-7.0 dev channel
 *   3. tslsp-cli's own `typescript`
 *
 * Nearest node_modules wins, walking up from the project root — so a package in
 * a monorepo gets its own pinned compiler if it has one and the root's if not.
 * `typescript` below 7 is skipped: it is the JavaScript compiler and has no LSP.
 *
 * PATH is never consulted. A homebrew `tsgo` there can shadow the project's
 * compiler with subtly different LSP behavior.
 */
export function resolveTsBinary(
  rootPath: string,
  opts: ResolveTsBinaryOptions = {},
): ResolvedTsBinary {
  for (const dir of walkUp(rootPath)) {
    const modules = join(dir, "node_modules");
    const typescript = fromPackage(join(modules, "typescript"), "workspace-typescript");
    if (typescript) return typescript;
    const preview = fromPackage(
      join(modules, "@typescript", "native-preview"),
      "workspace-native-preview",
    );
    if (preview) return preview;
  }

  const bundled = bundledTypescript(opts);
  if (bundled) return bundled;

  throw new Error(
    "Could not find a TypeScript native binary. Install typescript@>=7 in the " +
      "workspace, or reinstall tslsp-cli so its own copy is present.",
  );
}

/**
 * tslsp-cli's own `typescript`, the fallback for a workspace with none of its
 * own — a folder outside any project, or one still on TypeScript 6.
 *
 * Resolved through Node rather than a fixed `<package>/node_modules/typescript`
 * path: a global `npm install -g` hoists dependencies above the package
 * directory, where that path does not exist.
 */
function bundledTypescript(opts: ResolveTsBinaryOptions): ResolvedTsBinary | undefined {
  if (opts.bundledDir !== undefined) {
    return fromPackage(join(opts.bundledDir, "node_modules", "typescript"), "bundled-typescript");
  }
  try {
    const require = createRequire(import.meta.url);
    return fromPackage(dirname(require.resolve("typescript/package.json")), "bundled-typescript");
  } catch {
    return undefined;
  }
}

function* walkUp(start: string): Generator<string> {
  let dir = start;
  for (;;) {
    yield dir;
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

interface PackageManifest {
  name?: string;
  version?: string;
  bin?: Record<string, string> | string;
}

function fromPackage(packageDir: string, source: TsBinarySource): ResolvedTsBinary | undefined {
  const manifestPath = join(packageDir, "package.json");
  if (!existsSync(manifestPath)) return undefined;
  let manifest: PackageManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PackageManifest;
  } catch {
    return undefined;
  }
  const name = manifest.name;
  const version = manifest.version;
  if (!name || !version) return undefined;
  // TypeScript 6 and below is the JavaScript compiler — no native binary, no LSP.
  if (name === "typescript" && majorOf(version) < 7) return undefined;

  const path = nativeExe(packageDir, name) ?? binShim(packageDir, name, manifest.bin);
  if (!path) return undefined;
  return { path, source, version, packageName: name, packageDir };
}

function majorOf(version: string): number {
  const n = parseInt(version.split(".")[0] ?? "", 10);
  return Number.isFinite(n) ? n : 0;
}

/** `typescript` → `tsc`, `@typescript/native-preview` → `tsgo`. */
function binNameFor(packageName: string): string {
  const base = packageName.startsWith("@") ? (packageName.split("/")[1] ?? "") : packageName;
  return base === "typescript" ? "tsc" : "tsgo";
}

/**
 * Locate the platform binary the way the package's own `bin` shim does: a
 * sibling `@typescript/<base>-<platform>-<arch>` package holding `lib/<bin>`.
 * Resolving it directly skips a Node process per LSP spawn.
 *
 * Resolution runs from the package's realpath — under pnpm the platform package
 * is a sibling inside the store, unreachable from the symlink in the
 * workspace's node_modules.
 */
function nativeExe(packageDir: string, packageName: string): string | undefined {
  const base = packageName.startsWith("@") ? (packageName.split("/")[1] ?? "") : packageName;
  const platformPackage = `@typescript/${base}-${process.platform}-${process.arch}`;
  let realDir: string;
  try {
    realDir = realpathSync(packageDir);
  } catch {
    return undefined;
  }
  let manifest: string;
  try {
    const require = createRequire(join(realDir, "package.json"));
    manifest = require.resolve(`${platformPackage}/package.json`);
  } catch {
    return undefined;
  }
  let exe = join(dirname(manifest), "lib", binNameFor(packageName));
  if (process.platform === "win32") exe += ".exe";
  return existsSync(exe) ? exe : undefined;
}

/** Last resort within a package: its declared bin entry (a Node shim). */
function binShim(
  packageDir: string,
  packageName: string,
  bin: PackageManifest["bin"],
): string | undefined {
  const wanted = binNameFor(packageName);
  const relative = typeof bin === "string" ? bin : bin?.[wanted];
  if (!relative) return undefined;
  const path = join(packageDir, relative);
  return existsSync(path) ? path : undefined;
}
