import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { installCommandFor, installRegistry } from "../src/install-registry.js";

describe("installRegistry", () => {
  it("installs pylsp through the Python interpreter rather than bare pip", () => {
    const python = installRegistry.get("python");
    assert.ok(python);
    assert.equal(python.command.default, "python3 -m pip install python-lsp-server");
    assert.equal(python.command.win32, "py -m pip install python-lsp-server");
  });

  it("resolves the default install command on non-Windows platforms", { skip: process.platform === "win32" }, () => {
    const python = installRegistry.get("python");
    assert.ok(python);
    assert.equal(installCommandFor(python), "python3 -m pip install python-lsp-server");
  });

  it("resolves the Windows install command on Windows", { skip: process.platform !== "win32" }, () => {
    const python = installRegistry.get("python");
    assert.ok(python);
    assert.equal(installCommandFor(python), "py -m pip install python-lsp-server");
  });
});
