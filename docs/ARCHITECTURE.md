# Architecture

## Overview

pi-lsp-lite is a [pi extension](https://github.com/mariozechner/pi) that hooks into the `tool_result` event for `write` and `edit` tool calls. When a supported file is modified, it routes the file through a long-lived LSP server and appends diagnostics to the tool result.

## Module layout

```
index.ts               → extension entry point
src/
  config.ts            → config file loading and merge
  languages.ts         → built-in language server defaults
  client.ts            → LSP protocol client (JSON-RPC over stdio)
  server-manager.ts    → server lifecycle and edit orchestration
  format.ts            → diagnostic formatting for agent consumption
  util.ts              → file URI, binary lookup, workspace root detection
test/
  fake-server.ts       → minimal LSP server for unit tests
  *.test.ts            → unit tests (no real servers)
  integration/         → real server tests (guarded by INTEGRATION env)
```

## Data flow

```
agent calls write/edit
  → pi executes the tool, writes the file
  → tool_result event fires
  → index.ts: check file extension, resolve absolute path, enforce cwd boundary
  → server-manager.ts: find workspace root, ensure server, queue edit
  → client.ts: send didOpen/didChange, wait for publishDiagnostics
  → format.ts: filter to errors+warnings, format text, add cross-file footer
  → index.ts: append formatted text to tool_result content
```

## Key design choices

### Per-URI generation counter

Each `didOpen` and `didChange` increments a generation counter for that URI. The `publishDiagnostics` handler rejects notifications whose generation doesn't match the current one. This prevents stale diagnostics from a previous open/close cycle being attributed to the current state.

### Serialized edits per server

Each `ManagedServer` has an `editQueue` promise chain. Edits to the same server are serialized so that `waitForDiagnostics` never has concurrent waiters on the same client. Different servers (different languages or different workspace roots) run in parallel.

### Snapshot-diff for cross-file diagnostics

Before sending a change, the client snapshots diagnostic counts for all tracked URIs. After the 50ms settle window, it compares counts and reports any file whose error/warning count increased. This works for both previously-opened files and files the server publishes diagnostics for autonomously.

### Workspace root detection

`findWorkspaceRoot()` walks up from the edited file looking for root markers (`go.mod`, `Cargo.toml`, `tsconfig.json`, `package.json`), bounded by the session's `cwd`. Different roots spawn different server instances, keyed by `${languageId}:${root}`.

### Server lifecycle

- Lazy start on first relevant edit
- Idle shutdown after 240s of no edits
- Periodic 60s sweep closes documents idle > 120s
- Session shutdown uses SIGTERM → SIGKILL escalation with 5s grace

### Failure isolation

- Missing binary: disables that language for the session
- Init failure: disables only that specific root (serverKey), other roots unaffected
- Both return `status: "unavailable"` so the agent isn't told the file is clean when it's actually unchecked

## Configuration loading

Config is loaded in three layers at `session_start`:

1. **Built-in defaults** from `src/languages.ts` (go, rust, typescript)
2. **Global config** from `~/.pi-lsp-lite.json`
3. **Project config** from `.pi-lsp-lite.json` or `.pi/lsp-lite.json` in the session's cwd

Each layer merges over the previous:
- New server IDs are added (global config only — project config cannot define new servers for security)
- Existing server IDs are partially overridden (only specified fields change)
- `"disabled": true` removes the server entirely (re-enabling in a later layer requires redefining the full server config)
- Timeout overrides (`diagnosticTimeout`, `documentIdleTimeout`) cascade from global to per-server
- Timeout values are clamped to safe bounds

Config is not hot-reloaded — `/reload` picks up changes via `session_start`.

## Extension hooks used

| Hook | Purpose |
|------|---------|
| `tool_result` | Intercept write/edit results, append diagnostics |
| `session_shutdown` | Kill all servers |
| `registerCommand` | `/lsp-status` |

## Adding a language

For built-in defaults, add an entry to `builtinLanguages` in `src/languages.ts`. For user-added servers, create a `.pi-lsp-lite.json`:

```json
{
  "servers": {
    "python": {
      "extensions": [".py"],
      "command": "pylsp",
      "args": [],
      "rootPatterns": ["pyproject.toml", "setup.py"]
    }
  }
}
```

The server manager handles the rest — spawn, lifecycle, diagnostics collection.
