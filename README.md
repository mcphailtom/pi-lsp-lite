# pi-lsp-lite

[![CI](https://img.shields.io/github/actions/workflow/status/mcphailtom/pi-lsp-lite/ci.yml?branch=main&label=CI)](https://github.com/mcphailtom/pi-lsp-lite/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pi-lsp-lite)](https://www.npmjs.com/package/pi-lsp-lite)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Your agent can't see compiler errors. Now it can.

[pi](https://github.com/mariozechner/pi) extension that runs language servers in the background and feeds diagnostics back inline after every edit. Errors appear on the same turn — no context switch, no separate command.

**Go · Rust · TypeScript · Python · C/C++**

## Install

```bash
pi install npm:pi-lsp-lite
```

That's it. If you have `gopls`, `rust-analyzer`, `typescript-language-server`, `pylsp`, or `clangd` on PATH, diagnostics start flowing automatically.

## What you see

```
  edit ─ src/main.go
  ✓ Edited src/main.go (replaced 2 lines)

  ⚠ LSP diagnostics for src/main.go (2 errors):
    error 12:5 [compiler] undefined: foo
    error 18:2 [compiler] too many arguments in call to bar
    + 1 diagnostic in 1 other file
```

The agent sees these too — they're appended to the tool result, so it can self-correct on the same turn.

## Commands

| Command | What it does |
|---------|-------------|
| `/lsp-status` | Show running servers, PIDs, workspace roots, uptime |
| `/lsp-diag` | Show all current diagnostics (or `/lsp-diag path/to/file` for one file) |
| `/lsp-add` | Interactively add a new language server |
| `/lsp-remove` | Disable a configured server |
| `/lsp-toggle` | Flip a server on/off without removing config |
| `/lsp-install` | Install a missing server binary |

## Supported servers

| Server | Language | Install |
|--------|----------|---------|
| `gopls` | Go | `go install golang.org/x/tools/gopls@latest` |
| `rust-analyzer` | Rust | `rustup component add rust-analyzer` |
| `typescript-language-server` | TypeScript/JS | `npm install -g typescript-language-server typescript` |
| `pylsp` | Python | `pip install python-lsp-server` |
| `clangd` | C/C++ | Xcode CLI tools / `apt install clangd` |

Missing a server? `/lsp-add` lets you configure any LSP server that speaks stdio. Or add it to global config (`~/.pi-lsp-lite.json`):

```json
{
  "servers": {
    "haskell": {
      "extensions": [".hs"],
      "command": "haskell-language-server-wrapper",
      "args": ["--lsp"],
      "rootPatterns": ["cabal.project", "stack.yaml"]
    }
  }
}
```

## Configuration

Works without config. Use project config (`.pi-lsp-lite.json` or `.pi/lsp-lite.json`) for safe local tuning, and global config (`~/.pi-lsp-lite.json`) for trusted executable/server-shape changes like custom servers, `command`, `args`, `extensions`, and `rootPatterns`:

| Field | Description | Default |
|-------|-------------|---------|
| `servers.<id>.diagnosticTimeout` | Per-attempt timeout (ms) | per-language |
| `servers.<id>.maxRetries` | Retry attempts on timeout (0-10) | `3` |
| `servers.<id>.disabled` | Disable this server | `false` |
| `diagnosticTimeout` | Global default timeout (ms) | `5000` |
| `documentIdleTimeout` | Close idle documents after (ms) | `120000` |

Project config merges over global for safe tuning fields. Repositories can disable servers and tune timeouts/retries, but they cannot change the executable, argv, extensions, or root patterns for any existing server; put those trusted changes in global config.

## How it works

1. Agent writes/edits a file
2. Extension detects the language, finds the workspace root
3. Spawns (or reuses) an LSP server for that language + root
4. Sends `didChange`, waits for `publishDiagnostics`
5. If timeout: retries with exponential backoff + jitter (up to `maxRetries` times)
6. Filters to errors + warnings, formats, appends to tool result + shows in TUI

Cross-file impact is detected via snapshot-diff: if editing `lib.ts` breaks `caller.ts`, you see "+ N diagnostics in M other files".

Servers are lazy (spawn on first edit), idle-shutdown after 240s, and clean up on session end.

## Development

```bash
git clone https://github.com/mcphailtom/pi-lsp-lite
cd pi-lsp-lite && npm install
npm run check              # typecheck
npm test                   # unit tests (no servers needed)
npm run test:integration   # real server tests (needs servers on PATH)
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md).

## License

[MIT](LICENSE)
