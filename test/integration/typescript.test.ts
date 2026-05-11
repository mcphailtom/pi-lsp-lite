import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServerManager } from "../../src/server-manager.js";
import { languages } from "../../src/languages.js";

const tsConfig = languages.find((l) => l.id === "typescript");
if (!tsConfig) throw new Error("typescript config not found in languages");

let tempDirs: string[] = [];
let managers: ReturnType<typeof createServerManager>[] = [];

async function makeTempDir(): Promise<string> {
  const dir = join(tmpdir(), `pi-lsp-ts-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function makeManager() {
  const m = createServerManager();
  managers.push(m);
  return m;
}

afterEach(async () => {
  for (const m of managers) await m.shutdownAll();
  managers = [];
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
  tempDirs = [];
});

describe("typescript-language-server integration", { skip: !process.env.INTEGRATION }, () => {
  it("reports type error", async () => {
    const dir = await makeTempDir();
    await writeFile(
      join(dir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }),
    );
    const filePath = join(dir, "main.ts");
    await writeFile(filePath, "const x: number = 'hello';\n");

    const manager = makeManager();
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

    const manager = makeManager();
    const result = await manager.handleEdit(filePath, tsConfig, dir);
    assert.equal(result.status, "ok");
    assert.equal(result.diagnostics.length, 0);
  });

  it("detects cross-file breakage", async () => {
    const dir = await makeTempDir();
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

    const manager = makeManager();

    // open both files
    await manager.handleEdit(join(dir, "main.ts"), tsConfig, dir);
    await manager.handleEdit(join(dir, "lib.ts"), tsConfig, dir);

    // break the signature: change add to require 3 args
    await writeFile(
      join(dir, "lib.ts"),
      "export function add(a: number, b: number, c: number): number {\n  return a + b + c;\n}\n",
    );
    const result = await manager.handleEdit(join(dir, "lib.ts"), tsConfig, dir);
    assert.equal(result.status, "ok");

    const totalDiags = result.diagnostics.length + result.otherFiles.reduce((s, f) => s + f.errorCount, 0);
    assert.ok(totalDiags > 0, "expected diagnostics from cross-file breakage");
  });
});
