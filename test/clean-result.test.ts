import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Diagnostic } from "vscode-languageserver-protocol";
import type { DiagnosticResult } from "../src/client.js";
import { isCleanResult } from "./clean-result.js";
import { pollUntil } from "./poll-until.js";

function makeResult(
  status: DiagnosticResult["status"],
  diagnostics: DiagnosticResult["diagnostics"] = [],
): DiagnosticResult {
  return { status, diagnostics, otherFiles: [], retryAttempts: 0 };
}

const warning: Diagnostic = {
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  severity: 2,
  message: "unused variable",
};
const error: Diagnostic = { ...warning, severity: 1, message: "undefined variable" };

describe("isCleanResult", () => {
  it("accepts a successful result with no diagnostics", () => {
    assert.equal(isCleanResult(makeResult("ok")), true);
  });

  it("accepts a successful warning-only result", () => {
    assert.equal(isCleanResult(makeResult("ok", [warning])), true);
  });

  it("rejects a successful result containing an error", () => {
    assert.equal(isCleanResult(makeResult("ok", [warning, error])), false);
  });

  for (const status of ["timeout", "unavailable"] as const) {
    it(`rejects an empty ${status} result`, () => {
      assert.equal(isCleanResult(makeResult(status)), false);
    });
  }

  it("does not require other files to be clean", () => {
    const result = makeResult("ok");
    result.otherFiles = [{ uri: "file:///project/other.ts", errorCount: 1, warningCount: 1 }];
    assert.equal(isCleanResult(result), true);
  });
});

describe("clean-result polling", () => {
  it("keeps polling past unsuccessful and error results until a successful clean result", async () => {
    const results = [
      makeResult("timeout"),
      makeResult("unavailable"),
      makeResult("ok", [error]),
      makeResult("ok", [warning]),
    ];
    let calls = 0;
    const result = await pollUntil(
      async () => results[calls++],
      isCleanResult,
      { maxAttempts: 5, delayMs: 0 },
    );

    assert.equal(calls, 4);
    assert.equal(result, results[3]);
    assert.ok(isCleanResult(result));
  });

  for (const status of ["timeout", "unavailable"] as const) {
    it(`rejects the final empty ${status} result after polling exhausts`, async () => {
      const unsuccessful = makeResult(status);
      let calls = 0;
      const result = await pollUntil(
        async () => {
          calls++;
          return unsuccessful;
        },
        isCleanResult,
        { maxAttempts: 3, delayMs: 0 },
      );

      assert.equal(calls, 3);
      assert.equal(result, unsuccessful);
      assert.equal(isCleanResult(result), false);
      assert.throws(() => assert.ok(isCleanResult(result)), assert.AssertionError);
    });
  }
});
