# Architecture

## Overview

pi-lsp-lite is a [pi extension](https://github.com/mariozechner/pi) that hooks into the `tool_result` event for `write` and `edit` tool calls. When a supported file is modified, it routes the file through a long-lived LSP server and appends diagnostics to the tool result.

## Module layout

```
index.ts               → extension entry point
src/
  config.ts            → config file loading, merge, and write
  languages.ts         → built-in language server defaults
  install-registry.ts  → known install commands for built-in servers
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

### Snapshot-diff with quiescence-based settling

Diagnostic collection uses a two-trigger approach to handle both direct and cross-file diagnostics:

**Pre-snapshot:** Before sending `didChange`, snapshot error/warning counts for all tracked URIs.

**Trigger 1 — target URI publishes:** When the edited file receives diagnostics, start a 200ms quiescence countdown. If no more diagnostics arrive within 200ms, settle.

**Trigger 2 — cross-file callback:** When *any* URI receives diagnostics, compare its new counts to the pre-snapshot (or zero if the URI was never tracked before). If counts changed (genuine cross-file impact), start the same 200ms quiescence countdown. This handles both previously-opened files and files the server publishes for autonomously (e.g. a dependent module never explicitly opened by the agent).

**Why quiescence, not immediate settle:** LSP servers often publish diagnostics for multiple files in rapid succession after a change. The 200ms window collects them all before reporting.

**Why compare against the snapshot:** A stale re-publish (server re-confirming existing diagnostics) doesn't change counts relative to the snapshot, so it's ignored. Only genuine impact from the current edit triggers settling. This prevents false positives when the server republishes for unrelated files.

**Timeout fallback:** If neither trigger fires within the per-language timeout (gopls: 5s, rust-analyzer: 30s, typescript: 30s), the wait settles with `status: "timeout"`. Cross-file data collected up to that point is still included in `otherFiles`.

```
handleEdit(lib.ts):
  snapshot: { caller.ts: {errors:0} }
  send didChange(lib.ts)
  │
  ├─ server publishes for caller.ts: [{error}]
  │  crossFileCallback: pre={errors:0}, post={errors:1} → CHANGED
  │  → start 200ms quiescence
  │
  ├─ server publishes for type_error.ts: [] (stale re-publish)
  │  crossFileCallback: pre={errors:0}, post={errors:0} → UNCHANGED
  │  → ignored
  │
  ├─ 200ms pass, no more publishes
  │  → settle("ok")
  │
  └─ result: { status:"ok", diagnostics:[], otherFiles:[{caller.ts, errors:1}] }
```

### Per-language diagnostic timeouts

Each built-in language server has a default diagnostic timeout calibrated to its real-world performance:

| Server | Timeout | Rationale |
|--------|---------|----------|
| gopls | 5s | Fast indexing, quick diagnostics even on cold start |
| rust-analyzer | 60s | Slow cold start on CI, needs workspace indexing time |
| typescript-language-server | 30s | Cross-file analysis can be slow on workspace changes |
| pylsp | 15s | Moderate cold start, plugin-dependent analysis speed |
| clangd | 15s | Fast for single files, slower for projects without compile_commands.json |

Timeouts are overridable via `.pi-lsp-lite.json` (global `diagnosticTimeout` or per-server `servers.<id>.diagnosticTimeout`).

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

1. **Built-in defaults** from `src/languages.ts` (go, rust, typescript, python, c/c++)
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
| `session_start` | Load config, create server manager |
| `session_shutdown` | Kill all servers |
| `registerCommand` | `/lsp-status`, `/lsp-diag`, `/lsp-add`, `/lsp-remove`, `/lsp-toggle`, `/lsp-install` |

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
