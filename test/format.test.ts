import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatDiagnostics } from "../src/format.js";
import { DiagnosticSeverity, type Diagnostic } from "vscode-languageserver-protocol";
import type { DiagnosticResult } from "../src/client.js";

function makeDiag(severity: DiagnosticSeverity, message: string, line = 0, col = 0): Diagnostic {
  return {
    range: { start: { line, character: col }, end: { line, character: col + 5 } },
    severity,
    message,
    source: "test",
  };
}

describe("formatDiagnostics", () => {
  it("formats ok result with errors and warnings", () => {
    const result: DiagnosticResult = {
      status: "ok",
      diagnostics: [
        makeDiag(DiagnosticSeverity.Error, "undefined variable", 4, 10),
        makeDiag(DiagnosticSeverity.Warning, "unused import", 1, 0),
      ],
      otherFiles: [],
      retryAttempts: 0,
    };

    const output = formatDiagnostics("main.go", result);
    assert.ok(output.includes("1 error"));
    assert.ok(output.includes("1 warning"));
    assert.ok(output.includes("error 5:11"));
    assert.ok(output.includes("warning 2:1"));
    assert.ok(output.includes("undefined variable"));
    assert.ok(output.includes("unused import"));
  });

  it("returns empty string for ok result with no diagnostics", () => {
    const result: DiagnosticResult = {
      status: "ok",
      diagnostics: [],
      otherFiles: [],
      retryAttempts: 0,
    };

    const output = formatDiagnostics("main.go", result);
    assert.equal(output, "");
  });

  it("returns timeout message for timeout with no diagnostics", () => {
    const result: DiagnosticResult = {
      status: "timeout",
      diagnostics: [],
      otherFiles: [],
      retryAttempts: 0,
    };

    const output = formatDiagnostics("main.go", result);
    assert.ok(output.includes("timed out"));
    assert.ok(output.includes("main.go"));
  });

  it("includes 'timed out, may be incomplete' for timeout with diagnostics", () => {
    const result: DiagnosticResult = {
      status: "timeout",
      diagnostics: [makeDiag(DiagnosticSeverity.Error, "some error")],
      otherFiles: [],
      retryAttempts: 0,
    };

    const output = formatDiagnostics("main.go", result);
    assert.ok(output.includes("timed out, may be incomplete"));
    assert.ok(output.includes("1 error"));
    assert.ok(output.includes("some error"));
  });

  it("shows per-file detail in other-file footer", () => {
    const result: DiagnosticResult = {
      status: "ok",
      diagnostics: [makeDiag(DiagnosticSeverity.Error, "type mismatch")],
      otherFiles: [
        {
          uri: "file:///project/other.go",
          errorCount: 2,
          warningCount: 1,
          firstDiagnostic: { severity: DiagnosticSeverity.Error, line: 4, col: 2, message: "too many arguments", source: "compiler" },
        },
        {
          uri: "file:///project/another.go",
          errorCount: 0,
          warningCount: 3,
          firstDiagnostic: { severity: DiagnosticSeverity.Warning, line: 0, col: 0, message: "unused import", source: "compiler" },
        },
      ],
      retryAttempts: 0,
    };

    const output = formatDiagnostics("main.go", result);
    assert.ok(output.includes("/project/other.go (2 errors, 1 warning): error 5:3 [compiler] too many arguments"), `expected per-file detail in: ${output}`);
    assert.ok(output.includes("/project/another.go (3 warnings): warning 1:1 [compiler] unused import"), `expected per-file detail in: ${output}`);
  });

  it("shows relative paths when cwd is provided", () => {
    const result: DiagnosticResult = {
      status: "ok",
      diagnostics: [],
      otherFiles: [
        {
          uri: "file:///project/src/other.go",
          errorCount: 1,
          warningCount: 0,
          firstDiagnostic: { severity: DiagnosticSeverity.Error, line: 9, col: 4, message: "undefined: bar" },
        },
      ],
      retryAttempts: 0,
    };

    const output = formatDiagnostics("main.go", result, "/project");
    assert.ok(output.includes("src/other.go (1 error): error 10:5 undefined: bar"), `expected relative path in: ${output}`);
  });

  it("shows other-file footer even when main file has no issues", () => {
    const result: DiagnosticResult = {
      status: "ok",
      diagnostics: [],
      otherFiles: [{ uri: "file:///project/other.go", errorCount: 1, warningCount: 0 }],
      retryAttempts: 0,
    };

    const output = formatDiagnostics("main.go", result);
    assert.ok(output.includes("/project/other.go (1 error)"), `expected file path in: ${output}`);
  });

  it("filters out info and hint severity diagnostics", () => {
    const result: DiagnosticResult = {
      status: "ok",
      diagnostics: [
        makeDiag(DiagnosticSeverity.Information, "info message"),
        makeDiag(DiagnosticSeverity.Hint, "hint message"),
      ],
      otherFiles: [],
      retryAttempts: 0,
    };

    const output = formatDiagnostics("main.go", result);
    assert.equal(output, "");
  });

  it("includes retry count in timeout message when retryAttempts > 0", () => {
    const result: DiagnosticResult = {
      status: "timeout",
      diagnostics: [makeDiag(DiagnosticSeverity.Error, "some error")],
      otherFiles: [],
      retryAttempts: 3,
    };

    const output = formatDiagnostics("main.go", result);
    assert.ok(output.includes("after 3 retries"), `expected 'after 3 retries' in: ${output}`);
    assert.ok(output.includes("timed out"));
    assert.ok(output.includes("may be incomplete"));
  });

  it("uses singular 'retry' when retryAttempts is 1", () => {
    const result: DiagnosticResult = {
      status: "timeout",
      diagnostics: [],
      otherFiles: [],
      retryAttempts: 1,
    };

    const output = formatDiagnostics("main.go", result);
    assert.ok(output.includes("after 1 retry"), `expected 'after 1 retry' in: ${output}`);
  });

  it("surfaces unavailable status instead of returning empty", () => {
    const result: DiagnosticResult = {
      status: "unavailable",
      diagnostics: [],
      otherFiles: [],
      retryAttempts: 0,
    };

    const output = formatDiagnostics("main.go", result);
    assert.ok(output.includes("unavailable"), `expected 'unavailable' in: ${output}`);
    assert.ok(output.includes("main.go"), `expected file path in: ${output}`);
    assert.ok(output.includes("server missing or failed to start"), `expected reason in: ${output}`);
  });
});
