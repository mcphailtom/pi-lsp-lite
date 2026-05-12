import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServerManager } from "../../src/server-manager.js";
import { builtinLanguages as languages } from "../../src/languages.js";

const goConfig = languages.find((l) => l.id === "go")!;

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = join(tmpdir(), `pi-lsp-gopls-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

describe("gopls integration", { skip: !process.env.INTEGRATION }, () => {
  let manager: ReturnType<typeof createServerManager>;

  before(async () => {
    manager = createServerManager({ diagnosticTimeout: 15_000 });
    const dir = await makeTempDir();
    await writeFile(join(dir, "go.mod"), "module example.com/test\n\ngo 1.21\n");
    await writeFile(join(dir, "warmup.go"), "package main\n");
    await manager.handleEdit(join(dir, "warmup.go"), goConfig, dir);
  });

  after(async () => {
    await manager.shutdownAll();
    for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("reports syntax error", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "go.mod"), "module example.com/test\n\ngo 1.21\n");
    const filePath = join(dir, "main.go");
    await writeFile(filePath, "package main\n\nfunc main() {\n  fmt.Println(\n}\n");

    const result = await manager.handleEdit(filePath, goConfig, dir);
    assert.equal(result.status, "ok");
    assert.ok(result.diagnostics.length > 0, "expected at least one diagnostic for syntax error");
  });

  it("reports no errors for clean file", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "go.mod"), "module example.com/test\n\ngo 1.21\n");
    const filePath = join(dir, "main.go");
    await writeFile(filePath, 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hello")\n}\n');

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
