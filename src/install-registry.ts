export interface InstallEntry {
  command: string;
  description: string;
}

export const installRegistry = new Map<string, InstallEntry>([
  ["go", {
    command: "go install golang.org/x/tools/gopls@latest",
    description: "Go language server",
  }],
  ["rust", {
    command: "rustup component add rust-analyzer",
    description: "Rust language server",
  }],
  ["typescript", {
    command: "npm install -g typescript-language-server typescript",
    description: "TypeScript/JavaScript language server",
  }],
  ["python", {
    command: "pip install python-lsp-server",
    description: "Python language server",
  }],
  ["cpp", {
    command: "apt install clangd || brew install llvm",
    description: "C/C++ language server",
  }],
]);
