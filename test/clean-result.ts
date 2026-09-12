import type { DiagnosticResult } from "../src/client.js";

export function isCleanResult(result: DiagnosticResult): boolean {
  return result.status === "ok" && !result.diagnostics.some((d) => d.severity === 1);
}
