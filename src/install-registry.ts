export interface InstallEntry {
  // Per-platform install command; `win32` overrides `default` on Windows.
  command: { default: string; win32?: string };
  description: string;
}

export const installRegistry = new Map<string, InstallEntry>([
  ["go", {
    command: { default: "go install golang.org/x/tools/gopls@latest" },
    description: "Go language server",
  }],
  ["rust", {
    command: { default: "rustup component add rust-analyzer" },
    description: "Rust language server",
  }],
  ["typescript", {
    command: { default: "npm install -g typescript-language-server typescript" },
    description: "TypeScript/JavaScript language server",
  }],
  ["python", {
    command: {
      default: "python3 -m pip install python-lsp-server",
      win32: "py -m pip install python-lsp-server",
    },
    description: "Python language server",
  }],
  ["cpp", {
    command: {
      default: "sudo apt-get install -y clangd || brew install llvm",
      win32: "winget install -e --id LLVM.clangd",
    },
    description: "C/C++ language server",
  }],
]);

// Resolve the install command for the current platform.
export function installCommandFor(entry: InstallEntry): string {
  if (process.platform === "win32" && entry.command.win32) return entry.command.win32;
  return entry.command.default;
}
