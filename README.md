# pi-lsp-lite

[pi](https://github.com/mariozechner/pi) extension that feeds LSP diagnostics back to the agent after every `write` and `edit`. Go, Rust, and TypeScript via `gopls`, `rust-analyzer`, and `typescript-language-server`.

The agent sees errors and warnings inline on the same turn as the edit that caused them.

## Install

```bash
pi install git:github.com/mcphailtom/pi-lsp-lite
```

Or from npm:

```bash
pi install npm:pi-lsp-lite
```

## Prerequisites

Language servers must be on `PATH`. If missing, that language is silently disabled.

| Server | Language | Install |
|--------|----------|---------|
| `gopls` | Go | `go install golang.org/x/tools/gopls@latest` |
| `rust-analyzer` | Rust | `rustup component add rust-analyzer` |
| `typescript-language-server` | TypeScript/JavaScript | `npm install -g typescript-language-server typescript` |

## Usage

No configuration needed. Once installed, diagnostics appear automatically after every `write` or `edit` to a supported file:

```
⚠ LSP diagnostics for main.go (2 errors):
  error 12:5 [compiler] undefined: foo
  error 18:2 [compiler] too many arguments in call to bar
  + 1 diagnostic in 1 other file
```

Use `/lsp-status` to see running servers.

## How it works

Edits trigger `textDocument/didOpen` or `textDocument/didChange` against a long-lived language server. Diagnostics are collected within a 3-second window and appended to the tool result. Workspace roots are detected automatically (`go.mod`, `Cargo.toml`, `tsconfig.json`, `package.json`).

See [ARCHITECTURE.md](docs/ARCHITECTURE.md) for internals.

## Development

```bash
git clone https://github.com/mcphailtom/pi-lsp-lite
cd pi-lsp-lite
npm install
npm run check        # typecheck
npm test             # unit tests
npm run test:integration  # requires servers on PATH
```

See [CONTRIBUTING.md](docs/CONTRIBUTING.md) for details.

## License

[MIT](LICENSE)
