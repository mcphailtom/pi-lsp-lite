import { DiagnosticSeverity } from "vscode-languageserver-protocol";
import type { DiagnosticResult } from "./client.js";

export function formatDiagnostics(filePath: string, result: DiagnosticResult): string {
  const relevant = result.diagnostics.filter(
    (d) => d.severity === DiagnosticSeverity.Error || d.severity === DiagnosticSeverity.Warning,
  );

  if (relevant.length === 0 && result.status === "ok" && result.otherFiles.length === 0) return "";
  if (result.status === "unavailable") return "";

  const retryNote = result.status === "timeout" && result.retryAttempts > 0
    ? ` after ${result.retryAttempts} ${result.retryAttempts === 1 ? "retry" : "retries"}`
    : "";

  if (relevant.length === 0 && result.status === "ok" && result.otherFiles.length > 0) {
    return `\n⚠ LSP diagnostics for ${filePath}: no issues${otherFilesFooter(result)}`;
  }

  const lines = relevant.map((d) => {
    const severity = d.severity === DiagnosticSeverity.Error ? "error" : "warning";
    const line = d.range.start.line + 1;
    const col = d.range.start.character + 1;
    const source = d.source ? `[${d.source}] ` : "";
    return `  ${severity} ${line}:${col} ${source}${d.message}`;
  });

  const errorCount = relevant.filter((d) => d.severity === DiagnosticSeverity.Error).length;
  const warnCount = relevant.length - errorCount;

  const summary = [
    errorCount > 0 ? `${errorCount} error${errorCount > 1 ? "s" : ""}` : "",
    warnCount > 0 ? `${warnCount} warning${warnCount > 1 ? "s" : ""}` : "",
    result.status === "timeout" ? `timed out${retryNote}, may be incomplete` : "",
  ]
    .filter(Boolean)
    .join(", ");

  return `\n⚠ LSP diagnostics for ${filePath} (${summary}):\n${lines.join("\n")}${otherFilesFooter(result)}`;
}

function otherFilesFooter(result: DiagnosticResult): string {
  if (result.otherFiles.length === 0) return "";
  const totalDiags = result.otherFiles.reduce((sum, f) => sum + f.errorCount + f.warningCount, 0);
  const fileCount = result.otherFiles.length;
  return `\n  + ${totalDiags} diagnostic${totalDiags !== 1 ? "s" : ""} in ${fileCount} other file${fileCount !== 1 ? "s" : ""}`;
}
