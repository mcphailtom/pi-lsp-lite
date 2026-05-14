import {
  createProtocolConnection,
  StreamMessageReader,
  StreamMessageWriter,
  InitializeRequest,
  InitializedNotification,
  DidOpenTextDocumentNotification,
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  ShutdownRequest,
  ExitNotification,
  PublishDiagnosticsNotification,
  DiagnosticSeverity,
  type InitializeParams,
  type Diagnostic,
} from "vscode-languageserver-protocol/node.js";
import type { ChildProcess } from "node:child_process";
import { fileUri } from "./util.js";

export interface OtherFileDiagnostics {
  uri: string;
  errorCount: number;
  warningCount: number;
  firstDiagnostic?: { severity: number; line: number; col: number; message: string; source?: string };
}

export interface DiagnosticResult {
  status: "ok" | "timeout" | "unavailable";
  diagnostics: Diagnostic[];
  otherFiles: OtherFileDiagnostics[];
  retryAttempts: number;
}

export interface LspClient {
  initialize(workspaceRoot: string): Promise<void>;
  didOpen(uri: string, languageId: string, content: string): void;
  didChange(uri: string, content: string): void;
  didClose(uri: string): void;
  waitForDiagnostics(uri: string, timeoutMs: number): Promise<DiagnosticResult>;
  getAllDiagnostics(): Map<string, Diagnostic[]>;
  shutdown(): Promise<void>;
}

const SHUTDOWN_TIMEOUT_MS = 5_000;
const QUIESCENCE_MS = 200;

function countDiagnostics(diags: Diagnostic[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const d of diags) {
    if (d.severity === DiagnosticSeverity.Error) errors++;
    else if (d.severity === DiagnosticSeverity.Warning) warnings++;
  }
  return { errors, warnings };
}

export function createLspClient(child: ChildProcess): LspClient {
  if (!child.stdout || !child.stdin) {
    throw new Error("LSP child process must be spawned with stdio: pipe");
  }

  const connection = createProtocolConnection(
    new StreamMessageReader(child.stdout),
    new StreamMessageWriter(child.stdin),
  );

  interface DiagnosticEntry {
    diagnostics: Diagnostic[];
    generation: number;
    received: boolean;
    resolve?: () => void;
  }

  const diagnosticsMap = new Map<string, DiagnosticEntry>();
  const documentVersion = new Map<string, number>();
  const uriGeneration = new Map<string, number>();
  let crossFileCallback: ((changedUri: string) => void) | null = null;

  connection.onNotification(PublishDiagnosticsNotification.type, (params) => {
    const entry = diagnosticsMap.get(params.uri);
    if (entry) {
      const currentGen = uriGeneration.get(params.uri) ?? 0;
      if (entry.generation !== currentGen) return;
      entry.diagnostics = params.diagnostics;
      entry.received = true;
      entry.resolve?.();
    } else {
      const gen = uriGeneration.get(params.uri) ?? 0;
      diagnosticsMap.set(params.uri, { diagnostics: params.diagnostics, generation: gen, received: true });
    }
    if (crossFileCallback) crossFileCallback(params.uri);
  });

  connection.listen();

  return {
    async initialize(workspaceRoot: string) {
      const params: InitializeParams = {
        processId: child.pid ?? null,
        rootUri: fileUri(workspaceRoot),
        capabilities: {
          textDocument: {
            synchronization: {
              dynamicRegistration: false,
              willSave: false,
              willSaveWaitUntil: false,
              didSave: false,
            },
            publishDiagnostics: {
              relatedInformation: false,
            },
          },
        },
        workspaceFolders: [{ uri: fileUri(workspaceRoot), name: "workspace" }],
      };

      await connection.sendRequest(InitializeRequest.type, params);
      connection.sendNotification(InitializedNotification.type, {});
    },

    didOpen(uri: string, languageId: string, content: string) {
      const gen = (uriGeneration.get(uri) ?? 0) + 1;
      uriGeneration.set(uri, gen);
      documentVersion.set(uri, 1);
      diagnosticsMap.set(uri, { diagnostics: [], generation: gen, received: false });
      connection.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: { uri, languageId, version: 1, text: content },
      });
    },

    didChange(uri: string, content: string) {
      const version = (documentVersion.get(uri) ?? 1) + 1;
      const gen = (uriGeneration.get(uri) ?? 0) + 1;
      uriGeneration.set(uri, gen);
      documentVersion.set(uri, version);
      diagnosticsMap.set(uri, { diagnostics: [], generation: gen, received: false });
      connection.sendNotification(DidChangeTextDocumentNotification.type, {
        textDocument: { uri, version },
        contentChanges: [{ text: content }],
      });
    },

    didClose(uri: string) {
      const gen = (uriGeneration.get(uri) ?? 0) + 1;
      uriGeneration.set(uri, gen);
      connection.sendNotification(DidCloseTextDocumentNotification.type, {
        textDocument: { uri },
      });
      diagnosticsMap.delete(uri);
      documentVersion.delete(uri);
    },

    async waitForDiagnostics(uri: string, timeoutMs: number): Promise<DiagnosticResult> {
      const targetGen = uriGeneration.get(uri) ?? 0;

      const preSnapshot = new Map<string, { errors: number; warnings: number }>();
      for (const [trackedUri, entry] of diagnosticsMap) {
        if (trackedUri !== uri) {
          preSnapshot.set(trackedUri, countDiagnostics(entry.diagnostics));
        }
      }

      const collectOtherFiles = (): OtherFileDiagnostics[] => {
        const result: OtherFileDiagnostics[] = [];
        for (const [trackedUri, entry] of diagnosticsMap) {
          if (trackedUri === uri) continue;
          const post = countDiagnostics(entry.diagnostics);
          const pre = preSnapshot.get(trackedUri) ?? { errors: 0, warnings: 0 };
          const newErrors = post.errors - pre.errors;
          const newWarnings = post.warnings - pre.warnings;
          if (newErrors > 0 || newWarnings > 0) {
            const first =
              entry.diagnostics.find((d) => d.severity === DiagnosticSeverity.Error) ??
              entry.diagnostics.find((d) => d.severity === DiagnosticSeverity.Warning);
            result.push({
              uri: trackedUri,
              errorCount: newErrors,
              warningCount: newWarnings,
              ...(first && {
                firstDiagnostic: {
                  severity: first.severity ?? DiagnosticSeverity.Error,
                  line: first.range.start.line,
                  col: first.range.start.character,
                  message: first.message,
                  ...(first.source && { source: first.source }),
                },
              }),
            });
          }
        }
        return result;
      };

      return new Promise<DiagnosticResult>((resolve) => {
        let settled = false;
        let quiescenceTimer: ReturnType<typeof setTimeout> | null = null;

        const settle = (status: "ok" | "timeout") => {
          if (settled) return;
          settled = true;
          crossFileCallback = null;
          if (quiescenceTimer) clearTimeout(quiescenceTimer);
          resolve({
            status,
            diagnostics: diagnosticsMap.get(uri)?.diagnostics ?? [],
            otherFiles: collectOtherFiles(),
            retryAttempts: 0,
          });
        };

        const resetQuiescence = () => {
          if (settled) return;
          if (quiescenceTimer) clearTimeout(quiescenceTimer);
          quiescenceTimer = setTimeout(() => settle("ok"), QUIESCENCE_MS);
        };

        const timeout = setTimeout(() => {
          settle("timeout");
        }, timeoutMs);

        const entry = diagnosticsMap.get(uri) ?? { diagnostics: [], generation: targetGen, received: false };

        entry.resolve = () => {
          clearTimeout(timeout);
          resetQuiescence();
        };
        diagnosticsMap.set(uri, entry);

        // when a non-target URI publishes diagnostics that differ from the
        // pre-snapshot, start quiescence — this catches the case where the
        // edited file is valid but dependents break
        crossFileCallback = (changedUri: string) => {
          if (settled || changedUri === uri) return;
          const pre = preSnapshot.get(changedUri) ?? { errors: 0, warnings: 0 };
          const post = countDiagnostics(diagnosticsMap.get(changedUri)?.diagnostics ?? []);
          if (post.errors !== pre.errors || post.warnings !== pre.warnings) {
            clearTimeout(timeout);
            resetQuiescence();
          }
        };

        if (entry.received) {
          clearTimeout(timeout);
          resetQuiescence();
        }
      });
    },

    getAllDiagnostics(): Map<string, Diagnostic[]> {
      const result = new Map<string, Diagnostic[]>();
      for (const [uri, entry] of diagnosticsMap) {
        if (entry.diagnostics.length > 0) {
          result.set(uri, [...entry.diagnostics]);
        }
      }
      return result;
    },

    async shutdown() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          connection.sendRequest(ShutdownRequest.type),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("shutdown timed out")), SHUTDOWN_TIMEOUT_MS);
          }),
        ]);
        connection.sendNotification(ExitNotification.type);
      } catch {
        // timed out or server already exited
      } finally {
        if (timer) clearTimeout(timer);
      }
      connection.dispose();
    },
  };
}
