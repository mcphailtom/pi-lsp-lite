import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServerManager } from "../../src/server-manager.js";
import { builtinLanguages as languages } from "../../src/languages.js";

const pyConfig = languages.find((l) => l.id === "python");
if (!pyConfig) throw new Error("python config not found in languages");

describe("pylsp integration", { skip: !process.env.INTEGRATION }, () => {
  let manager: ReturnType<typeof createServerManager>;
  let dir: string;

  before(async () => {
    manager = createServerManager();
    dir = join(tmpdir(), `pi-lsp-py-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "pyproject.toml"), '[project]\nname = "test"\nversion = "0.1.0"\n');

    // warmup
    await writeFile(join(dir, "warmup.py"), "x = 1\n");
    const warmup = await manager.handleEdit(join(dir, "warmup.py"), pyConfig, dir);
    assert.notEqual(warmup.status, "unavailable", "pylsp is not available — cannot run integration tests");
  });

  after(async () => {
    await manager.shutdownAll();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("reports syntax error", async () => {
    const filePath = join(dir, "syntax_error.py");
    await writeFile(filePath, "def broken(:\n");

    let result: Awaited<ReturnType<typeof manager.handleEdit>> | undefined;
    for (let i = 0; i < 15; i++) {
      result = await manager.handleEdit(filePath, pyConfig, dir);
      if (result.diagnostics.some((d) => d.severity === 1)) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    assert.ok(result, "expected a result");
    assert.equal(result!.status, "ok");
    assert.ok(result!.diagnostics.some((d) => d.severity === 1), "expected at least one error diagnostic for syntax error");

    // fix so it doesn't pollute subsequent tests
    await writeFile(filePath, "def fixed():\n    pass\n");
    await manager.handleEdit(filePath, pyConfig, dir);
  });

  it("reports no errors for clean file", async () => {
    const filePath = join(dir, "clean.py");
    await writeFile(filePath, "def greet(name: str) -> str:\n    return f'hello {name}'\n");

    let result: Awaited<ReturnType<typeof manager.handleEdit>> | undefined;
    for (let i = 0; i < 15; i++) {
      result = await manager.handleEdit(filePath, pyConfig, dir);
      const hasErrors = result.diagnostics.some((d) => d.severity === 1);
      if (!hasErrors) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    assert.ok(result, "expected a result");
    const hasErrors = result!.diagnostics.some((d) => d.severity === 1);
    assert.equal(hasErrors, false, "expected no error diagnostics on clean file");
  });
});
