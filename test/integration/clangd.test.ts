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
    await writeFile(join(dir, "compile_commands.json"), JSON.stringify([
      { directory: dir, file: "main.c", arguments: ["cc", "-c", "main.c"] },
    ]));

    // warmup using main.c (matches compile_commands.json)
    await writeFile(join(dir, "main.c"), "int main(void) { return 0; }\n");
    const warmup = await manager.handleEdit(join(dir, "main.c"), cppConfig, dir);
    assert.notEqual(warmup.status, "unavailable", "clangd is not available — cannot run integration tests");
  });

  after(async () => {
    await manager.shutdownAll();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("reports no errors for clean file", async () => {
    await writeFile(join(dir, "main.c"), '#include <stdio.h>\nint main(void) {\n    printf("hello\\n");\n    return 0;\n}\n');

    let result;
    for (let i = 0; i < 10; i++) {
      result = await manager.handleEdit(join(dir, "main.c"), cppConfig, dir);
      const hasErrors = result.diagnostics.some((d) => d.severity === 1);
      if (!hasErrors) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    assert.ok(result, "expected a result");
    const hasErrors = result!.diagnostics.some((d) => d.severity === 1);
    assert.equal(hasErrors, false, "expected no error diagnostics on clean file");
  });

  it("reports syntax error", async () => {
    await writeFile(join(dir, "main.c"), "int main( { return 0; }\n");

    const result = await manager.handleEdit(join(dir, "main.c"), cppConfig, dir);
    assert.equal(result.status, "ok");
    assert.ok(result.diagnostics.length > 0, "expected at least one diagnostic for syntax error");
  });
});
