import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServerManager } from "../../src/server-manager.js";
import { builtinLanguages as languages } from "../../src/languages.js";
import { pollUntil } from "../poll-until.js";

const tsConfig = languages.find((l) => l.id === "typescript");
if (!tsConfig) throw new Error("typescript config not found in languages");

describe("typescript-language-server integration", { skip: !process.env.INTEGRATION }, () => {
  let manager: ReturnType<typeof createServerManager>;
  let dir: string;

  before(async () => {
    manager = createServerManager({ maxRetries: 0 });
    dir = join(tmpdir(), `pi-lsp-ts-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }),
    );

    // warmup: absorb cold start
    await writeFile(join(dir, "warmup.ts"), "const x = 1;\n");
    const warmup = await manager.handleEdit(join(dir, "warmup.ts"), tsConfig, dir);
    assert.notEqual(warmup.status, "unavailable", "typescript-language-server is not available — cannot run integration tests");
  });

  after(async () => {
    await manager.shutdownAll();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("reports type error", async () => {
    const filePath = join(dir, "type_error.ts");
    await writeFile(filePath, "const x: number = 'hello';\n");

    const result = await pollUntil(
      () => manager.handleEdit(filePath, tsConfig, dir),
      (r) => r.diagnostics.some((d) => d.severity === 1),
    );

    assert.equal(result.status, "ok");
    assert.ok(result.diagnostics.some((d) => d.severity === 1), "expected at least one error diagnostic for type error");

    // fix the error so it doesn't pollute subsequent tests
    await writeFile(filePath, "const x: number = 42;\n");
    await manager.handleEdit(filePath, tsConfig, dir);
  });

  it("reports no errors for clean file", async () => {
    const filePath = join(dir, "clean.ts");
    await writeFile(filePath, "export const _clean: number = 42;\nconsole.log(_clean);\n");

    const result = await pollUntil(
      () => manager.handleEdit(filePath, tsConfig, dir),
      (r) => !r.diagnostics.some((d) => d.severity === 1),
    );

    const hasErrors = result.diagnostics.some((d) => d.severity === 1);
    assert.equal(hasErrors, false, "expected no error diagnostics on clean file");
  });

  it("detects cross-file breakage", async () => {
    await writeFile(
      join(dir, "lib.ts"),
      "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
    );
    await writeFile(
      join(dir, "caller.ts"),
      "import { add } from './lib';\nconsole.log(add(1, 2));\n",
    );

    // open both files so the server tracks them
    await manager.handleEdit(join(dir, "caller.ts"), tsConfig, dir);
    await manager.handleEdit(join(dir, "lib.ts"), tsConfig, dir);

    // break the signature
    await writeFile(
      join(dir, "lib.ts"),
      "export function add(a: number, b: number, c: number): number {\n  return a + b + c;\n}\n",
    );

    const result = await pollUntil(
      () => manager.handleEdit(join(dir, "lib.ts"), tsConfig, dir),
      (r) => {
        const totalDiags = r.diagnostics.filter((d) => d.severity === 1).length
          + r.otherFiles.reduce((s, f) => s + f.errorCount, 0);
        return totalDiags > 0;
      },
    );

    assert.equal(result.status, "ok");
    const totalDiags = result.diagnostics.filter((d) => d.severity === 1).length
      + result.otherFiles.reduce((s, f) => s + f.errorCount, 0);
    assert.ok(totalDiags > 0, "expected diagnostics from cross-file breakage");
  });
});
