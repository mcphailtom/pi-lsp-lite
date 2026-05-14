import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createServerManager } from "./src/server-manager.js";
import { languageForFile, checkExtensionOverlaps, builtinLanguages, type LanguageServerConfig } from "./src/languages.js";
import { formatDiagnostics } from "./src/format.js";
import { DiagnosticSeverity } from "vscode-languageserver-protocol";
import { loadConfig, writeGlobalConfig, readGlobalConfig } from "./src/config.js";
import { fileUri, which } from "./src/util.js";
import { installRegistry } from "./src/install-registry.js";
import { resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export default function (pi: ExtensionAPI) {
  let servers: LanguageServerConfig[] = [];
  let manager = createServerManager({});

  async function initConfig(cwd: string) {
    await manager.shutdownAll();
    const resolved = await loadConfig(cwd);
    servers = resolved.servers;
    manager = createServerManager({
      diagnosticTimeout: resolved.diagnosticTimeout,
      documentIdleTimeout: resolved.documentIdleTimeout,
      perServerTimeout: resolved.perServerTimeout,
    });

    for (const warning of checkExtensionOverlaps(servers)) {
      console.error(`[pi-lsp-lite] ${warning}`);
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    await initConfig(ctx.cwd);
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return;

    const rawPath = event.input?.path;
    const filePath = typeof rawPath === "string" ? rawPath : undefined;
    if (!filePath) return;
    if (event.isError) return;

    const absolutePath = resolve(ctx.cwd, filePath);
    const rel = relative(ctx.cwd, absolutePath);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return;
    const langConfig = languageForFile(absolutePath, servers);
    if (!langConfig) return;

    try {
      const result = await manager.handleEdit(absolutePath, langConfig, ctx.cwd);
      const formatted = formatDiagnostics(filePath, result, ctx.cwd);
      if (!formatted) return;

      ctx.ui.notify(formatted.trim(), "warning");

      return {
        content: [...event.content, { type: "text" as const, text: formatted }],
      };
    } catch (err) {
      console.error("[pi-lsp-lite]", err);
    }
  });

  pi.on("session_shutdown", async () => {
    await manager.shutdownAll();
  });

  pi.registerCommand("lsp-status", {
    description: "Show running LSP servers and recent diagnostic counts",
    handler: async (_args, ctx) => {
      const running = manager.status();
      if (running.length === 0) {
        ctx.ui.notify("pi-lsp-lite: no servers running", "info");
        return;
      }
      const lines = running.map((s) => {
        const idle = Math.round((Date.now() - s.lastActivity) / 1000);
        const up = Math.round(s.uptime / 1000);
        return `${s.id} (pid ${s.pid}) root=${s.root} — ${s.openDocuments} open files, up ${up}s, idle ${idle}s`;
      });
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("lsp-diag", {
    description: "Show current LSP diagnostics for all tracked files (or a specific file)",
    handler: async (args, ctx) => {
      const allDiags = manager.getAllDiagnostics();

      if (allDiags.size === 0) {
        ctx.ui.notify("pi-lsp-lite: no diagnostics", "info");
        return;
      }

      const filterPath = args?.trim();
      let filterUri: string | undefined;
      if (filterPath) {
        const abs = resolve(ctx.cwd, filterPath);
        filterUri = fileUri(abs);
      }

      const lines: string[] = [];
      for (const [uri, diags] of allDiags) {
        if (filterUri && uri !== filterUri) continue;
        const filePath = fileURLToPath(new URL(uri));
        const relevant = diags.filter((d) => d.severity === DiagnosticSeverity.Error || d.severity === DiagnosticSeverity.Warning);
        if (relevant.length === 0) continue;
        lines.push(`${filePath} (${relevant.length} diagnostic${relevant.length !== 1 ? "s" : ""})`);
        for (const d of relevant) {
          const severity = d.severity === DiagnosticSeverity.Error ? "error" : "warning";
          const line = d.range.start.line + 1;
          const col = d.range.start.character + 1;
          const source = d.source ? `[${d.source}] ` : "";
          lines.push(`  ${severity} ${line}:${col} ${source}${d.message}`);
        }
      }

      if (lines.length === 0) {
        ctx.ui.notify(filterPath ? `pi-lsp-lite: no diagnostics for ${filterPath}` : "pi-lsp-lite: no diagnostics", "info");
        return;
      }

      ctx.ui.notify(lines.join("\n"), "warning");
    },
  });

  pi.registerCommand("lsp-add", {
    description: "Add a new language server to global config",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("pi-lsp-lite: /lsp-add requires interactive mode", "error");
        return;
      }

      const rawId = await ctx.ui.input("Server ID (e.g. haskell):");
      if (!rawId) return;
      const id = rawId.trim().toLowerCase();
      if (!/^[a-z0-9_-]+$/.test(id)) {
        ctx.ui.notify("pi-lsp-lite: server ID must be lowercase alphanumeric, hyphens, or underscores", "error");
        return;
      }
      const RESERVED_IDS = new Set(["__proto__", "constructor", "prototype"]);
      if (RESERVED_IDS.has(id)) {
        ctx.ui.notify("pi-lsp-lite: reserved ID, choose a different name", "error");
        return;
      }

      const rawCommand = await ctx.ui.input("Binary command (e.g. haskell-language-server-wrapper):");
      const command = rawCommand?.trim();
      if (!command) return;

      const argsRaw = await ctx.ui.input("CLI args (comma-separated, or empty):");
      const args = argsRaw ? argsRaw.split(",").map((a) => a.trim()).filter(Boolean) : [];

      const extRaw = await ctx.ui.input("File extensions (comma-separated, e.g. .hs,.lhs):");
      if (!extRaw) return;
      const extensions = extRaw.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
      if (extensions.length === 0) {
        ctx.ui.notify("pi-lsp-lite: at least one extension is required", "error");
        return;
      }

      const rootRaw = await ctx.ui.input("Root pattern files (comma-separated, or empty):");
      const rootPatterns = rootRaw ? rootRaw.split(",").map((r) => r.trim()).filter(Boolean) : [];

      const resolved = await which(command);
      if (!resolved) {
        ctx.ui.notify(`pi-lsp-lite: "${command}" not found on PATH — server added but won't start until installed`, "warning");
      }

      await writeGlobalConfig({ servers: { [id]: { command, args, extensions, rootPatterns } } });
      await initConfig(ctx.cwd);
      ctx.ui.notify(`pi-lsp-lite: added server "${id}"`, "info");
    },
  });

  pi.registerCommand("lsp-remove", {
    description: "Remove or disable a language server",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("pi-lsp-lite: /lsp-remove requires interactive mode", "error");
        return;
      }

      if (servers.length === 0) {
        ctx.ui.notify("pi-lsp-lite: no servers configured", "info");
        return;
      }

      const ids = servers.map((s) => s.id);
      const selected = await ctx.ui.select("Remove which server?", ids);
      if (!selected) return;

      const confirmed = await ctx.ui.confirm("Confirm removal", `Disable server "${selected}"?`);
      if (!confirmed) return;

      await writeGlobalConfig({ servers: { [selected]: { disabled: true } } });
      await initConfig(ctx.cwd);
      ctx.ui.notify(`pi-lsp-lite: disabled server "${selected}"`, "info");
    },
  });

  pi.registerCommand("lsp-toggle", {
    description: "Enable or disable a language server",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("pi-lsp-lite: /lsp-toggle requires interactive mode", "error");
        return;
      }

      const builtinIds = new Set(builtinLanguages.map((l) => l.id));
      const activeIds = new Set(servers.map((s) => s.id));

      // include disabled user-added servers from global config so they can be re-enabled
      const globalConfig = await readGlobalConfig();
      const RESERVED = new Set(["__proto__", "constructor", "prototype"]);
      const globalServerIds = (globalConfig?.servers && typeof globalConfig.servers === "object" && !Array.isArray(globalConfig.servers))
        ? Object.keys(globalConfig.servers).filter((k) => !RESERVED.has(k))
        : [];
      const allIds = new Set<string>([...builtinIds, ...activeIds, ...globalServerIds]);

      if (allIds.size === 0) {
        ctx.ui.notify("pi-lsp-lite: no servers configured", "info");
        return;
      }

      const entries = [...allIds];
      const options = entries.map((id) => `${id} ${activeIds.has(id) ? "[enabled]" : "[disabled]"}`);
      const choice = await ctx.ui.select("Toggle which server?", options);
      if (!choice) return;

      const idx = options.indexOf(choice);
      const id = entries[idx];
      const isCurrentlyEnabled = activeIds.has(id);

      if (isCurrentlyEnabled) {
        await writeGlobalConfig({ servers: { [id]: { disabled: true } } });
      } else {
        // re-enable: works for both built-ins and user-added servers in global config
        await writeGlobalConfig({ servers: { [id]: { disabled: false } } });
      }

      await initConfig(ctx.cwd);
      ctx.ui.notify(`pi-lsp-lite: ${isCurrentlyEnabled ? "disabled" : "enabled"} server "${id}"`, "info");
    },
  });

  pi.registerCommand("lsp-install", {
    description: "Install a missing language server binary",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("pi-lsp-lite: /lsp-install requires interactive mode", "error");
        return;
      }

      const checks = await Promise.all(
        [...installRegistry].map(async ([id, entry]) => {
          const lang = builtinLanguages.find((l) => l.id === id);
          const binary = lang?.command ?? id;
          const found = await which(binary);
          return found ? null : { id, command: binary, installCmd: entry.command, description: entry.description };
        }),
      );
      const missing = checks.filter((c): c is NonNullable<typeof c> => c !== null);

      if (missing.length === 0) {
        ctx.ui.notify("pi-lsp-lite: all known servers are available", "info");
        return;
      }

      const options = missing.map((m) => `${m.id} — ${m.description} (${m.command})`);
      const choice = await ctx.ui.select("Install which server?", options);
      if (!choice) return;

      const idx = options.indexOf(choice);
      const selected = missing[idx];

      const confirmed = await ctx.ui.confirm("Confirm install", `Run: ${selected.installCmd}`);
      if (!confirmed) return;

      const result = await pi.exec("sh", ["-c", selected.installCmd]);
      if (result.code !== 0) {
        ctx.ui.notify(`pi-lsp-lite: install failed (exit ${result.code})\n${result.stderr}`, "error");
        return;
      }

      await initConfig(ctx.cwd);
      ctx.ui.notify(`pi-lsp-lite: installed ${selected.id}`, "info");
    },
  });
}
