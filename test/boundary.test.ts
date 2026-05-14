import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { isInsideCwd } from "../src/util.js";

describe("cwd boundary check", () => {
  it("rejects a path outside cwd", () => {
    const cwd = "/home/user/project";
    const filePath = "../outside/main.go";
    const absolutePath = resolve(cwd, filePath);
    assert.equal(isInsideCwd(absolutePath, cwd), false);
  });

  it("accepts a path inside cwd", () => {
    const cwd = "/home/user/project";
    const filePath = "src/main.go";
    const absolutePath = resolve(cwd, filePath);
    assert.equal(isInsideCwd(absolutePath, cwd), true);
  });

  it("rejects path that is the cwd itself (not inside it)", () => {
    const cwd = "/home/user/project";
    const absolutePath = resolve(cwd, ".");
    assert.equal(isInsideCwd(absolutePath, cwd), false);
  });

  it("rejects a path that shares a prefix but is a sibling directory", () => {
    const cwd = "/home/user/project";
    const filePath = "/home/user/project-other/main.go";
    assert.equal(isInsideCwd(filePath, cwd), false);
  });

  it("handles cwd with trailing slash", () => {
    const cwd = "/home/user/project/";
    const absolutePath = resolve(cwd, "src/main.go");
    assert.equal(isInsideCwd(absolutePath, cwd), true);
  });

  it("handles root cwd", () => {
    const cwd = "/";
    const absolutePath = "/usr/local/bin/file.go";
    assert.equal(isInsideCwd(absolutePath, cwd), true);
  });
});
