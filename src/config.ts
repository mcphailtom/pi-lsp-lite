import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { type LanguageServerConfig, builtinLanguages } from "./languages.js";

export interface ServerConfigOverride {
  extensions?: string[];
  command?: string;
  args?: string[];
  rootPatterns?: string[];
  diagnosticTimeout?: number;
  disabled?: boolean;
}

export interface UserConfig {
  servers?: Record<string, ServerConfigOverride>;
  diagnosticTimeout?: number;
  documentIdleTimeout?: number;
}

export interface ResolvedConfig {
  servers: LanguageServerConfig[];
  diagnosticTimeout: number;
  documentIdleTimeout: number;
  perServerTimeout: Map<string, number>;
}

export const DEFAULT_DIAGNOSTIC_TIMEOUT = 5_000;
export const DEFAULT_DOCUMENT_IDLE_TIMEOUT = 120_000;

const MIN_DIAGNOSTIC_TIMEOUT = 1_000;
const MAX_DIAGNOSTIC_TIMEOUT = 60_000;
const MIN_DOCUMENT_IDLE_TIMEOUT = 10_000;
const MAX_DOCUMENT_IDLE_TIMEOUT = 600_000;

function clampTimeout(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((item) => typeof item === "string");
}

function validateOverride(id: string, raw: unknown): ServerConfigOverride | null {
  if (!isPlainObject(raw)) return null;

  const override: ServerConfigOverride = {};

  if (raw.disabled === true) {
    override.disabled = true;
    return override;
  }

  if (raw.extensions !== undefined) {
    if (!isStringArray(raw.extensions) || raw.extensions.length === 0) {
      console.error(`[pi-lsp-lite] config "${id}": extensions must be a non-empty string array, skipping`);
      return null;
    }
    override.extensions = (raw.extensions as string[]).map((e) => e.toLowerCase());
  }

  if (raw.command !== undefined) {
    if (typeof raw.command !== "string" || raw.command.length === 0) {
      console.error(`[pi-lsp-lite] config "${id}": command must be a non-empty string, skipping`);
      return null;
    }
    override.command = raw.command as string;
  }

  if (raw.args !== undefined) {
    if (!isStringArray(raw.args)) {
      console.error(`[pi-lsp-lite] config "${id}": args must be a string array, skipping`);
      return null;
    }
    override.args = raw.args as string[];
  }

  if (raw.rootPatterns !== undefined) {
    if (!isStringArray(raw.rootPatterns)) {
      console.error(`[pi-lsp-lite] config "${id}": rootPatterns must be a string array, skipping`);
      return null;
    }
    override.rootPatterns = raw.rootPatterns as string[];
  }

  if (raw.diagnosticTimeout !== undefined) {
    override.diagnosticTimeout = clampTimeout(
      raw.diagnosticTimeout,
      MIN_DIAGNOSTIC_TIMEOUT,
      MAX_DIAGNOSTIC_TIMEOUT,
      DEFAULT_DIAGNOSTIC_TIMEOUT,
    );
  }

  return override;
}

async function readConfigFile(path: string): Promise<UserConfig | null> {
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return null;
    console.error(`[pi-lsp-lite] failed to read config ${path}:`, err);
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(content);
    if (!isPlainObject(parsed)) {
      console.error(`[pi-lsp-lite] config ${path}: expected a JSON object, skipping`);
      return null;
    }
    return parsed as UserConfig;
  } catch (err) {
    console.error(`[pi-lsp-lite] config ${path}: invalid JSON, skipping:`, err);
    return null;
  }
}

async function findProjectConfig(cwd: string): Promise<UserConfig | null> {
  for (const candidate of [
    join(cwd, ".pi-lsp-lite.json"),
    join(cwd, ".pi", "lsp-lite.json"),
  ]) {
    const config = await readConfigFile(candidate);
    if (config) return config;
  }
  return null;
}

type ConfigSource = "global" | "project";

function mergeConfigs(
  base: LanguageServerConfig[],
  overrides: Record<string, ServerConfigOverride>,
  source: ConfigSource,
): LanguageServerConfig[] {
  const result = new Map<string, LanguageServerConfig>();

  for (const server of base) {
    result.set(server.id, { ...server });
  }

  for (const [id, rawOverride] of Object.entries(overrides)) {
    const override = validateOverride(id, rawOverride);
    if (!override) continue;

    if (override.disabled) {
      result.delete(id);
      continue;
    }

    const existing = result.get(id);
    if (existing) {
      const { disabled: _, diagnosticTimeout: __, ...lspFields } = override;
      const defined = Object.fromEntries(
        Object.entries(lspFields).filter(([, v]) => v !== undefined),
      );
      result.set(id, { ...existing, ...defined });
    } else {
      if (source === "project") {
        console.error(`[pi-lsp-lite] project config cannot define new server "${id}" — only global config (~/.pi-lsp-lite.json) can add servers`);
        continue;
      }
      if (!override.command || !override.extensions) {
        console.error(`[pi-lsp-lite] config "${id}" must have at least "command" and "extensions" to define a new server, skipping`);
        continue;
      }
      result.set(id, {
        id,
        extensions: override.extensions,
        command: override.command,
        args: override.args ?? [],
        rootPatterns: override.rootPatterns ?? [],
      });
    }
  }

  return Array.from(result.values());
}

export async function loadConfig(cwd: string, globalConfigPath?: string): Promise<ResolvedConfig> {
  const globalConfig = await readConfigFile(globalConfigPath ?? join(homedir(), ".pi-lsp-lite.json"));
  const projectConfig = await findProjectConfig(cwd);

  let servers = [...builtinLanguages];
  const perServerTimeout = new Map<string, number>();
  let diagnosticTimeout = DEFAULT_DIAGNOSTIC_TIMEOUT;
  let documentIdleTimeout = DEFAULT_DOCUMENT_IDLE_TIMEOUT;

  const layers: [UserConfig | null, ConfigSource][] = [
    [globalConfig, "global"],
    [projectConfig, "project"],
  ];

  for (const [layer, source] of layers) {
    if (!layer) continue;
    if (layer.servers && isPlainObject(layer.servers)) {
      servers = mergeConfigs(servers, layer.servers as Record<string, ServerConfigOverride>, source);
      for (const [id, rawOverride] of Object.entries(layer.servers)) {
        const override = validateOverride(id, rawOverride);
        if (override?.diagnosticTimeout !== undefined) {
          perServerTimeout.set(id, override.diagnosticTimeout);
        }
      }
    }
    if (layer.diagnosticTimeout !== undefined) {
      diagnosticTimeout = clampTimeout(layer.diagnosticTimeout, MIN_DIAGNOSTIC_TIMEOUT, MAX_DIAGNOSTIC_TIMEOUT, diagnosticTimeout);
    }
    if (layer.documentIdleTimeout !== undefined) {
      documentIdleTimeout = clampTimeout(layer.documentIdleTimeout, MIN_DOCUMENT_IDLE_TIMEOUT, MAX_DOCUMENT_IDLE_TIMEOUT, documentIdleTimeout);
    }
  }

  return { servers, diagnosticTimeout, documentIdleTimeout, perServerTimeout };
}
