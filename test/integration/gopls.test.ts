import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServerManager } from "../../src/server-manager.js";
import { builtinLanguages as languages } from "../../src/languages.js";

const goConfig = languages.find((l) => l.id === "go")!;

let tempDirs: string[] = [];
let managers: ReturnType<typeof createServerManager>[] = [];
let sharedDir: string;
let sharedManager: ReturnType<typeof createServerManager>;

async function makeTempDir(): Promise<string> {
  const dir = join(tmpdir(), `pi-lsp-gopls-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function makeManager() {
  const m = createServerManager({ diagnosticTimeout: 15_000 });
  managers.push(m);
  return m;
}

afterEach(async () => {
  for (const m of managers) {
    if (m !== sharedManager) await m.shutdownAll();
  }
  managers = [];
  for (const dir of tempDirs) {
    if (dir !== sharedDir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tempDirs = [];
});

describe("gopls integration", { skip: !process.env.INTEGRATION }, () => {
  before(async () => {
    // warmup: spawn gopls and let it index a minimal module
    sharedDir = await makeTempDir();
    await writeFile(join(sharedDir, "go.mod"), "module example.com/test\n\ngo 1.21\n");
    const warmupFile = join(sharedDir, "warmup.go");
    await writeFile(warmupFile, "package main\n");
    sharedManager = makeManager();
    // allow up to 30s for cold start (module download, indexing)
    await sharedManager.handleEdit(warmupFile, goConfig, sharedDir);
    await sharedManager.shutdownAll();
  });

  it("reports syntax error", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "go.mod"), "module example.com/test\n\ngo 1.21\n");
    const filePath = join(dir, "main.go");
    await writeFile(filePath, "package main\n\nfunc main() {\n  fmt.Println(\n}\n");

    const manager = makeManager();
    const result = await manager.handleEdit(filePath, goConfig, dir);
    assert.equal(result.status, "ok");
    assert.ok(result.diagnostics.length > 0, "expected at least one diagnostic for syntax error");
  });

  it("reports no errors for clean file", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "go.mod"), "module example.com/test\n\ngo 1.21\n");
    const filePath = join(dir, "main.go");
    await writeFile(filePath, 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hello")\n}\n');

    const manager = makeManager();
    const result = await manager.handleEdit(filePath, goConfig, dir);
    assert.equal(result.status, "ok");
    assert.equal(result.diagnostics.length, 0);
  });

  it("detects cross-file breakage", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "go.mod"), "module example.com/test\n\ngo 1.21\n");
    await writeFile(
      join(dir, "lib.go"),
      "package main\n\nfunc Add(a, b int) int {\n\treturn a + b\n}\n",
    );
    await writeFile(
      join(dir, "main.go"),
      'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println(Add(1, 2))\n}\n',
    );

    const manager = makeManager();
    await manager.handleEdit(join(dir, "main.go"), goConfig, dir);
    await manager.handleEdit(join(dir, "lib.go"), goConfig, dir);

    // break the signature
    await writeFile(
      join(dir, "lib.go"),
      "package main\n\nfunc Add(a, b, c int) int {\n\treturn a + b + c\n}\n",
    );
    const result = await manager.handleEdit(join(dir, "lib.go"), goConfig, dir);
    assert.equal(result.status, "ok");

    const totalDiags = result.diagnostics.length + result.otherFiles.reduce((s, f) => s + f.errorCount, 0);
    assert.ok(totalDiags > 0, "expected diagnostics from cross-file breakage");
  });
});
