import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createServerManager } from "./src/server-manager.js";
import { languageForFile, checkExtensionOverlaps } from "./src/languages.js";
import { formatDiagnostics } from "./src/format.js";
import { resolve, relative, isAbsolute } from "node:path";

export default function (pi: ExtensionAPI) {
  const manager = createServerManager();

  for (const warning of checkExtensionOverlaps()) {
    console.error(`[pi-lsp-lite] ${warning}`);
  }

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return;

    const rawPath = event.input?.path;
    const filePath = typeof rawPath === "string" ? rawPath : undefined;
    if (!filePath) return;

    const absolutePath = resolve(ctx.cwd, filePath);
    const rel = relative(ctx.cwd, absolutePath);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return;
    const config = languageForFile(absolutePath);
    if (!config) return;

    try {
      const result = await manager.handleEdit(absolutePath, config, ctx.cwd);
      const formatted = formatDiagnostics(filePath, result);
      if (!formatted) return;

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
      const servers = manager.status();
      if (servers.length === 0) {
        ctx.ui.notify("pi-lsp-lite: no servers running", "info");
        return;
      }
      const lines = servers.map((s) => {
        const idle = Math.round((Date.now() - s.lastActivity) / 1000);
        const up = Math.round(s.uptime / 1000);
        return `${s.id} (pid ${s.pid}) root=${s.root} — ${s.openDocuments} open files, up ${up}s, idle ${idle}s`;
      });
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
