import { describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeTsBinary, resolveTsBinary } from "../src/ts-binary.js";

const PLATFORM_SUFFIX = `${process.platform}-${process.arch}`;

function majorOf(version: string): number {
  return parseInt(version.split(".")[0] ?? "", 10);
}

const EXE = process.platform === "win32" ? ".exe" : "";

// realpath: macOS tmpdir is a symlink, and require.resolve reports real paths.
function newDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "tslsp-bin-")));
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value), "utf8");
}

/** Plant a `typescript`-shaped package: manifest, bin shim, platform exe. */
function plantTypescript(
  root: string,
  version: string,
  opts: { platformExe?: boolean; shim?: boolean } = {},
): { packageDir: string; exe: string; shim: string } {
  const packageDir = join(root, "node_modules", "typescript");
  writeJson(join(packageDir, "package.json"), {
    name: "typescript",
    version,
    bin: { tsc: "./bin/tsc" },
  });
  const shim = join(packageDir, "bin", "tsc");
  if (opts.shim !== false) {
    mkdirSync(join(packageDir, "bin"), { recursive: true });
    writeFileSync(shim, "#!/usr/bin/env node\n", "utf8");
    chmodSync(shim, 0o755);
  }
  // The platform package is always planted, even when the binary inside it is
  // not: under vitest, `require.resolve` from a temp dir walks all the way out
  // to this repo's own node_modules, so an absent fixture package resolves to
  // the real one. A planted-but-empty package keeps the lookup inside the
  // fixture and the missing-binary branch honest.
  const platformDir = join(root, "node_modules", "@typescript", `typescript-${PLATFORM_SUFFIX}`);
  const exe = join(platformDir, "lib", `tsc${EXE}`);
  writeJson(join(platformDir, "package.json"), {
    name: `@typescript/typescript-${PLATFORM_SUFFIX}`,
    version,
  });
  mkdirSync(join(platformDir, "lib"), { recursive: true });
  if (opts.platformExe !== false) {
    writeFileSync(exe, "", "utf8");
    chmodSync(exe, 0o755);
  }
  return { packageDir, exe, shim };
}

/** Plant an `@typescript/native-preview`-shaped package. */
function plantNativePreview(root: string, version: string): { exe: string } {
  const packageDir = join(root, "node_modules", "@typescript", "native-preview");
  writeJson(join(packageDir, "package.json"), {
    name: "@typescript/native-preview",
    version,
    bin: { tsgo: "./bin/tsgo.js" },
  });
  mkdirSync(join(packageDir, "bin"), { recursive: true });
  writeFileSync(join(packageDir, "bin", "tsgo.js"), "#!/usr/bin/env node\n", "utf8");
  const platformDir = join(
    root,
    "node_modules",
    "@typescript",
    `native-preview-${PLATFORM_SUFFIX}`,
  );
  writeJson(join(platformDir, "package.json"), {
    name: `@typescript/native-preview-${PLATFORM_SUFFIX}`,
    version,
  });
  mkdirSync(join(platformDir, "lib"), { recursive: true });
  const exe = join(platformDir, "lib", `tsgo${EXE}`);
  writeFileSync(exe, "", "utf8");
  chmodSync(exe, 0o755);
  return { exe };
}

describe("resolveTsBinary", () => {
  describe("given the workspace has both typescript 7 and native-preview", () => {
    it("picks the workspace typescript native binary", () => {
      const root = newDir();
      const { exe } = plantTypescript(root, "7.0.2");
      plantNativePreview(root, "7.0.0-dev.20260506.1");
      const bin = resolveTsBinary(root, { bundledDir: newDir() });
      expect(bin.source).toBe("workspace-typescript");
      expect(bin.version).toBe("7.0.2");
      expect(bin.path).toBe(exe);
    });
  });

  describe("given the workspace has only native-preview", () => {
    it("falls through to it", () => {
      const root = newDir();
      const { exe } = plantNativePreview(root, "7.0.0-dev.20260506.1");
      const bin = resolveTsBinary(root, { bundledDir: newDir() });
      expect(bin.source).toBe("workspace-native-preview");
      expect(bin.packageName).toBe("@typescript/native-preview");
      expect(bin.path).toBe(exe);
    });
  });

  describe("given the workspace typescript is version 6", () => {
    it("skips it — TypeScript 6 has no native binary", () => {
      const root = newDir();
      plantTypescript(root, "6.0.3");
      const { exe } = plantNativePreview(root, "7.0.0-dev.20260506.1");
      const bin = resolveTsBinary(root, { bundledDir: newDir() });
      expect(bin.source).toBe("workspace-native-preview");
      expect(bin.path).toBe(exe);
    });
  });

  describe("given a package inside a monorepo", () => {
    it("prefers the nearest node_modules", () => {
      const monorepo = newDir();
      plantTypescript(monorepo, "7.0.1");
      const pkg = join(monorepo, "packages", "inner");
      mkdirSync(pkg, { recursive: true });
      const { exe } = plantTypescript(pkg, "7.0.9");
      const bin = resolveTsBinary(pkg, { bundledDir: newDir() });
      expect(bin.version).toBe("7.0.9");
      expect(bin.path).toBe(exe);
    });

    it("walks up to the monorepo root when the package has none", () => {
      const monorepo = newDir();
      const { exe } = plantTypescript(monorepo, "7.0.1");
      const pkg = join(monorepo, "packages", "inner");
      mkdirSync(pkg, { recursive: true });
      const bin = resolveTsBinary(pkg, { bundledDir: newDir() });
      expect(bin.version).toBe("7.0.1");
      expect(bin.path).toBe(exe);
    });
  });

  describe("given the workspace has no TypeScript at all", () => {
    it("falls back to the bundled typescript", () => {
      const root = newDir();
      const bundledDir = newDir();
      const { exe } = plantTypescript(bundledDir, "7.0.2");
      const bin = resolveTsBinary(root, { bundledDir });
      expect(bin.source).toBe("bundled-typescript");
      expect(bin.packageName).toBe("typescript");
      expect(bin.path).toBe(exe);
    });

    it("resolves tslsp-cli's own typescript when no bundle dir is given", () => {
      // No bundledDir: the real fallback path, through Node's resolution from
      // this module. Proves the shipped dependency is reachable and executable.
      const bin = resolveTsBinary(newDir());
      expect(bin.source).toBe("bundled-typescript");
      expect(bin.packageName).toBe("typescript");
      expect(majorOf(bin.version)).toBeGreaterThanOrEqual(7);
      expect(existsSync(bin.path)).toBe(true);
    });

    it("throws naming the way out when the bundle is missing too", () => {
      expect(() => resolveTsBinary(newDir(), { bundledDir: newDir() })).toThrow(/typescript@>=7/s);
    });
  });

  describe("given the platform package is missing", () => {
    it("falls back to the package's own bin shim when the binary is absent", () => {
      const root = newDir();
      const { shim } = plantTypescript(root, "7.0.2", { platformExe: false });
      const bin = resolveTsBinary(root, { bundledDir: newDir() });
      expect(bin.path).toBe(shim);
    });

    it("skips the package entirely when it has no usable bin either", () => {
      const root = newDir();
      plantTypescript(root, "7.0.2", { platformExe: false, shim: false });
      const { exe } = plantNativePreview(root, "7.0.0-dev.20260506.1");
      const bin = resolveTsBinary(root, { bundledDir: newDir() });
      expect(bin.path).toBe(exe);
    });
  });
});

describe("describeTsBinary", () => {
  it("names the package, version, source and path", () => {
    const line = describeTsBinary({
      path: "/w/node_modules/@typescript/typescript-x/lib/tsc",
      source: "workspace-typescript",
      version: "7.0.2",
      packageName: "typescript",
      packageDir: "/w/node_modules/typescript",
    });
    expect(line).toBe(
      "tslsp-cli: using typescript 7.0.2 (workspace typescript) at /w/node_modules/@typescript/typescript-x/lib/tsc",
    );
  });
});
