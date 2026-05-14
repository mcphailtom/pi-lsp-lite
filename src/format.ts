import { DiagnosticSeverity } from "vscode-languageserver-protocol";
import { fileURLToPath } from "node:url";
import { relative } from "node:path";
import type { DiagnosticResult } from "./client.js";

export function formatDiagnostics(filePath: string, result: DiagnosticResult, cwd?: string): string {
  const relevant = result.diagnostics.filter(
    (d) => d.severity === DiagnosticSeverity.Error || d.severity === DiagnosticSeverity.Warning,
  );

  if (relevant.length === 0 && result.status === "ok" && result.otherFiles.length === 0) return "";

  if (result.status === "unavailable") {
    return `\n⚠ LSP diagnostics unavailable for ${filePath} (server missing or failed to start)`;
  }

  const retryNote = result.status === "timeout" && result.retryAttempts > 0
    ? ` after ${result.retryAttempts} ${result.retryAttempts === 1 ? "retry" : "retries"}`
    : "";

  if (relevant.length === 0 && result.status === "ok" && result.otherFiles.length > 0) {
    return `\n⚠ LSP diagnostics for ${filePath}: no issues${otherFilesFooter(result, cwd)}`;
  }

  const lines = relevant.map((d) => {
    const severity = d.severity === DiagnosticSeverity.Error ? "error" : "warning";
    const line = d.range.start.line + 1;
    const col = d.range.start.character + 1;
    const source = d.source ? `[${d.source}] ` : "";
    return `  ${severity} ${line}:${col} ${source}${d.message}`;
  });

  let errorCount = 0;
  for (const d of relevant) {
    if (d.severity === DiagnosticSeverity.Error) errorCount++;
  }
  const warnCount = relevant.length - errorCount;

  const summary = [
    errorCount > 0 ? `${errorCount} error${errorCount > 1 ? "s" : ""}` : "",
    warnCount > 0 ? `${warnCount} warning${warnCount > 1 ? "s" : ""}` : "",
    result.status === "timeout" ? `timed out${retryNote}, may be incomplete` : "",
  ]
    .filter(Boolean)
    .join(", ");

  return `\n⚠ LSP diagnostics for ${filePath} (${summary}):\n${lines.join("\n")}${otherFilesFooter(result, cwd)}`;
}

function otherFilesFooter(result: DiagnosticResult, cwd?: string): string {
  if (result.otherFiles.length === 0) return "";
  const lines = result.otherFiles.map((f) => {
    let path: string;
    try {
      const abs = fileURLToPath(f.uri);
      path = cwd ? relative(cwd, abs) : abs;
    } catch {
      path = f.uri;
    }
    const counts = [
      f.errorCount > 0 ? `${f.errorCount} error${f.errorCount > 1 ? "s" : ""}` : "",
      f.warningCount > 0 ? `${f.warningCount} warning${f.warningCount > 1 ? "s" : ""}` : "",
    ].filter(Boolean).join(", ");
    if (!f.firstDiagnostic) return `  ${path} (${counts})`;
    const d = f.firstDiagnostic;
    const sev = d.severity === DiagnosticSeverity.Error ? "error" : "warning";
    const src = d.source ? `[${d.source}] ` : "";
    return `  ${path} (${counts}): ${sev} ${d.line + 1}:${d.col + 1} ${src}${d.message}`;
  });
  return `\n${lines.join("\n")}`;
}
