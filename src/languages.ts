export interface LanguageServerConfig {
  id: string;
  extensions: string[];
  command: string;
  args: string[];
  rootPatterns: string[];
  diagnosticTimeout?: number;
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
    diagnosticTimeout: 15_000,
  },
  {
    id: "typescript",
    extensions: [".ts", ".tsx", ".js", ".jsx"],
    command: "typescript-language-server",
    args: ["--stdio"],
    rootPatterns: ["tsconfig.json", "package.json"],
    diagnosticTimeout: 30_000,
  },
];

export function languageForFile(path: string, configs: LanguageServerConfig[]): LanguageServerConfig | undefined {
  const lower = path.toLowerCase();
  return configs.find((lang) => lang.extensions.some((ext) => lower.endsWith(ext)));
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
