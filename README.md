# pi-lsp-lite

[![CI](https://img.shields.io/github/actions/workflow/status/mcphailtom/pi-lsp-lite/ci.yml?branch=main&label=CI)](https://github.com/mcphailtom/pi-lsp-lite/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pi-lsp-lite)](https://www.npmjs.com/package/pi-lsp-lite)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Your agent changed a file. pi-lsp-lite tells it when the language checker disagrees.

[pi](https://github.com/earendil-works/pi) extension that adds language-server errors and warnings to successful `write` and `edit` results. The agent receives diagnostics in the same turn, without running a separate command.

**Go · Rust · TypeScript/JavaScript · Python · C/C++**

## Install

```bash
pi install npm:pi-lsp-lite
```

If `gopls`, `rust-analyzer`, `typescript-language-server`, `pylsp`, or `clangd` is on `PATH`, the matching server starts automatically on the first supported edit. Requires Node.js 22.19 or newer.

## What you see

If changing one file breaks another, the related file is shown with its first diagnostic:

```text
  edit ─ src/lib.ts
  ✓ Edited src/lib.ts

  ⚠ LSP diagnostics for src/lib.ts: no issues
    src/caller.ts (1 error): error 8:17 [typescript] Expected 3 arguments, but got 2.
```

The diagnostic text is appended to the tool result, so the agent can repair the problem immediately. In pi modes with a user interface, the same text also appears as a warning notification. A settled clean result adds nothing.

Diagnostics run only after a successful tool result named `write` or `edit`, for a supported file whose physical path is inside the session workspace. Changes made through shell commands or other tools do not trigger a check.

## Commands

| Command | What it does |
|---|---|
| `/lsp-status` | Show configured, enabled, installed, and running state, including processes and workspace roots |
| `/lsp-diag [path]` | Show cached diagnostics for all tracked files or one path; does not request a fresh analysis |
| `/lsp-add` | Interactively add a custom server to global configuration |
| `/lsp-remove` | Interactively disable an enabled server in global configuration |
| `/lsp-toggle` | Interactively enable or disable a built-in or globally known server |
| `/lsp-install` | Interactively run a confirmed install command for a missing built-in server |

The four configuration/install commands require an interactive pi mode. Add, remove, toggle, and successful install operations reload configuration and stop current server processes; servers start lazily again on the next relevant edit. Custom servers must be installed manually.

## Built-in servers

| Server | Language | Install |
|---|---|---|
| `gopls` | Go | `go install golang.org/x/tools/gopls@latest` |
| `rust-analyzer` | Rust | `rustup component add rust-analyzer` |
| `typescript-language-server` | TypeScript/JavaScript | `npm install -g typescript-language-server typescript` |
| `pylsp` | Python | `python3 -m pip install python-lsp-server` · Windows: `py -m pip install python-lsp-server` |
| `clangd` | C/C++ | Linux: `sudo apt-get install -y clangd` · macOS: `brew install llvm` · Windows: `winget install -e --id LLVM.clangd` |

`/lsp-install` offers missing entries from this built-in list and asks before executing the platform command.

## Custom servers

`/lsp-add` configures a custom server interactively. You can also add one to global configuration at `~/.pi-lsp-lite.json`:

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

A custom server must speak the Language Server Protocol over standard input/output, accept full-document open/change notifications, and publish diagnostics. Custom extensions use the server ID as their protocol language ID.

## Configuration

No configuration is required for built-in servers. Settings resolve in this order:

1. built-in defaults;
2. trusted global configuration at `~/.pi-lsp-lite.json`;
3. the first valid project file: `.pi-lsp-lite.json`, otherwise `.pi/lsp-lite.json`.

The two project paths are alternatives, not two merged layers. Project configuration may disable existing servers and tune timeouts or retries. It cannot add a server or change executable shape (`command`, `args`, `extensions`, or `rootPatterns`); those trusted changes belong in global configuration.

| Field | Description | Default |
|---|---|---|
| `servers.<id>.diagnosticTimeout` | Per-attempt timeout for one server, from 1,000–60,000 ms | Go: `5000`; Rust/TypeScript: `30000`; Python/C/C++: `15000` |
| `servers.<id>.maxRetries` | Retries after the first timed-out attempt, from 0–10 | `3` |
| `servers.<id>.disabled` | Remove the server from the resolved session configuration | `false` |
| `diagnosticTimeout` | Fallback per-attempt timeout when no server-specific or built-in timeout applies | `5000` |
| `documentIdleTimeout` | Close tracked documents after this much inactivity, from 10,000–600,000 ms | `120000` |

Configuration is loaded at session startup, after `/reload`, and after a management command changes global configuration.

## How it works

1. A successful `write` or `edit` result identifies a supported file inside the workspace.
2. The extension finds the nearest configured project root.
3. It starts or reuses one initialized language server for that server ID and root.
4. The first update opens the document; later updates send its full changed contents.
5. The extension waits for the edited file or changed related-file diagnostics to settle, retrying with bounded exponential backoff after a timeout.
6. Errors and warnings are formatted and appended to the original tool result.

Servers start lazily, serialize edits that share one process, and can run independently for different languages or roots. Tracked documents close after their configured idle period; an inactive server shuts down after a fixed 240 seconds. Process and diagnostic state is memory-only and is cleaned up on session shutdown.

Timeout output is marked as potentially incomplete. A missing binary or failed server initialization is reported as unavailable rather than as a clean file. See [the architecture](docs/ARCHITECTURE.md) for precise state, ordering, failure, trust, and current-limitation semantics.

## Development

Requires Node.js 22.19 or newer.

```bash
git clone https://github.com/mcphailtom/pi-lsp-lite
cd pi-lsp-lite
npm install
npm run check              # typecheck
npm test                   # unit tests; no real servers required
npm run test:integration   # real-server tests; all built-in servers must be on PATH
```

See [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) for focused integration commands and documentation expectations.

## License

[MIT](LICENSE)
