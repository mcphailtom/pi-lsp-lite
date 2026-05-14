import { access, constants } from "node:fs/promises";
import { join, dirname, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

export function fileUri(absolutePath: string): string {
  return pathToFileURL(absolutePath).href;
}

export async function which(command: string): Promise<string | null> {
  if (command.includes("/")) {
    try {
      await access(command, constants.X_OK);
      return command;
    } catch {
      return null;
    }
  }
  const pathDirs = (process.env.PATH ?? "").split(":");
  for (const dir of pathDirs) {
    const candidate = join(dir, command);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
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
