import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeTsBinary, resolveTsBinary } from "../src/ts-binary.js";

const PLATFORM_SUFFIX = `${process.platform}-${process.arch}`;
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
  const platformDir = join(root, "node_modules", "@typescript", `typescript-${PLATFORM_SUFFIX}`);
  const exe = join(platformDir, "lib", `tsc${EXE}`);
  if (opts.platformExe !== false) {
    writeJson(join(platformDir, "package.json"), {
      name: `@typescript/typescript-${PLATFORM_SUFFIX}`,
      version,
    });
    mkdirSync(join(platformDir, "lib"), { recursive: true });
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
    it("falls back to the bundled native-preview", () => {
      const root = newDir();
      const bundledDir = newDir();
      const { exe } = plantNativePreview(bundledDir, "7.0.0-dev.20260506.1");
      const bin = resolveTsBinary(root, { bundledDir });
      expect(bin.source).toBe("bundled-native-preview");
      expect(bin.path).toBe(exe);
    });

    it("throws naming both ways out when the bundle is missing too", () => {
      expect(() => resolveTsBinary(newDir(), { bundledDir: newDir() })).toThrow(
        /typescript@>=7.*native-preview/s,
      );
    });
  });

  describe("given the platform package is missing", () => {
    it("falls back to the package's own bin shim", () => {
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
