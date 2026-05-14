import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, writeGlobalConfig } from "../src/config.js";

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = join(tmpdir(), `pi-lsp-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

describe("loadConfig", () => {
  it("returns built-in defaults when no config files exist", async () => {
    const dir = await makeTempDir();
    const config = await loadConfig(dir, join(dir, "nonexistent-global.json"));
    assert.ok(config.servers.length >= 3);
    assert.ok(config.servers.some((s) => s.id === "go"));
    assert.ok(config.servers.some((s) => s.id === "rust"));
    assert.ok(config.servers.some((s) => s.id === "typescript"));
    assert.equal(config.diagnosticTimeout, 5000);
    assert.equal(config.documentIdleTimeout, 120000);
  });

  it("project config adds override to existing server", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, ".pi-lsp-lite.json"), JSON.stringify({
      servers: {
        typescript: { args: ["--stdio", "--log-level", "4"] },
      },
    }));
    const config = await loadConfig(dir, join(dir, "nonexistent-global.json"));
    const ts = config.servers.find((s) => s.id === "typescript");
    assert.ok(ts);
    assert.deepEqual(ts.args, ["--stdio", "--log-level", "4"]);
    assert.equal(ts.command, "typescript-language-server");
  });

  it("project config in .pi/lsp-lite.json is discovered", async () => {
    const dir = await makeTempDir();
    await mkdir(join(dir, ".pi"), { recursive: true });
    await writeFile(join(dir, ".pi", "lsp-lite.json"), JSON.stringify({
      servers: {
        go: { args: ["serve", "-rpc.trace"] },
      },
    }));
    const config = await loadConfig(dir, join(dir, "nonexistent-global.json"));
    const go = config.servers.find((s) => s.id === "go");
    assert.ok(go);
    assert.deepEqual(go.args, ["serve", "-rpc.trace"]);
  });

  it("project config disables a built-in server", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, ".pi-lsp-lite.json"), JSON.stringify({
      servers: {
        typescript: { disabled: true },
      },
    }));
    const config = await loadConfig(dir, join(dir, "nonexistent-global.json"));
    assert.ok(!config.servers.some((s) => s.id === "typescript"));
    assert.ok(config.servers.some((s) => s.id === "go"));
  });

  it("project config cannot define new servers", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, ".pi-lsp-lite.json"), JSON.stringify({
      servers: {
        haskell: {
          extensions: [".hs"],
          command: "haskell-language-server-wrapper",
          args: ["--lsp"],
          rootPatterns: ["cabal.project"],
        },
      },
    }));
    const config = await loadConfig(dir, join(dir, "nonexistent-global.json"));
    assert.ok(!config.servers.some((s) => s.id === "haskell"));
  });

  it("project config cannot override command for existing server", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, ".pi-lsp-lite.json"), JSON.stringify({
      servers: {
        go: {
          command: "evil-gopls",
          args: ["--extra-flag"],
        },
      },
    }));
    const config = await loadConfig(dir, join(dir, "nonexistent-global.json"));
    const goServer = config.servers.find((s) => s.id === "go");
    assert.ok(goServer);
    assert.equal(goServer.command, "gopls", "command override from project config should be ignored");
    assert.deepEqual(goServer.args, ["--extra-flag"], "non-command overrides from project config should still apply");
  });

  it("global config can define new servers", async () => {
    const dir = await makeTempDir();
    const globalPath = join(dir, "global.json");
    await writeFile(globalPath, JSON.stringify({
      servers: {
        haskell: {
          extensions: [".hs"],
          command: "haskell-language-server-wrapper",
          args: ["--lsp"],
          rootPatterns: ["cabal.project"],
        },
      },
    }));
    const config = await loadConfig(dir, globalPath);
    assert.ok(config.servers.some((s) => s.id === "haskell"));
  });

  it("global config overridden by project config", async () => {
    const dir = await makeTempDir();
    const globalPath = join(dir, "global.json");
    await writeFile(globalPath, JSON.stringify({
      diagnosticTimeout: 8000,
    }));
    await writeFile(join(dir, ".pi-lsp-lite.json"), JSON.stringify({
      diagnosticTimeout: 3000,
    }));
    const config = await loadConfig(dir, globalPath);
    assert.equal(config.diagnosticTimeout, 3000);
  });

  it("partial override changes only specified fields", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, ".pi-lsp-lite.json"), JSON.stringify({
      servers: {
        typescript: { args: ["--stdio", "--log-level", "4"] },
      },
    }));
    const config = await loadConfig(dir, join(dir, "nonexistent-global.json"));
    const ts = config.servers.find((s) => s.id === "typescript");
    assert.ok(ts);
    assert.deepEqual(ts.args, ["--stdio", "--log-level", "4"]);
    assert.equal(ts.command, "typescript-language-server");
    assert.deepEqual(ts.extensions, [".ts", ".tsx", ".js", ".jsx"]);
  });

  it("skips new server without required fields from global config", async () => {
    const dir = await makeTempDir();
    const globalPath = join(dir, "global.json");
    await writeFile(globalPath, JSON.stringify({
      servers: {
        incomplete: { args: ["--stdio"] },
      },
    }));
    const config = await loadConfig(dir, globalPath);
    assert.ok(!config.servers.some((s) => s.id === "incomplete"));
  });

  it("handles malformed JSON gracefully", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, ".pi-lsp-lite.json"), "{ broken json");
    const config = await loadConfig(dir, join(dir, "nonexistent-global.json"));
    assert.ok(config.servers.length >= 3);
  });

  it("handles non-object JSON gracefully", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, ".pi-lsp-lite.json"), '"just a string"');
    const config = await loadConfig(dir, join(dir, "nonexistent-global.json"));
    assert.ok(config.servers.length >= 3);
  });

  it("overrides global diagnosticTimeout", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, ".pi-lsp-lite.json"), JSON.stringify({
      diagnosticTimeout: 8000,
    }));
    const config = await loadConfig(dir, join(dir, "nonexistent-global.json"));
    assert.equal(config.diagnosticTimeout, 8000);
  });

  it("clamps diagnosticTimeout to bounds", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, ".pi-lsp-lite.json"), JSON.stringify({
      diagnosticTimeout: 999999,
    }));
    const config = await loadConfig(dir, join(dir, "nonexistent-global.json"));
    assert.equal(config.diagnosticTimeout, 60000);
  });

  it("clamps diagnosticTimeout minimum", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, ".pi-lsp-lite.json"), JSON.stringify({
      diagnosticTimeout: 0,
    }));
    const config = await loadConfig(dir, join(dir, "nonexistent-global.json"));
    assert.equal(config.diagnosticTimeout, 1000);
  });

  it("ignores non-numeric diagnosticTimeout", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, ".pi-lsp-lite.json"), JSON.stringify({
      diagnosticTimeout: "fast",
    }));
    const config = await loadConfig(dir, join(dir, "nonexistent-global.json"));
    assert.equal(config.diagnosticTimeout, 5000);
  });

  it("overrides documentIdleTimeout", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, ".pi-lsp-lite.json"), JSON.stringify({
      documentIdleTimeout: 60000,
    }));
    const config = await loadConfig(dir, join(dir, "nonexistent-global.json"));
    assert.equal(config.documentIdleTimeout, 60000);
  });

  it("per-server diagnosticTimeout override", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, ".pi-lsp-lite.json"), JSON.stringify({
      servers: {
        rust: { diagnosticTimeout: 10000 },
      },
    }));
    const config = await loadConfig(dir, join(dir, "nonexistent-global.json"));
    assert.equal(config.perServerTimeout.get("rust"), 10000);
    assert.equal(config.perServerTimeout.has("go"), false);
  });

  it("lowercases user-provided extensions", async () => {
    const dir = await makeTempDir();
    const globalPath = join(dir, "global.json");
    await writeFile(globalPath, JSON.stringify({
      servers: {
        python: {
          extensions: [".PY", ".Pyw"],
          command: "pylsp",
        },
      },
    }));
    const config = await loadConfig(dir, globalPath);
    const python = config.servers.find((s) => s.id === "python");
    assert.ok(python);
    assert.deepEqual(python.extensions, [".py", ".pyw"]);
  });

  it("rejects server override with invalid extensions type", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, ".pi-lsp-lite.json"), JSON.stringify({
      servers: {
        go: { extensions: "not-an-array" },
      },
    }));
    const config = await loadConfig(dir, join(dir, "nonexistent-global.json"));
    const go = config.servers.find((s) => s.id === "go");
    assert.ok(go);
    assert.deepEqual(go.extensions, [".go"]);
  });

  it("rejects server override with empty command", async () => {
    const dir = await makeTempDir();
    const globalPath = join(dir, "global.json");
    await writeFile(globalPath, JSON.stringify({
      servers: {
        bad: { extensions: [".bad"], command: "" },
      },
    }));
    const config = await loadConfig(dir, globalPath);
    assert.ok(!config.servers.some((s) => s.id === "bad"));
  });

  it("maxRetries passes through to server config", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, ".pi-lsp-lite.json"), JSON.stringify({
      servers: {
        go: { maxRetries: 5 },
      },
    }));
    const config = await loadConfig(dir, join(dir, "nonexistent-global.json"));
    const go = config.servers.find((s) => s.id === "go");
    assert.ok(go);
    assert.equal(go.maxRetries, 5);
  });

  it("clamps maxRetries to maximum of 10", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, ".pi-lsp-lite.json"), JSON.stringify({
      servers: {
        go: { maxRetries: 999 },
      },
    }));
    const config = await loadConfig(dir, join(dir, "nonexistent-global.json"));
    const go = config.servers.find((s) => s.id === "go");
    assert.ok(go);
    assert.equal(go.maxRetries, 10);
  });

  it("clamps maxRetries to minimum of 0", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, ".pi-lsp-lite.json"), JSON.stringify({
      servers: {
        go: { maxRetries: -5 },
      },
    }));
    const config = await loadConfig(dir, join(dir, "nonexistent-global.json"));
    const go = config.servers.find((s) => s.id === "go");
    assert.ok(go);
    assert.equal(go.maxRetries, 0);
  });

  it("non-numeric maxRetries falls back to default of 3", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, ".pi-lsp-lite.json"), JSON.stringify({
      servers: {
        go: { maxRetries: "many" },
      },
    }));
    const config = await loadConfig(dir, join(dir, "nonexistent-global.json"));
    const go = config.servers.find((s) => s.id === "go");
    assert.ok(go);
    assert.equal(go.maxRetries, 3);
  });
});

describe("writeGlobalConfig", () => {
  it("creates a new config file when none exists", async () => {
    const dir = await makeTempDir();
    const globalPath = join(dir, "global.json");
    await writeGlobalConfig({ servers: { haskell: { command: "hls", extensions: [".hs"] } } }, globalPath);
    const config = await loadConfig(dir, globalPath);
    const haskell = config.servers.find((s) => s.id === "haskell");
    assert.ok(haskell);
    assert.equal(haskell.command, "hls");
    assert.deepEqual(haskell.extensions, [".hs"]);
  });

  it("merges with existing config preserving unrelated entries", async () => {
    const dir = await makeTempDir();
    const globalPath = join(dir, "global.json");
    await writeFile(globalPath, JSON.stringify({
      diagnosticTimeout: 8000,
      servers: {
        haskell: { command: "hls", extensions: [".hs"] },
      },
    }));
    await writeGlobalConfig({ servers: { ocaml: { command: "ocamllsp", extensions: [".ml"] } } }, globalPath);
    const config = await loadConfig(dir, globalPath);
    assert.ok(config.servers.find((s) => s.id === "haskell"));
    assert.ok(config.servers.find((s) => s.id === "ocaml"));
    assert.equal(config.diagnosticTimeout, 8000);
  });

  it("overwrites existing server entry", async () => {
    const dir = await makeTempDir();
    const globalPath = join(dir, "global.json");
    await writeFile(globalPath, JSON.stringify({
      servers: {
        haskell: { command: "hls", extensions: [".hs"], args: ["--lsp"] },
      },
    }));
    await writeGlobalConfig({ servers: { haskell: { args: ["--lsp", "--debug"] } } }, globalPath);
    const raw = JSON.parse(await readFile(globalPath, "utf-8"));
    assert.deepEqual(raw.servers.haskell.args, ["--lsp", "--debug"]);
    assert.equal(raw.servers.haskell.command, "hls");
  });

  it("writes formatted JSON with trailing newline", async () => {
    const dir = await makeTempDir();
    const globalPath = join(dir, "global.json");
    await writeGlobalConfig({ diagnosticTimeout: 5000 }, globalPath);
    const content = await readFile(globalPath, "utf-8");
    assert.ok(content.includes("\n"));
    assert.ok(content.endsWith("\n"));
    JSON.parse(content);
  });

  it("handles disabling a server via merge", async () => {
    const dir = await makeTempDir();
    const globalPath = join(dir, "global.json");
    await writeGlobalConfig({ servers: { go: { disabled: true } } }, globalPath);
    const config = await loadConfig(dir, globalPath);
    assert.ok(!config.servers.find((s) => s.id === "go"));
  });

  it("creates parent directories if needed", async () => {
    const dir = await makeTempDir();
    const globalPath = join(dir, "nested", "dir", "global.json");
    await writeGlobalConfig({ diagnosticTimeout: 3000 }, globalPath);
    const config = await loadConfig(dir, globalPath);
    assert.equal(config.diagnosticTimeout, 3000);
  });
});
