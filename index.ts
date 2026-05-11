import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createServerManager } from "./src/server-manager.js";
import { languageForFile, checkExtensionOverlaps, type LanguageServerConfig } from "./src/languages.js";
import { formatDiagnostics } from "./src/format.js";
import { loadConfig } from "./src/config.js";
import { resolve, relative, isAbsolute } from "node:path";

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

    const absolutePath = resolve(ctx.cwd, filePath);
    const rel = relative(ctx.cwd, absolutePath);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return;
    const langConfig = languageForFile(absolutePath, servers);
    if (!langConfig) return;

    try {
      const result = await manager.handleEdit(absolutePath, langConfig, ctx.cwd);
      const formatted = formatDiagnostics(filePath, result);
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
}
