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
  type Diagnostic,
  type InitializeResult,
  type TextDocumentSyncKind,
} from "vscode-languageserver-protocol/node";

export interface FakeServerOptions {
  diagnosticDelay?: number;
  diagnosticsByUri?: Map<string, Diagnostic[]>;
  otherFileDiagnostics?: Map<string, Diagnostic[]>;
  crashOnInit?: boolean;
  neverPublish?: boolean;
  neverShutdown?: boolean;
  publishOnAttempt?: number;
}

const defaultDiagnostic: Diagnostic = {
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
  severity: DiagnosticSeverity.Error,
  message: "fake error",
  source: "fake",
};

export function startFakeServer(options: FakeServerOptions = {}) {
  const delay = options.diagnosticDelay ?? 0;
  const crashOnInit = options.crashOnInit ?? false;
  const neverPublish = options.neverPublish ?? false;
  const neverShutdown = options.neverShutdown ?? false;
  const publishOnAttempt = options.publishOnAttempt ?? 1;
  const attemptCounts = new Map<string, number>();

  const connection = createProtocolConnection(
    new StreamMessageReader(process.stdin),
    new StreamMessageWriter(process.stdout),
  );

  connection.onRequest(InitializeRequest.type, (_params) => {
    if (crashOnInit) {
      process.exit(1);
    }
    const result: InitializeResult = {
      capabilities: {
        textDocumentSync: 1 as TextDocumentSyncKind,
        diagnosticProvider: undefined,
      },
    };
    return result;
  });

  connection.onNotification(InitializedNotification.type, () => {});

  function publishDiagnostics(uri: string) {
    if (neverPublish) return;

    const count = (attemptCounts.get(uri) ?? 0) + 1;
    attemptCounts.set(uri, count);

    if (count < publishOnAttempt) return;

    const diags = options.diagnosticsByUri?.get(uri) ?? [defaultDiagnostic];

    const publish = () => {
      connection.sendNotification(PublishDiagnosticsNotification.type, {
        uri,
        diagnostics: diags,
      });

      if (options.otherFileDiagnostics) {
        for (const [otherUri, otherDiags] of options.otherFileDiagnostics) {
          if (otherUri === uri) continue;
          connection.sendNotification(PublishDiagnosticsNotification.type, {
            uri: otherUri,
            diagnostics: otherDiags,
          });
        }
      }
    };

    if (delay > 0) {
      setTimeout(publish, delay);
    } else {
      publish();
    }
  }

  connection.onNotification(DidOpenTextDocumentNotification.type, (params) => {
    publishDiagnostics(params.textDocument.uri);
  });

  connection.onNotification(DidChangeTextDocumentNotification.type, (params) => {
    publishDiagnostics(params.textDocument.uri);
  });

  connection.onNotification(DidCloseTextDocumentNotification.type, () => {});

  connection.onRequest(ShutdownRequest.type, () => {
    if (neverShutdown) return new Promise<void>(() => {});
    return undefined;
  });
  connection.onNotification(ExitNotification.type, () => {
    process.exit(0);
  });

  connection.listen();
}

if (process.argv.includes("--run")) {
  const optionsJson = process.argv.find((a) => a.startsWith("--options="));
  let options: FakeServerOptions = {};
  if (optionsJson) {
    const raw = JSON.parse(optionsJson.slice("--options=".length));
    if (raw.diagnosticDelay) options.diagnosticDelay = raw.diagnosticDelay;
    if (raw.crashOnInit) options.crashOnInit = raw.crashOnInit;
    if (raw.neverPublish) options.neverPublish = raw.neverPublish;
    if (raw.neverShutdown) options.neverShutdown = raw.neverShutdown;
    if (raw.publishOnAttempt !== undefined) options.publishOnAttempt = raw.publishOnAttempt;
    if (raw.diagnosticsByUri) {
      options.diagnosticsByUri = new Map(Object.entries(raw.diagnosticsByUri));
    }
    if (raw.otherFileDiagnostics) {
      options.otherFileDiagnostics = new Map(Object.entries(raw.otherFileDiagnostics));
    }
  }
  startFakeServer(options);
}
