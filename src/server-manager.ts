import { spawn, type ChildProcess } from "node:child_process";
import { which, fileUri, findWorkspaceRoot } from "./util.js";
import { createLspClient, type LspClient, type DiagnosticResult } from "./client.js";
import type { LanguageServerConfig } from "./languages.js";
import type { Diagnostic } from "vscode-languageserver-protocol";
import { DEFAULT_DIAGNOSTIC_TIMEOUT, DEFAULT_DOCUMENT_IDLE_TIMEOUT, DEFAULT_MAX_RETRIES } from "./config.js";
import { readFile } from "node:fs/promises";

interface ManagedServer {
  config: LanguageServerConfig;
  serverKey: string;
  root: string;
  process: ChildProcess;
  client: LspClient;
  openDocuments: Map<string, number>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  startTime: number;
  lastActivity: number;
  editQueue: Promise<DiagnosticResult>;
}

export interface ServerManager {
  handleEdit(filePath: string, config: LanguageServerConfig, cwd: string): Promise<DiagnosticResult>;
  status(): ServerStatus[];
  getAllDiagnostics(): Map<string, Diagnostic[]>;
  shutdownAll(): Promise<void>;
}

export interface ServerStatus {
  id: string;
  root: string;
  pid: number;
  uptime: number;
  openDocuments: number;
  lastActivity: number;
}

const IDLE_TIMEOUT_MS = 240_000;
const INIT_TIMEOUT_MS = 10_000;
const SWEEP_INTERVAL_MS = 60_000;

export interface ServerManagerOptions {
  diagnosticTimeout?: number;
  documentIdleTimeout?: number;
  perServerTimeout?: Map<string, number>;
  maxRetries?: number;
}

const RETRY_BASE_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 30_000;

export function createServerManager(options: ServerManagerOptions = {}): ServerManager {
  const diagnosticTimeout = options.diagnosticTimeout ?? DEFAULT_DIAGNOSTIC_TIMEOUT;
  const documentIdleTimeout = options.documentIdleTimeout ?? DEFAULT_DOCUMENT_IDLE_TIMEOUT;
  const perServerTimeout = options.perServerTimeout ?? new Map();
  const defaultMaxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const servers = new Map<string, ManagedServer>();
  const pending = new Map<string, Promise<ManagedServer | null>>();
  const disabledBinaries = new Set<string>();
  const failedRoots = new Set<string>();
  let sweepTimer: ReturnType<typeof setInterval> | null = null;

  function startSweepTimer() {
    if (sweepTimer) return;
    sweepTimer = setInterval(() => {
      const now = Date.now();
      for (const server of servers.values()) {
        const stale = [...server.openDocuments.entries()]
          .filter(([, lastActive]) => now - lastActive > documentIdleTimeout);
        for (const [docUri] of stale) {
          server.client.didClose(docUri);
          server.openDocuments.delete(docUri);
        }
      }
    }, SWEEP_INTERVAL_MS);
    sweepTimer.unref();
  }

  function stopSweepTimer() {
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }

  function resetIdleTimer(server: ManagedServer) {
    if (server.idleTimer) clearTimeout(server.idleTimer);
    server.lastActivity = Date.now();
    server.idleTimer = setTimeout(() => shutdownServer(server), IDLE_TIMEOUT_MS);
  }

  async function killProcess(proc: ChildProcess): Promise<void> {
    if (proc.exitCode !== null) return;
    proc.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (proc.exitCode !== null) {
        resolve();
        return;
      }
      const killTimer = setTimeout(() => {
        proc.kill("SIGKILL");
      }, 2000);
      proc.once("exit", () => {
        clearTimeout(killTimer);
        resolve();
      });
    });
  }

  async function shutdownServer(server: ManagedServer) {
    if (server.idleTimer) clearTimeout(server.idleTimer);
    await server.client.shutdown();
    await killProcess(server.process);
    if (servers.get(server.serverKey) === server) {
      servers.delete(server.serverKey);
    }
    if (servers.size === 0) stopSweepTimer();
  }

  async function spawnServer(config: LanguageServerConfig, root: string, serverKey: string): Promise<ManagedServer | null> {
    if (disabledBinaries.has(config.id)) return null;
    if (failedRoots.has(serverKey)) return null;

    const binaryPath = await which(config.command);
    if (!binaryPath) {
      console.error(`[pi-lsp-lite:${config.id}] ${config.command} not found on PATH, disabling ${config.id}`);
      disabledBinaries.add(config.id);
      return null;
    }

    const child = spawn(binaryPath, config.args, {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      console.error(`[pi-lsp-lite:${config.id}:${root}]`, chunk.toString().trimEnd());
    });

    child.on("error", (err) => {
      console.error(`[pi-lsp-lite:${config.id}:${root}] process error:`, err);
    });

    const client = createLspClient(child);

    let initTimer: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      initTimer = setTimeout(() => reject(new Error("LSP initialize timed out")), INIT_TIMEOUT_MS);
    });

    try {
      await Promise.race([client.initialize(root), timeoutPromise]);
      clearTimeout(initTimer!);
    } catch (err) {
      clearTimeout(initTimer!);
      console.error(`[pi-lsp-lite:${config.id}:${root}] failed to initialize:`, err);
      await killProcess(child);
      client.shutdown().catch(() => {});
      failedRoots.add(serverKey);
      return null;
    }

    const now = Date.now();
    const server: ManagedServer = {
      config,
      serverKey,
      root,
      process: child,
      client,
      openDocuments: new Map(),
      idleTimer: null,
      startTime: now,
      lastActivity: now,
      editQueue: Promise.resolve({ status: "ok", diagnostics: [], otherFiles: [], retryAttempts: 0 }),
    };

    child.on("exit", () => {
      if (server.idleTimer) clearTimeout(server.idleTimer);
      if (servers.get(serverKey) === server) {
        servers.delete(serverKey);
      }
      if (servers.size === 0) stopSweepTimer();
    });

    resetIdleTimer(server);
    servers.set(serverKey, server);
    startSweepTimer();
    return server;
  }

  async function ensureServer(config: LanguageServerConfig, root: string): Promise<ManagedServer | null> {
    const serverKey = `${config.id}:${root}`;
    const existing = servers.get(serverKey);
    if (existing) return existing;

    if (disabledBinaries.has(config.id)) return null;
    if (failedRoots.has(serverKey)) return null;

    const inflight = pending.get(serverKey);
    if (inflight) return inflight;

    const promise = spawnServer(config, root, serverKey).finally(() => pending.delete(serverKey));
    pending.set(serverKey, promise);
    return promise;
  }

  function getMaxRetries(config: LanguageServerConfig): number {
    const raw = config.maxRetries ?? defaultMaxRetries;
    if (typeof raw !== "number" || !Number.isFinite(raw)) return defaultMaxRetries;
    return Math.max(0, Math.min(10, Math.floor(raw)));
  }

  async function doEdit(server: ManagedServer, filePath: string): Promise<DiagnosticResult> {
    resetIdleTimer(server);

    const uri = fileUri(filePath);
    const content = await readFile(filePath, "utf-8");
    const timeout = perServerTimeout.get(server.config.id) ?? server.config.diagnosticTimeout ?? diagnosticTimeout;
    const retries = getMaxRetries(server.config);

    if (server.openDocuments.has(uri)) {
      server.client.didChange(uri, content);
    } else {
      server.client.didOpen(uri, server.config.id, content);
    }
    server.openDocuments.set(uri, Date.now());

    let lastResult = await server.client.waitForDiagnostics(uri, timeout);

    for (let attempt = 0; attempt < retries && lastResult.status === "timeout"; attempt++) {
      resetIdleTimer(server);
      const baseDelay = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS);
      const jitter = baseDelay * Math.random() * 0.5;
      await new Promise((resolve) => setTimeout(resolve, baseDelay + jitter));

      server.client.didChange(uri, content);
      server.openDocuments.set(uri, Date.now());
      const result = await server.client.waitForDiagnostics(uri, timeout);
      result.retryAttempts = attempt + 1;

      if (result.status === "ok") {
        return result;
      }
      lastResult = result;
    }

    return lastResult;
  }

  return {
    async handleEdit(filePath: string, config: LanguageServerConfig, cwd: string): Promise<DiagnosticResult> {
      const root = await findWorkspaceRoot(filePath, config.rootPatterns, cwd);
      const server = await ensureServer(config, root);
      if (!server) return { status: "unavailable" as const, diagnostics: [], otherFiles: [], retryAttempts: 0 };

      // serialize edits per server to avoid concurrent waitForDiagnostics races
      const result = server.editQueue.then(
        () => doEdit(server, filePath),
        () => doEdit(server, filePath),
      );
      server.editQueue = result;
      return result;
    },

    status(): ServerStatus[] {
      return Array.from(servers.values()).map((s) => ({
        id: s.config.id,
        root: s.root,
        pid: s.process.pid ?? 0,
        uptime: Date.now() - s.startTime,
        openDocuments: s.openDocuments.size,
        lastActivity: s.lastActivity,
      }));
    },

    getAllDiagnostics(): Map<string, Diagnostic[]> {
      const result = new Map<string, Diagnostic[]>();
      for (const server of servers.values()) {
        for (const [uri, diags] of server.client.getAllDiagnostics()) {
          result.set(uri, diags);
        }
      }
      return result;
    },

    async shutdownAll() {
      stopSweepTimer();
      const shutdowns = Array.from(servers.values()).map((s) => shutdownServer(s));
      await Promise.allSettled(shutdowns);
    },
  };
}
