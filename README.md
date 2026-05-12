# pi-lsp-lite

Just LSP diagnostics for [pi](https://github.com/mariozechner/pi) — errors and warnings on every edit, same turn. Go, Rust, TypeScript, Python, C/C++.

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
| `pylsp` | Python | `pip install python-lsp-server` |
| `clangd` | C/C++ | Included with Xcode CLI tools / `apt install clangd` |

## Usage

No configuration needed. Once installed, diagnostics appear automatically after every `write` or `edit` to a supported file:

```
⚠ LSP diagnostics for main.go (2 errors):
  error 12:5 [compiler] undefined: foo
  error 18:2 [compiler] too many arguments in call to bar
  + 1 diagnostic in 1 other file
```

Use `/lsp-status` to see running servers.

## Configuration

Works out of the box with built-in defaults. To add servers, override settings, or disable languages, create a config file:

**Project-level** (`.pi-lsp-lite.json` or `.pi/lsp-lite.json` in project root):

```json
{
  "servers": {
    "python": {
      "extensions": [".py"],
      "command": "pylsp",
      "args": [],
      "rootPatterns": ["pyproject.toml", "setup.py"]
    },
    "typescript": {
      "disabled": true
    },
    "rust": {
      "diagnosticTimeout": 8000
    }
  },
  "diagnosticTimeout": 5000,
  "documentIdleTimeout": 120000
}
```

**Global** (`~/.pi-lsp-lite.json`) — same format, applies to all projects. Project config merges over global.

| Field | Description | Default |
|-------|-------------|---------|
| `servers.<id>.extensions` | File extensions to match | (required for new servers) |
| `servers.<id>.command` | Binary name or path | (required for new servers) |
| `servers.<id>.args` | CLI arguments | `[]` |
| `servers.<id>.rootPatterns` | Files that mark workspace root | `[]` |
| `servers.<id>.diagnosticTimeout` | Per-server timeout (ms) | global default |
| `servers.<id>.disabled` | Disable this server | `false` |
| `diagnosticTimeout` | Default diagnostic wait (ms) | `5000` |
| `documentIdleTimeout` | Close idle documents after (ms) | `120000` |

Partial overrides work — only the fields you specify are changed.

## How it works

Edits trigger `textDocument/didOpen` or `textDocument/didChange` against a long-lived language server. Diagnostics are collected within a configurable timeout and appended to the tool result. Workspace roots are detected automatically (`go.mod`, `Cargo.toml`, `tsconfig.json`, `package.json`, `pyproject.toml`, `compile_commands.json`).

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
