import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServerManager } from "../../src/server-manager.js";
import { builtinLanguages as languages } from "../../src/languages.js";

const rustConfig = languages.find((l) => l.id === "rust")!;

describe("rust-analyzer integration", { skip: !process.env.INTEGRATION }, () => {
  let manager: ReturnType<typeof createServerManager>;
  let dir: string;
  let srcDir: string;

  before(async () => {
    manager = createServerManager();
    dir = join(tmpdir(), `pi-lsp-rust-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    srcDir = join(dir, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(
      join(dir, "Cargo.toml"),
      '[package]\nname = "test"\nversion = "0.1.0"\nedition = "2021"\n',
    );

    // warmup: absorb cold start
    await writeFile(join(srcDir, "main.rs"), "fn main() {}\n");
    const warmup = await manager.handleEdit(join(srcDir, "main.rs"), rustConfig, dir);
    assert.notEqual(warmup.status, "unavailable", "rust-analyzer is not available — cannot run integration tests");
  });

  after(async () => {
    await manager.shutdownAll();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("reports syntax error", async () => {
    // write invalid code into main.rs (the module root, so no unlinked-file warning)
    await writeFile(join(srcDir, "main.rs"), "fn main() {\n  let x = \n}\n");

    const result = await manager.handleEdit(join(srcDir, "main.rs"), rustConfig, dir);
    assert.equal(result.status, "ok");
    assert.ok(result.diagnostics.length > 0, "expected at least one diagnostic for syntax error");
  });

  it("reports no errors for clean file", async () => {
    await writeFile(join(srcDir, "main.rs"), 'fn main() {\n    println!("hello");\n}\n');

    // rust-analyzer may still be publishing stale diagnostics from the previous
    // syntax error test — poll until diagnostics clear
    let result: Awaited<ReturnType<typeof manager.handleEdit>> | undefined;
    for (let i = 0; i < 10; i++) {
      result = await manager.handleEdit(join(srcDir, "main.rs"), rustConfig, dir);
      const hasErrors = result.diagnostics.some((d) => d.severity === 1);
      if (!hasErrors) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    assert.ok(result, "expected a result");
    const hasErrors = result!.diagnostics.some((d) => d.severity === 1);
    assert.equal(hasErrors, false, "expected no error diagnostics on clean file");
  });

  it("detects cross-file breakage", async () => {
    // create lib.rs as a module declared from main.rs
    await writeFile(
      join(srcDir, "lib.rs"),
      "pub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n",
    );
    await writeFile(
      join(srcDir, "main.rs"),
      'mod lib;\n\nfn main() {\n    println!("{}", lib::add(1, 2));\n}\n',
    );

    await manager.handleEdit(join(srcDir, "main.rs"), rustConfig, dir);
    await manager.handleEdit(join(srcDir, "lib.rs"), rustConfig, dir);

    // break the signature
    await writeFile(
      join(srcDir, "lib.rs"),
      "pub fn add(a: i32, b: i32, c: i32) -> i32 {\n    a + b + c\n}\n",
    );
    const result = await manager.handleEdit(join(srcDir, "lib.rs"), rustConfig, dir);
    assert.equal(result.status, "ok");

    const totalDiags = result.diagnostics.length + result.otherFiles.reduce((s, f) => s + f.errorCount, 0);
    assert.ok(totalDiags > 0, "expected diagnostics from cross-file breakage");
  });
});
