export interface LanguageServerConfig {
  id: string;
  extensions: string[];
  command: string;
  args: string[];
  rootPatterns: string[];
  diagnosticTimeout?: number;
  maxRetries?: number;
  languageIds?: Record<string, string>;
}

export const builtinLanguages: LanguageServerConfig[] = [
  {
    id: "go",
    extensions: [".go"],
    command: "gopls",
    args: ["serve"],
    rootPatterns: ["go.mod"],
    diagnosticTimeout: 5_000,
  },
  {
    id: "rust",
    extensions: [".rs"],
    command: "rust-analyzer",
    args: [],
    rootPatterns: ["Cargo.toml"],
    diagnosticTimeout: 30_000,
  },
  {
    id: "typescript",
    extensions: [".ts", ".tsx", ".js", ".jsx"],
    command: "typescript-language-server",
    args: ["--stdio"],
    rootPatterns: ["tsconfig.json", "package.json"],
    diagnosticTimeout: 30_000,
    languageIds: { ".tsx": "typescriptreact", ".js": "javascript", ".jsx": "javascriptreact" },
  },
  {
    id: "python",
    extensions: [".py"],
    command: "pylsp",
    args: [],
    rootPatterns: ["pyproject.toml", "setup.py", "requirements.txt"],
    diagnosticTimeout: 15_000,
  },
  {
    id: "cpp",
    extensions: [".c", ".cc", ".cpp", ".cxx", ".h", ".hpp", ".hxx"],
    command: "clangd",
    args: [],
    rootPatterns: ["compile_commands.json", "CMakeLists.txt", ".clangd"],
    diagnosticTimeout: 15_000,
    languageIds: { ".c": "c", ".h": "c", ".cc": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hxx": "cpp" },
  },
];

export function languageForFile(path: string, configs: LanguageServerConfig[]): LanguageServerConfig | undefined {
  const lower = path.toLowerCase();
  return configs.find((lang) => lang.extensions.some((ext) => lower.endsWith(ext)));
}

export function languageIdForFile(filePath: string, config: LanguageServerConfig): string {
  if (config.languageIds) {
    const ext = filePath.toLowerCase().match(/\.[^.]+$/)?.[0];
    if (ext && config.languageIds[ext]) return config.languageIds[ext];
  }
  return config.id;
}

export function checkExtensionOverlaps(configs: LanguageServerConfig[]): string[] {
  const warnings: string[] = [];
  const seen = new Map<string, string>();
  for (const lang of configs) {
    for (const ext of lang.extensions) {
      const existing = seen.get(ext);
      if (existing) {
        warnings.push(`extension "${ext}" is claimed by both "${existing}" and "${lang.id}" — "${existing}" wins`);
      } else {
        seen.set(ext, lang.id);
      }
    }
  }
  return warnings;
}
