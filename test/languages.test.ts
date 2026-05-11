import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { builtinLanguages, languageForFile, checkExtensionOverlaps, type LanguageServerConfig } from "../src/languages.js";

const goConfig: LanguageServerConfig = { id: "go", extensions: [".go"], command: "gopls", args: ["serve"], rootPatterns: ["go.mod"] };
const tsConfig: LanguageServerConfig = { id: "typescript", extensions: [".ts", ".tsx", ".js", ".jsx"], command: "typescript-language-server", args: ["--stdio"], rootPatterns: ["tsconfig.json", "package.json"] };
const pyConfig: LanguageServerConfig = { id: "python", extensions: [".py"], command: "pylsp", args: [], rootPatterns: ["pyproject.toml"] };

describe("builtinLanguages", () => {
  it("contains go, rust, and typescript entries", () => {
    const ids = builtinLanguages.map((l) => l.id);
    assert.ok(ids.includes("go"));
    assert.ok(ids.includes("rust"));
    assert.ok(ids.includes("typescript"));
  });

  it("each entry has required fields", () => {
    for (const lang of builtinLanguages) {
      assert.ok(typeof lang.id === "string" && lang.id.length > 0, `${lang.id}: missing id`);
      assert.ok(Array.isArray(lang.extensions) && lang.extensions.length > 0, `${lang.id}: missing extensions`);
      assert.ok(typeof lang.command === "string" && lang.command.length > 0, `${lang.id}: missing command`);
      assert.ok(Array.isArray(lang.args), `${lang.id}: args must be array`);
      assert.ok(Array.isArray(lang.rootPatterns), `${lang.id}: rootPatterns must be array`);
    }
  });
});

describe("languageForFile", () => {
  it("matches a .go file to the go config", () => {
    const result = languageForFile("/project/main.go", [goConfig, tsConfig]);
    assert.equal(result?.id, "go");
  });

  it("matches a .ts file to the typescript config", () => {
    const result = languageForFile("/project/src/index.ts", [goConfig, tsConfig]);
    assert.equal(result?.id, "typescript");
  });

  it("matches a .tsx file", () => {
    const result = languageForFile("/app/Component.tsx", [goConfig, tsConfig]);
    assert.equal(result?.id, "typescript");
  });

  it("matches a .js file", () => {
    const result = languageForFile("/app/main.js", [goConfig, tsConfig]);
    assert.equal(result?.id, "typescript");
  });

  it("returns undefined for an unrecognised extension", () => {
    const result = languageForFile("/project/main.rb", [goConfig, tsConfig]);
    assert.equal(result, undefined);
  });

  it("returns undefined for an empty configs list", () => {
    const result = languageForFile("/project/main.go", []);
    assert.equal(result, undefined);
  });

  it("is case-insensitive for the extension", () => {
    const result = languageForFile("/project/MAIN.GO", [goConfig]);
    assert.equal(result?.id, "go");
  });

  it("matches the first config when two configs claim the same extension", () => {
    const alsoGo: LanguageServerConfig = { id: "also-go", extensions: [".go"], command: "gopls2", args: [], rootPatterns: [] };
    const result = languageForFile("/project/main.go", [goConfig, alsoGo]);
    assert.equal(result?.id, "go");
  });

  it("uses the supplied configs, not a hardcoded list", () => {
    const result = languageForFile("/project/app.py", [pyConfig]);
    assert.equal(result?.id, "python");
  });

  it("returns undefined for a file with no extension", () => {
    const result = languageForFile("/project/Makefile", [goConfig, tsConfig]);
    assert.equal(result, undefined);
  });
});

describe("checkExtensionOverlaps", () => {
  it("returns no warnings when configs are disjoint", () => {
    const warnings = checkExtensionOverlaps([goConfig, tsConfig, pyConfig]);
    assert.deepEqual(warnings, []);
  });

  it("returns a warning when two configs share an extension", () => {
    const alsoGo: LanguageServerConfig = { id: "also-go", extensions: [".go"], command: "gopls2", args: [], rootPatterns: [] };
    const warnings = checkExtensionOverlaps([goConfig, alsoGo]);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes(".go"));
    assert.ok(warnings[0].includes("go"));
    assert.ok(warnings[0].includes("also-go"));
  });

  it("reports the first claimant as the winner", () => {
    const alsoGo: LanguageServerConfig = { id: "also-go", extensions: [".go"], command: "gopls2", args: [], rootPatterns: [] };
    const [warning] = checkExtensionOverlaps([goConfig, alsoGo]);
    assert.ok(warning.includes('"go" wins'), `expected '"go" wins' in: ${warning}`);
  });

  it("returns no warnings for an empty list", () => {
    const warnings = checkExtensionOverlaps([]);
    assert.deepEqual(warnings, []);
  });

  it("returns no warnings for a single config", () => {
    const warnings = checkExtensionOverlaps([goConfig]);
    assert.deepEqual(warnings, []);
  });

  it("detects overlap even when a config has multiple extensions", () => {
    const clashesWithTs: LanguageServerConfig = { id: "other-js", extensions: [".js"], command: "other-ls", args: [], rootPatterns: [] };
    const warnings = checkExtensionOverlaps([tsConfig, clashesWithTs]);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes(".js"));
    assert.ok(warnings[0].includes("typescript"));
    assert.ok(warnings[0].includes("other-js"));
  });

  it("reports multiple overlaps independently", () => {
    const overlap: LanguageServerConfig = { id: "overlap", extensions: [".go", ".rs"], command: "x", args: [], rootPatterns: [] };
    const rustConfig = builtinLanguages.find((l) => l.id === "rust")!;
    const warnings = checkExtensionOverlaps([goConfig, rustConfig, overlap]);
    assert.equal(warnings.length, 2);
    assert.ok(warnings.some((w) => w.includes(".go")));
    assert.ok(warnings.some((w) => w.includes(".rs")));
  });
});
