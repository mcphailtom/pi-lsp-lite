import { access, stat, constants } from "node:fs/promises";
import { join, dirname, relative, isAbsolute, delimiter } from "node:path";
import { pathToFileURL } from "node:url";

const isWindows = process.platform === "win32";

export function fileUri(absolutePath: string): string {
  return pathToFileURL(absolutePath).href;
}

// A resolvable command must be a regular file, and on POSIX must carry an executable bit; Windows has no executable bit so existence suffices.
async function isExecutable(path: string): Promise<boolean> {
  try {
    const stats = await stat(path);
    if (!stats.isFile()) return false;
    if (isWindows) return true;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Normalized PATHEXT extensions, each dotted and deduped case-insensitively.
function pathExtensions(): string[] {
  const seen = new Set<string>();
  const exts: string[] = [];
  for (const raw of (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const ext = trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
    const key = ext.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    exts.push(ext);
  }
  return exts;
}

// Windows never executes an extensionless name, so a bare command is probed only with each PATHEXT extension; a command already carrying a known extension is used verbatim.
function executableCandidates(base: string, exts: string[]): string[] {
  if (!isWindows) return [base];
  const lower = base.toLowerCase();
  if (exts.some((ext) => lower.endsWith(ext.toLowerCase()))) return [base];
  return exts.map((ext) => base + ext);
}

function hasPathSeparator(command: string): boolean {
  return command.includes("/") || (isWindows && command.includes("\\"));
}

export async function which(command: string): Promise<string | null> {
  const exts = isWindows ? pathExtensions() : [];
  if (isAbsolute(command) || hasPathSeparator(command)) {
    for (const candidate of executableCandidates(command, exts)) {
      if (await isExecutable(candidate)) return candidate;
    }
    return null;
  }
  const pathDirs = (process.env.PATH ?? "").split(delimiter);
  for (const dir of pathDirs) {
    if (!dir) continue;
    for (const candidate of executableCandidates(join(dir, command), exts)) {
      if (await isExecutable(candidate)) return candidate;
    }
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
