import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServerManager } from "../../src/server-manager.js";
import { builtinLanguages as languages } from "../../src/languages.js";

const tsConfig = languages.find((l) => l.id === "typescript");
if (!tsConfig) throw new Error("typescript config not found in languages");

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = join(tmpdir(), `pi-lsp-ts-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

describe("typescript-language-server integration", { skip: !process.env.INTEGRATION }, () => {
  let manager: ReturnType<typeof createServerManager>;

  before(async () => {
    manager = createServerManager({ diagnosticTimeout: 15_000 });
    // warmup: force server spawn + indexing on a minimal project
    const dir = await makeTempDir();
    await writeFile(
      join(dir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }),
    );
    await writeFile(join(dir, "warmup.ts"), "const x = 1;\n");
    const warmup = await manager.handleEdit(join(dir, "warmup.ts"), tsConfig, dir);
    assert.notEqual(warmup.status, "unavailable", "typescript-language-server is not available — cannot run integration tests");
  });

  after(async () => {
    await manager.shutdownAll();
    for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("reports type error", async () => {
    const dir = await makeTempDir();
    await writeFile(
      join(dir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }),
    );
    const filePath = join(dir, "main.ts");
    await writeFile(filePath, "const x: number = 'hello';\n");

    const result = await manager.handleEdit(filePath, tsConfig, dir);
    assert.equal(result.status, "ok");
    assert.ok(result.diagnostics.length > 0, "expected at least one diagnostic for type error");
  });

  it("reports no errors for clean file", async () => {
    const dir = await makeTempDir();
    await writeFile(
      join(dir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }),
    );
    const filePath = join(dir, "main.ts");
    await writeFile(filePath, "const x: number = 42;\nconsole.log(x);\n");

    const result = await manager.handleEdit(filePath, tsConfig, dir);
    assert.equal(result.status, "ok");
    assert.equal(result.diagnostics.length, 0);
  });

  it("detects cross-file breakage", async () => {
    const dir = await makeTempDir();
    // dedicated manager with longer timeout for cross-file analysis on CI
    const crossFileManager = createServerManager({ diagnosticTimeout: 30_000 });
    await writeFile(
      join(dir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }),
    );
    await writeFile(
      join(dir, "lib.ts"),
      "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
    );
    await writeFile(
      join(dir, "main.ts"),
      "import { add } from './lib';\nconsole.log(add(1, 2));\n",
    );

    await crossFileManager.handleEdit(join(dir, "main.ts"), tsConfig, dir);
    await crossFileManager.handleEdit(join(dir, "lib.ts"), tsConfig, dir);

    // break the signature
    await writeFile(
      join(dir, "lib.ts"),
      "export function add(a: number, b: number, c: number): number {\n  return a + b + c;\n}\n",
    );
    const result = await crossFileManager.handleEdit(join(dir, "lib.ts"), tsConfig, dir);
    assert.equal(result.status, "ok");

    const totalDiags = result.diagnostics.length + result.otherFiles.reduce((s, f) => s + f.errorCount, 0);
    assert.ok(totalDiags > 0, "expected diagnostics from cross-file breakage");

    await crossFileManager.shutdownAll();
  });
});
