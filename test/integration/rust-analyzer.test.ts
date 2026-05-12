import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServerManager } from "../../src/server-manager.js";
import { builtinLanguages as languages } from "../../src/languages.js";

const rustConfig = languages.find((l) => l.id === "rust")!;

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = join(tmpdir(), `pi-lsp-rust-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

describe("rust-analyzer integration", { skip: !process.env.INTEGRATION }, () => {
  let manager: ReturnType<typeof createServerManager>;

  before(async () => {
    manager = createServerManager({ diagnosticTimeout: 15_000 });
    const dir = await makeTempDir();
    await writeFile(
      join(dir, "Cargo.toml"),
      '[package]\nname = "warmup"\nversion = "0.1.0"\nedition = "2021"\n',
    );
    const srcDir = join(dir, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(srcDir, "main.rs"), "fn main() {}\n");
    const warmup = await manager.handleEdit(join(srcDir, "main.rs"), rustConfig, dir);
    assert.notEqual(warmup.status, "unavailable", "rust-analyzer is not available — cannot run integration tests");
  });

  after(async () => {
    await manager.shutdownAll();
    for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("reports syntax error", async () => {
    const dir = await makeTempDir();
    await writeFile(
      join(dir, "Cargo.toml"),
      '[package]\nname = "test"\nversion = "0.1.0"\nedition = "2021"\n',
    );
    const srcDir = join(dir, "src");
    await mkdir(srcDir, { recursive: true });
    const filePath = join(srcDir, "main.rs");
    await writeFile(filePath, "fn main() {\n  let x = \n}\n");

    const result = await manager.handleEdit(filePath, rustConfig, dir);
    assert.equal(result.status, "ok");
    assert.ok(result.diagnostics.length > 0, "expected at least one diagnostic for syntax error");
  });

  it("reports no errors for clean file", async () => {
    const dir = await makeTempDir();
    await writeFile(
      join(dir, "Cargo.toml"),
      '[package]\nname = "test"\nversion = "0.1.0"\nedition = "2021"\n',
    );
    const srcDir = join(dir, "src");
    await mkdir(srcDir, { recursive: true });
    const filePath = join(srcDir, "main.rs");
    await writeFile(filePath, 'fn main() {\n    println!("hello");\n}\n');

    const result = await manager.handleEdit(filePath, rustConfig, dir);
    assert.equal(result.status, "ok");
    assert.equal(result.diagnostics.length, 0);
  });

  it("detects cross-file breakage", async () => {
    const dir = await makeTempDir();
    await writeFile(
      join(dir, "Cargo.toml"),
      '[package]\nname = "test"\nversion = "0.1.0"\nedition = "2021"\n',
    );
    const srcDir = join(dir, "src");
    await mkdir(srcDir, { recursive: true });
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
