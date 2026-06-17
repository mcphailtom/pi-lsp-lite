import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { which, findWorkspaceRoot, fileUri } from "../src/util.js";
import { fileURLToPath } from "node:url";

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = join(tmpdir(), `pi-lsp-util-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tempDirs = [];
});

describe("fileUri", () => {
  it("converts an absolute path to a file URL", () => {
    const uri = fileUri("/tmp/foo/bar.ts");
    assert.equal(uri, "file:///tmp/foo/bar.ts");
  });
});

describe("fileUri (Windows)", { skip: process.platform !== "win32" }, () => {
  it("encodes a drive-letter path as a file URL", () => {
    assert.equal(fileUri("C:\\project\\src\\main.ts"), "file:///C:/project/src/main.ts");
  });

  it("round-trips a path containing spaces via fileURLToPath", () => {
    const p = "C:\\My Project\\a b.ts";
    assert.equal(fileURLToPath(fileUri(p)), p);
  });
});

describe("which", () => {
  it("resolves a bare command name that exists on PATH", async () => {
    const result = await which("node");
    assert.ok(result !== null, "expected to find node on PATH");
    // On Windows PATHEXT resolution yields e.g. node.exe; basename starts with "node".
    const base = result!.split(/[/\\]/).pop()!.toLowerCase();
    assert.ok(base.startsWith("node"), `unexpected path: ${result}`);
  });

  it("returns null for a bare command name that does not exist", async () => {
    const result = await which("definitely-not-a-real-binary-xyz-9999");
    assert.equal(result, null);
  });

  it("returns the path when given an absolute path to an executable", async () => {
    // process.execPath is always an executable node binary
    const result = await which(process.execPath);
    assert.equal(result, process.execPath);
  });

  it("returns null when given an absolute path that does not exist", async () => {
    const result = await which("/absolutely/does/not/exist/binary");
    assert.equal(result, null);
  });

  it("returns null when given an absolute path to a non-executable file", { skip: process.platform === "win32" }, async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, "notexec");
    await writeFile(filePath, "#!/bin/sh\necho hi");
    await chmod(filePath, 0o644); // readable but not executable
    const result = await which(filePath);
    assert.equal(result, null);
  });
});

describe("which (Windows)", { skip: process.platform !== "win32" }, () => {
  const origPath = process.env.PATH;
  const origPathExt = process.env.PATHEXT;

  afterEach(() => {
    process.env.PATH = origPath;
    process.env.PATHEXT = origPathExt;
  });

  it("resolves a bare command name to its .cmd shim via PATHEXT", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "foo.cmd"), "@echo off\r\n");
    process.env.PATH = dir;
    process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
    const result = await which("foo");
    assert.ok(result !== null, "expected to resolve foo via PATHEXT");
    assert.ok(result!.toLowerCase().endsWith("foo.cmd"), `unexpected path: ${result}`);
  });
});

describe("findWorkspaceRoot", () => {
  it("returns the directory that directly contains the root pattern", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "go.mod"), "module example.com/test");
    const filePath = join(dir, "main.go");

    const root = await findWorkspaceRoot(filePath, ["go.mod"], dir);
    assert.equal(root, dir);
  });

  it("walks up to find the pattern in an ancestor directory", async () => {
    const dir = await makeTempDir();
    const sub = join(dir, "pkg", "internal");
    await mkdir(sub, { recursive: true });
    await writeFile(join(dir, "go.mod"), "module example.com/test");
    const filePath = join(sub, "foo.go");

    const root = await findWorkspaceRoot(filePath, ["go.mod"], dir);
    assert.equal(root, dir);
  });

  it("stops at the first ancestor that matches, not the highest", async () => {
    // Inner go.mod wins over outer go.mod
    const dir = await makeTempDir();
    const inner = join(dir, "inner");
    await mkdir(inner, { recursive: true });
    await writeFile(join(dir, "go.mod"), "module outer");
    await writeFile(join(inner, "go.mod"), "module inner");
    const filePath = join(inner, "main.go");

    const root = await findWorkspaceRoot(filePath, ["go.mod"], dir);
    assert.equal(root, inner);
  });

  it("returns cwd when no pattern is found anywhere", async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, "main.go");

    const root = await findWorkspaceRoot(filePath, ["go.mod"], dir);
    assert.equal(root, dir);
  });

  it("returns cwd when rootPatterns is empty", async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, "main.go");

    const root = await findWorkspaceRoot(filePath, [], dir);
    assert.equal(root, dir);
  });

  it("does not walk above cwd boundary", async () => {
    const outer = await makeTempDir();
    const inner = join(outer, "project");
    await mkdir(inner, { recursive: true });
    await writeFile(join(outer, "go.mod"), "module outer");
    const filePath = join(inner, "main.go");

    const root = await findWorkspaceRoot(filePath, ["go.mod"], inner);
    assert.equal(root, inner);
  });

  it("matches the first pattern in the list that exists", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "Cargo.toml"), "[package]");
    const filePath = join(dir, "src", "main.rs");
    await mkdir(join(dir, "src"), { recursive: true });

    // go.mod is not present; Cargo.toml is
    const root = await findWorkspaceRoot(filePath, ["go.mod", "Cargo.toml"], dir);
    assert.equal(root, dir);
  });
});
