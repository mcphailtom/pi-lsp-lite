import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createLspClient } from "../src/client.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fakeServerPath = join(__dirname, "fake-server.ts");

function spawnFake(options: Record<string, unknown> = {}) {
  const args = ["--import", "tsx", fakeServerPath, "--run"];
  if (Object.keys(options).length > 0) {
    args.push(`--options=${JSON.stringify(options)}`);
  }
  return spawn(process.execPath, args, {
    stdio: ["pipe", "pipe", "pipe"],
  });
}

describe("LspClient", () => {
  it("receives diagnostics after didOpen", async () => {
    const child = spawnFake();
    const client = createLspClient(child);
    await client.initialize("/tmp/test-workspace");

    const uri = "file:///tmp/test-workspace/main.go";
    client.didOpen(uri, "go", "package main");

    const result = await client.waitForDiagnostics(uri, 2000);
    assert.equal(result.status, "ok");
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0].message, "fake error");

    await client.shutdown();
  });

  it("returns ok with empty diagnostics for clean file", async () => {
    const child = spawnFake({
      diagnosticsByUri: { "file:///tmp/test-workspace/clean.go": [] },
    });
    const client = createLspClient(child);
    await client.initialize("/tmp/test-workspace");

    const uri = "file:///tmp/test-workspace/clean.go";
    client.didOpen(uri, "go", "package main");

    const result = await client.waitForDiagnostics(uri, 2000);
    assert.equal(result.status, "ok");
    assert.equal(result.diagnostics.length, 0);

    await client.shutdown();
  });

  it("returns ok even with delayed diagnostics", async () => {
    const child = spawnFake({ diagnosticDelay: 500 });
    const client = createLspClient(child);
    await client.initialize("/tmp/test-workspace");

    const uri = "file:///tmp/test-workspace/main.go";
    client.didOpen(uri, "go", "package main");

    const result = await client.waitForDiagnostics(uri, 2000);
    assert.equal(result.status, "ok");
    assert.equal(result.diagnostics.length, 1);

    await client.shutdown();
  });

  it("returns timeout when server never publishes", async () => {
    const child = spawnFake({ neverPublish: true });
    const client = createLspClient(child);
    await client.initialize("/tmp/test-workspace");

    const uri = "file:///tmp/test-workspace/main.go";
    client.didOpen(uri, "go", "package main");

    const result = await client.waitForDiagnostics(uri, 500);
    assert.equal(result.status, "timeout");

    await client.shutdown();
  });

  it("returns latest diagnostics after rapid didChange", async () => {
    const uri = "file:///tmp/test-workspace/main.go";
    const child = spawnFake({
      diagnosticDelay: 100,
      diagnosticsByUri: {
        [uri]: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
            severity: 1,
            message: "latest error",
            source: "fake",
          },
        ],
      },
    });
    const client = createLspClient(child);
    await client.initialize("/tmp/test-workspace");

    client.didOpen(uri, "go", "package main\nfunc a() {}");
    client.didChange(uri, "package main\nfunc b() {}");

    const result = await client.waitForDiagnostics(uri, 2000);
    assert.equal(result.status, "ok");
    assert.ok(result.diagnostics.length > 0);

    await client.shutdown();
  });

  it("didClose removes document so next didOpen is treated as fresh", async () => {
    const uri = "file:///tmp/test-workspace/main.go";
    const child = spawnFake();
    const client = createLspClient(child);
    await client.initialize("/tmp/test-workspace");

    // Open and wait for diagnostics once
    client.didOpen(uri, "go", "package main");
    const first = await client.waitForDiagnostics(uri, 2000);
    assert.equal(first.status, "ok");

    // Close the document — should remove tracking state
    client.didClose(uri);

    // Re-open: the client should send didOpen (not didChange) so fake server
    // publishes diagnostics again
    client.didOpen(uri, "go", "package main");
    const second = await client.waitForDiagnostics(uri, 2000);
    assert.equal(second.status, "ok");
    assert.equal(second.diagnostics.length, 1);

    await client.shutdown();
  });

  it("completes graceful shutdown", async () => {
    const child = spawnFake();
    const client = createLspClient(child);
    await client.initialize("/tmp/test-workspace");
    await client.shutdown();
    // no assertion needed — test passes if no error is thrown
  });

  it("ignores late diagnostics for a closed URI", async () => {
    const uri = "file:///tmp/test-workspace/ghost.go";
    const child = spawnFake({ diagnosticDelay: 200 });
    const client = createLspClient(child);
    await client.initialize("/tmp/test-workspace");

    // open the document — triggers delayed publish after 200ms
    client.didOpen(uri, "go", "package main");

    // close immediately before diagnostics arrive
    client.didClose(uri);

    // wait enough time for the delayed publish to fire
    await new Promise((r) => setTimeout(r, 500));

    // the diagnostics handler should have ignored the publish for the closed URI
    // re-open the URI: if ghost diagnostics leaked, the entry would already exist
    // with stale data; a fresh didOpen should start clean
    client.didOpen(uri, "go", "package main");
    const result = await client.waitForDiagnostics(uri, 2000);
    assert.equal(result.status, "ok");
    // the fake server publishes fresh diagnostics on didOpen, so we get "fake error"
    // the key assertion: we didn't accumulate ghost state from the closed-then-reopened cycle
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0].message, "fake error");

    await client.shutdown();
  });

  it("collects other-file diagnostics", async () => {
    const uri = "file:///tmp/test-workspace/main.go";
    const otherUri = "file:///tmp/test-workspace/other.go";
    const child = spawnFake({
      diagnosticsByUri: {
        [otherUri]: [],
      },
      otherFileDiagnostics: {
        [otherUri]: [
          {
            range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } },
            severity: 1,
            message: "error in other file",
            source: "fake",
          },
        ],
      },
    });
    const client = createLspClient(child);
    await client.initialize("/tmp/test-workspace");

    client.didOpen(otherUri, "go", "package main");
    await client.waitForDiagnostics(otherUri, 2000);

    client.didOpen(uri, "go", "package main");

    const result = await client.waitForDiagnostics(uri, 2000);
    assert.equal(result.status, "ok");
    assert.ok(result.otherFiles.length > 0);
    assert.equal(result.otherFiles[0].uri, otherUri);
    assert.equal(result.otherFiles[0].errorCount, 1);

    await client.shutdown();
  });

  it("getAllDiagnostics returns only URIs with non-empty diagnostics", async () => {
    const diag = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, message: "test error", severity: 1 };
    const child = spawnFake({ diagnosticsByUri: { "file:///test/error.ts": [diag] } });
    const client = createLspClient(child);
    await client.initialize("/test");

    client.didOpen("file:///test/error.ts", "typescript", "bad code");
    await client.waitForDiagnostics("file:///test/error.ts", 2000);

    const all = client.getAllDiagnostics();
    assert.ok(all.has("file:///test/error.ts"), "should include URI with diagnostics");
    assert.equal(all.get("file:///test/error.ts")!.length, 1);
    assert.equal(all.size, 1, "should only contain URIs with non-empty diagnostics");

    await client.shutdown();
  });
});
