import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServerManager } from "../../src/server-manager.js";
import { builtinLanguages as languages } from "../../src/languages.js";

const cppConfig = languages.find((l) => l.id === "cpp");
if (!cppConfig) throw new Error("cpp config not found in languages");

describe("clangd integration", { skip: !process.env.INTEGRATION }, () => {
  let manager: ReturnType<typeof createServerManager>;
  let dir: string;

  before(async () => {
    manager = createServerManager();
    dir = join(tmpdir(), `pi-lsp-cpp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(dir, { recursive: true });
    // minimal compile_commands.json for clangd
    await writeFile(join(dir, "compile_commands.json"), JSON.stringify([
      { directory: dir, file: "main.c", arguments: ["cc", "-c", "main.c"] },
    ]));

    // warmup
    await writeFile(join(dir, "warmup.c"), "int warmup(void) { return 0; }\n");
    const warmup = await manager.handleEdit(join(dir, "warmup.c"), cppConfig, dir);
    assert.notEqual(warmup.status, "unavailable", "clangd is not available — cannot run integration tests");
  });

  after(async () => {
    await manager.shutdownAll();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("reports syntax error", async () => {
    const filePath = join(dir, "syntax_error.c");
    await writeFile(filePath, "int broken( { return 0; }\n");

    const result = await manager.handleEdit(filePath, cppConfig, dir);
    assert.equal(result.status, "ok");
    assert.ok(result.diagnostics.length > 0, "expected at least one diagnostic for syntax error");

    // fix
    await writeFile(filePath, "int fixed(void) { return 0; }\n");
    await manager.handleEdit(filePath, cppConfig, dir);
  });

  it("reports no errors for clean file", async () => {
    const filePath = join(dir, "clean.c");
    await writeFile(filePath, '#include <stdio.h>\nint main(void) {\n    printf("hello\\n");\n    return 0;\n}\n');

    const result = await manager.handleEdit(filePath, cppConfig, dir);
    assert.equal(result.status, "ok");
    assert.equal(result.diagnostics.length, 0);
  });
});
