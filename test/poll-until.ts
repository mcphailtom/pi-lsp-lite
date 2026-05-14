import type { DiagnosticResult } from "../src/client.js";

export async function pollUntil(
  fn: () => Promise<DiagnosticResult>,
  predicate: (r: DiagnosticResult) => boolean,
  { maxAttempts = 15, delayMs = 200 } = {},
): Promise<DiagnosticResult> {
  let result: DiagnosticResult | undefined;
  for (let i = 0; i < maxAttempts; i++) {
    result = await fn();
    if (predicate(result)) break;
    if (i < maxAttempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  if (!result) throw new Error("pollUntil: maxAttempts must be >= 1");
  return result;
}
