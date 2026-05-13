import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServerManager } from "../src/server-manager.js";
import type { LanguageServerConfig } from "../src/languages.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fakeServerPath = join(__dirname, "fake-server.ts");

const projectRoot = join(__dirname, "..");
const tsxPath = join(projectRoot, "node_modules", ".bin", "tsx");

const fakeConfig: LanguageServerConfig = {
  id: "fake",
  extensions: [".go"],
  command: tsxPath,
  args: [fakeServerPath, "--run"],
  rootPatterns: ["go.mod"],
};

const missingConfig: LanguageServerConfig = {
  id: "missing",
  extensions: [".xyz"],
  command: "nonexistent-lsp-server-binary-42",
  args: [],
  rootPatterns: [],
};

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = join(tmpdir(), `pi-lsp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

describe("ServerManager", () => {
  it("first edit spawns server, second reuses it", async () => {
    const manager = createServerManager();
    const dir = await makeTempDir();
    await writeFile(join(dir, "go.mod"), "module test");
    const filePath = join(dir, "main.go");
    await writeFile(filePath, "package main");

    const result1 = await manager.handleEdit(filePath, fakeConfig, dir);
    assert.equal(result1.status, "ok");

    const status1 = manager.status();
    assert.equal(status1.length, 1);

    await writeFile(filePath, "package main\n");
    const result2 = await manager.handleEdit(filePath, fakeConfig, dir);
    assert.equal(result2.status, "ok");

    const status2 = manager.status();
    assert.equal(status2.length, 1);
    assert.equal(status2[0].pid, status1[0].pid);

    await manager.shutdownAll();
  });

  it("concurrent first edits don't spawn duplicate servers", async () => {
    const manager = createServerManager();
    const dir = await makeTempDir();
    await writeFile(join(dir, "go.mod"), "module test");
    const file1 = join(dir, "a.go");
    const file2 = join(dir, "b.go");
    await writeFile(file1, "package main");
    await writeFile(file2, "package main");

    const [r1, r2] = await Promise.all([
      manager.handleEdit(file1, fakeConfig, dir),
      manager.handleEdit(file2, fakeConfig, dir),
    ]);

    assert.equal(r1.status, "ok");
    assert.equal(r2.status, "ok");

    const status = manager.status();
    assert.equal(status.length, 1);

    await manager.shutdownAll();
  });

  it("missing binary disables language permanently", async () => {
    const manager = createServerManager();
    const dir = await makeTempDir();
    const filePath = join(dir, "main.xyz");
    await writeFile(filePath, "content");

    const result1 = await manager.handleEdit(filePath, missingConfig, dir);
    assert.equal(result1.status, "unavailable");
    assert.equal(result1.diagnostics.length, 0);

    const result2 = await manager.handleEdit(filePath, missingConfig, dir);
    assert.equal(result2.status, "unavailable");
    assert.equal(result2.diagnostics.length, 0);

    assert.equal(manager.status().length, 0);

    await manager.shutdownAll();
  });

  it("different workspace roots get different servers", async () => {
    const manager = createServerManager();
    const dir = await makeTempDir();

    const mod1 = join(dir, "mod1");
    const mod2 = join(dir, "mod2");
    await mkdir(mod1, { recursive: true });
    await mkdir(mod2, { recursive: true });

    await writeFile(join(mod1, "go.mod"), "module mod1");
    await writeFile(join(mod2, "go.mod"), "module mod2");

    const file1 = join(mod1, "main.go");
    const file2 = join(mod2, "main.go");
    await writeFile(file1, "package main");
    await writeFile(file2, "package main");

    await manager.handleEdit(file1, fakeConfig, dir);
    await manager.handleEdit(file2, fakeConfig, dir);

    const status = manager.status();
    assert.equal(status.length, 2);

    await manager.shutdownAll();
  });

  it("init failure in one root does not prevent another root from starting", async () => {
    const crashConfig: LanguageServerConfig = {
      id: "fake-crash",
      extensions: [".go"],
      command: tsxPath,
      args: [fakeServerPath, "--run", '--options={"crashOnInit":true}'],
      rootPatterns: ["go.mod"],
    };
    const manager = createServerManager();
    const dir = await makeTempDir();

    const rootA = join(dir, "root-a");
    const rootB = join(dir, "root-b");
    await mkdir(rootA, { recursive: true });
    await mkdir(rootB, { recursive: true });
    await writeFile(join(rootA, "go.mod"), "module a");
    await writeFile(join(rootB, "go.mod"), "module b");

    const fileA = join(rootA, "main.go");
    const fileB = join(rootB, "main.go");
    await writeFile(fileA, "package main");
    await writeFile(fileB, "package main");

    // root A crashes on init
    const resultA = await manager.handleEdit(fileA, crashConfig, dir);
    assert.equal(resultA.status, "unavailable");
    assert.equal(resultA.diagnostics.length, 0);

    // root B should still work with a working config
    const resultB = await manager.handleEdit(fileB, fakeConfig, dir);
    assert.equal(resultB.status, "ok");
    assert.ok(resultB.diagnostics.length > 0, "root B should produce diagnostics");

    await manager.shutdownAll();
  });

  it("shutdownAll kills all servers", async () => {
    const manager = createServerManager();
    const dir = await makeTempDir();
    await writeFile(join(dir, "go.mod"), "module test");
    const filePath = join(dir, "main.go");
    await writeFile(filePath, "package main");

    await manager.handleEdit(filePath, fakeConfig, dir);
    assert.equal(manager.status().length, 1);

    await manager.shutdownAll();
    assert.equal(manager.status().length, 0);
  });

  it("shutdownAll completes when server never responds to shutdown", async () => {
    const neverShutdownConfig: LanguageServerConfig = {
      id: "fake-hang",
      extensions: [".go"],
      command: tsxPath,
      args: [fakeServerPath, "--run", '--options={"neverShutdown":true}'],
      rootPatterns: ["go.mod"],
    };
    const manager = createServerManager();
    const dir = await makeTempDir();
    await writeFile(join(dir, "go.mod"), "module test");
    const filePath = join(dir, "main.go");
    await writeFile(filePath, "package main");

    await manager.handleEdit(filePath, neverShutdownConfig, dir);
    assert.equal(manager.status().length, 1);

    const start = Date.now();
    await manager.shutdownAll();
    const elapsed = Date.now() - start;

    assert.equal(manager.status().length, 0);
    assert.ok(elapsed < 15_000, `shutdownAll took ${elapsed}ms, expected < 15s`);
  });
});

describe("ServerManagerOptions", () => {
  it("diagnosticTimeout: short timeout causes timeout result when server is slow", async () => {
    const slowConfig: LanguageServerConfig = {
      id: "fake-slow",
      extensions: [".go"],
      command: tsxPath,
      args: [fakeServerPath, "--run", '--options={"diagnosticDelay":2000}'],
      rootPatterns: ["go.mod"],
    };
    const manager = createServerManager({ diagnosticTimeout: 200, maxRetries: 0 });
    const dir = await makeTempDir();
    await writeFile(join(dir, "go.mod"), "module test");
    const filePath = join(dir, "main.go");
    await writeFile(filePath, "package main");

    const result = await manager.handleEdit(filePath, slowConfig, dir);
    assert.equal(result.status, "timeout");

    await manager.shutdownAll();
  });

  it("perServerTimeout overrides global diagnosticTimeout for the named server", async () => {
    const slowConfig: LanguageServerConfig = {
      id: "fake-slow2",
      extensions: [".go"],
      command: tsxPath,
      args: [fakeServerPath, "--run", '--options={"diagnosticDelay":2000}'],
      rootPatterns: ["go.mod"],
    };
    // global timeout is generous, but per-server timeout for fake-slow2 is very short
    const manager = createServerManager({
      diagnosticTimeout: 10_000,
      perServerTimeout: new Map([["fake-slow2", 200]]),
      maxRetries: 0,
    });
    const dir = await makeTempDir();
    await writeFile(join(dir, "go.mod"), "module test");
    const filePath = join(dir, "main.go");
    await writeFile(filePath, "package main");

    const result = await manager.handleEdit(filePath, slowConfig, dir);
    assert.equal(result.status, "timeout");

    await manager.shutdownAll();
  });

  it("perServerTimeout does not affect other servers", async () => {
    // fake server (id=fake) responds promptly; perServerTimeout only targets another id
    const manager = createServerManager({
      diagnosticTimeout: 5_000,
      perServerTimeout: new Map([["unrelated", 1]]),
    });
    const dir = await makeTempDir();
    await writeFile(join(dir, "go.mod"), "module test");
    const filePath = join(dir, "main.go");
    await writeFile(filePath, "package main");

    const result = await manager.handleEdit(filePath, fakeConfig, dir);
    assert.equal(result.status, "ok");

    await manager.shutdownAll();
  });
});

describe("Retry logic", () => {
  it("no retry when server publishes diagnostics on first attempt", async () => {
    const manager = createServerManager({ diagnosticTimeout: 2_000 });
    const dir = await makeTempDir();
    await writeFile(join(dir, "go.mod"), "module test");
    const filePath = join(dir, "main.go");
    await writeFile(filePath, "package main");

    const result = await manager.handleEdit(filePath, fakeConfig, dir);
    assert.equal(result.status, "ok");
    assert.equal(result.retryAttempts, 0);
    assert.ok(result.diagnostics.length > 0);

    await manager.shutdownAll();
  });

  it("retries and succeeds when server publishes on 3rd attempt", async () => {
    const publish3rdConfig: LanguageServerConfig = {
      id: "fake-publish3rd",
      extensions: [".go"],
      command: tsxPath,
      args: [fakeServerPath, "--run", '--options={"publishOnAttempt":3}'],
      rootPatterns: ["go.mod"],
    };
    const manager = createServerManager({ diagnosticTimeout: 500 });
    const dir = await makeTempDir();
    await writeFile(join(dir, "go.mod"), "module test");
    const filePath = join(dir, "main.go");
    await writeFile(filePath, "package main");

    const result = await manager.handleEdit(filePath, publish3rdConfig, dir);
    assert.equal(result.status, "ok");
    assert.equal(result.retryAttempts, 2);
    assert.ok(result.diagnostics.length > 0);

    await manager.shutdownAll();
  });

  it("exhausts maxRetries and returns timeout when server never publishes", async () => {
    const neverPublishConfig: LanguageServerConfig = {
      id: "fake-nopub",
      extensions: [".go"],
      command: tsxPath,
      args: [fakeServerPath, "--run", '--options={"neverPublish":true}'],
      rootPatterns: ["go.mod"],
    };
    const manager = createServerManager({ diagnosticTimeout: 200, maxRetries: 3 });
    const dir = await makeTempDir();
    await writeFile(join(dir, "go.mod"), "module test");
    const filePath = join(dir, "main.go");
    await writeFile(filePath, "package main");

    const result = await manager.handleEdit(filePath, neverPublishConfig, dir);
    assert.equal(result.status, "timeout");
    assert.equal(result.retryAttempts, 3);

    await manager.shutdownAll();
  });

  it("per-server maxRetries on LanguageServerConfig overrides manager default", async () => {
    const publish2ndConfig: LanguageServerConfig = {
      id: "fake-publish2nd",
      extensions: [".go"],
      command: tsxPath,
      args: [fakeServerPath, "--run", '--options={"publishOnAttempt":2}'],
      rootPatterns: ["go.mod"],
      maxRetries: 1,
    };
    // manager default is 0 — without the per-server override it would not retry
    const manager = createServerManager({ diagnosticTimeout: 300, maxRetries: 0 });
    const dir = await makeTempDir();
    await writeFile(join(dir, "go.mod"), "module test");
    const filePath = join(dir, "main.go");
    await writeFile(filePath, "package main");

    const result = await manager.handleEdit(filePath, publish2ndConfig, dir);
    assert.equal(result.status, "ok");
    assert.equal(result.retryAttempts, 1);
    assert.ok(result.diagnostics.length > 0);

    await manager.shutdownAll();
  });

  it("maxRetries: 0 means single attempt only", async () => {
    const neverPublishConfig: LanguageServerConfig = {
      id: "fake-nopub2",
      extensions: [".go"],
      command: tsxPath,
      args: [fakeServerPath, "--run", '--options={"neverPublish":true}'],
      rootPatterns: ["go.mod"],
    };
    const manager = createServerManager({ diagnosticTimeout: 200, maxRetries: 0 });
    const dir = await makeTempDir();
    await writeFile(join(dir, "go.mod"), "module test");
    const filePath = join(dir, "main.go");
    await writeFile(filePath, "package main");

    const start = Date.now();
    const result = await manager.handleEdit(filePath, neverPublishConfig, dir);
    const elapsed = Date.now() - start;

    assert.equal(result.status, "timeout");
    assert.equal(result.retryAttempts, 0);
    assert.ok(elapsed < 2_000, `should not have retried, took ${elapsed}ms`);

    await manager.shutdownAll();
  });
});
