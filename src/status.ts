import type { UserConfig } from "./config.js";
import type { InstallEntry } from "./install-registry.js";
import type { LanguageServerConfig } from "./languages.js";
import type { ServerStatus } from "./server-manager.js";

export interface ServerState {
  id: string;
  command: string | null;
  enabled: boolean;
  installed: boolean | null;
  installable: boolean;
  running: ServerStatus[];
}

export interface BuildServerStatesOptions {
  builtins: LanguageServerConfig[];
  active: LanguageServerConfig[];
  globalConfig: UserConfig | null;
  running: ServerStatus[];
  installRegistry: Map<string, InstallEntry>;
  resolveCommand(command: string): Promise<string | null>;
}

const RESERVED_SERVER_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function globalServerIds(globalConfig: UserConfig | null): string[] {
  const servers = globalConfig?.servers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return [];
  return Object.keys(servers).filter((id) => !RESERVED_SERVER_KEYS.has(id));
}

function commandFor(id: string, active: Map<string, LanguageServerConfig>, builtins: Map<string, LanguageServerConfig>, globalConfig: UserConfig | null): string | null {
  const activeConfig = active.get(id);
  if (activeConfig) return activeConfig.command;

  const builtin = builtins.get(id);
  if (builtin) return builtin.command;

  const globalCommand = globalConfig?.servers?.[id]?.command;
  return typeof globalCommand === "string" && globalCommand.length > 0 ? globalCommand : null;
}

export async function buildServerStates(options: BuildServerStatesOptions): Promise<ServerState[]> {
  const active = new Map(options.active.map((server) => [server.id, server]));
  const builtins = new Map(options.builtins.map((server) => [server.id, server]));
  const runningById = new Map<string, ServerStatus[]>();

  for (const status of options.running) {
    const entries = runningById.get(status.id) ?? [];
    entries.push(status);
    runningById.set(status.id, entries);
  }

  const ids = new Set<string>([
    ...builtins.keys(),
    ...active.keys(),
    ...globalServerIds(options.globalConfig),
  ]);

  const states = await Promise.all([...ids].sort().map(async (id): Promise<ServerState> => {
    const command = commandFor(id, active, builtins, options.globalConfig);
    const installed = command ? (await options.resolveCommand(command)) !== null : null;
    return {
      id,
      command,
      enabled: active.has(id),
      installed,
      installable: options.installRegistry.has(id),
      running: runningById.get(id) ?? [],
    };
  }));

  return states;
}

export function formatServerStates(states: ServerState[]): string {
  if (states.length === 0) return "pi-lsp-lite: no servers configured";

  return states.map((state) => {
    const enabled = state.enabled ? "enabled" : "disabled";
    const installed = state.installed === null ? "unknown" : state.installed ? "installed" : "missing";
    const installHint = state.installed === false
      ? state.installable ? "installable via /lsp-install" : "manual install required"
      : "";
    const running = state.running.length > 0
      ? state.running.map((s) => {
        const idle = Math.round((Date.now() - s.lastActivity) / 1000);
        const up = Math.round(s.uptime / 1000);
        return `running pid=${s.pid} root=${s.root} open=${s.openDocuments} up=${up}s idle=${idle}s`;
      }).join("; ")
      : "not running";
    const command = state.command ? `cmd=${state.command}` : "cmd=unknown";
    return [state.id, enabled, installed, running, command, installHint].filter(Boolean).join(" — ");
  }).join("\n");
}
