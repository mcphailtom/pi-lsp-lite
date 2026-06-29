import { access } from "node:fs/promises";
import { join, dirname, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import which_ from "which";

export function fileUri(absolutePath: string): string {
  return pathToFileURL(absolutePath).href;
}

// Find a binary on PATH. Delegates to the `which` package — the same resolver
// cross-spawn uses to locate the command it launches — so preflight resolution
// and the eventual spawn agree on every platform.
function isNotFoundError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

export async function which(command: string): Promise<string | null> {
  try {
    return await which_(command);
  } catch (err) {
    if (!isNotFoundError(err)) {
      console.error(`[pi-lsp-lite] failed to resolve command "${command}":`, err);
    }
    return null;
  }
}

export async function findWorkspaceRoot(filePath: string, rootPatterns: string[], cwd: string): Promise<string> {
  let dir = dirname(filePath);
  while (true) {
    for (const pattern of rootPatterns) {
      try {
        await access(join(dir, pattern));
        return dir;
      } catch {}
    }
    if (dir === cwd) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return cwd;
}

export function isInsideCwd(absolutePath: string, cwd: string): boolean {
  const rel = relative(cwd, absolutePath);
  return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
}
