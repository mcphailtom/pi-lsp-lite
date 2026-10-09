# Architecture

## Plain-English model

A coding agent can change a file without noticing that the change introduced a compiler or language error. pi-lsp-lite closes that feedback gap. It keeps a language-aware checker running in the background, waits briefly for that checker to react to a successful file edit, and adds any errors or warnings to the same result the agent receives.

The work happens in five stages:

1. **Prepare the session.** The extension combines built-in language support with trusted user configuration and restricted project configuration. No checker process starts yet.
2. **Accept a relevant edit.** After pi successfully writes or edits a file, the extension verifies that the real file remains inside the session workspace and that a configured language owns its extension.
3. **Find or start the checker.** The extension finds the nearest project root and reuses one initialized checker for that language and root, starting it lazily when necessary.
4. **Collect the reaction.** The current file contents are sent to the checker. Edits sharing a checker wait in order while independent checkers can work in parallel. The extension waits for direct and cross-file diagnostics, with bounded retries when no response arrives.
5. **Return visible feedback.** Errors and warnings are formatted for the agent and, where the current pi mode has a UI, shown to the user. A confirmed clean result adds nothing.

```text
successful file edit
        |
        v
workspace and language check
        |
        v
reused or newly initialized checker
        |
        v
diagnostic settling and retry
        |
        v
agent result + optional UI notification
```

For example, suppose an agent adds a required argument to a TypeScript function. The edited file may remain valid while a caller in another file becomes invalid. The extension reuses the workspace's TypeScript checker, waits for its related-file update, and returns the caller's first error alongside the edit result. The agent can then repair the caller without running a separate command.

The implemented system supports Go, Rust, TypeScript/JavaScript, Python, and C/C++, plus globally configured custom servers. It also provides commands for inspecting state and diagnostics and for managing global server configuration. Those commands are optional operational controls; normal diagnostic feedback needs no command.

This is intentionally a diagnostics-only integration. It does not provide completion, hover information, code actions, formatting, or a durable diagnostic database. It also does not yet guarantee that a delayed diagnostic from an earlier close/reopen cycle will be rejected; that limitation is described below rather than presented as implemented protection.

## Document status

- **Validated against commit:** `d128d0c9cf625ca1a273ff1be6b32b04953634ec`
- **Package version at that commit:** `0.5.1`
- **Scope:** implemented current state only

Proposed changes and sequencing are deliberately kept out of this public architecture. They are maintained in private project planning; this document does not expose a private planning link.

## One edit from trigger to result

The main runtime path answers a practical question: after pi has changed a file, what must become true before the result can honestly include diagnostics? A registered handler must first admit the file, an initialized server must accept its current contents, and the diagnostic wait must either settle or report that checking was unavailable or incomplete.

### 1. Prepare the session without starting servers

The extension entrypoint registers lifecycle handlers and commands when pi loads `index.ts`. Its initial server manager is empty and owns no child processes. On `session_start`, `initConfig()` shuts down any previous manager, loads configuration, and constructs a new manager with the resolved timeout settings. Pi completes this startup event before accepting user input that could run a tool, so a `tool_result` cannot arrive during the unconfigured load-to-start interval.

At the end of startup:

- the extension can accept relevant `write` and `edit` results;
- commands are registered;
- configuration exists in memory;
- no language-server process exists yet;
- no diagnostic state is durable.

The same startup path runs after pi reloads the extension. Mutating management commands also call `initConfig()` after writing global configuration, so they deliberately shut down existing servers and start the next edit from a fresh in-memory manager.

Technical ownership: `index.ts` coordinates startup; `loadConfig()` in `src/config.ts` resolves configuration; `createServerManager()` in `src/server-manager.ts` owns the new session-scoped runtime.

### 2. Admit only a successful, supported workspace edit

Pi emits `tool_result` after a tool finishes. Pi exposes the session workspace path to the extension as `ctx.cwd`; later references to the session workspace mean that path. The handler in `index.ts` continues only when all of these conditions hold:

1. the tool name is exactly `write` or `edit`;
2. the tool result is not an error;
3. `event.input.path` is a string;
4. the path resolves to an existing file;
5. the file's physical path is strictly below `ctx.cwd`;
6. the first configured server claiming the file extension exists.

The path check resolves symlinks with `realpath()` before calling `isInsideCwd()`. A lexical path inside the workspace therefore cannot use an in-workspace symlink to reach outside it. The workspace directory itself is not considered a file inside the workspace.

A missing file, unsupported extension, malformed path, failed write/edit, or file outside the physical workspace is ignored without changing the original tool result. This boundary is intentionally narrower than “any filesystem mutation”: shell commands and custom tools are not observed merely because they changed a file.

Technical ownership: the `tool_result` handler in `index.ts` owns event admission; `isInsideCwd()` and language matching live in `src/util.ts` and `src/languages.ts`.

### 3. Find a root and make one server usable

For an admitted file, `findWorkspaceRoot()` walks upward from the file's directory. It returns the nearest directory containing one of the configured root markers, checks the session workspace itself, and never searches above that workspace. If no marker exists, the workspace is the root.

The background checker speaks the Language Server Protocol (LSP). This implementation carries its messages as JSON-encoded remote procedure calls (JSON-RPC) over the child process's standard input and output (`stdio`). Files are named with uniform resource identifiers (URIs), which are URL-like file identifiers.

A server instance is identified by the configured server ID plus that root:

```text
<server id>:<absolute workspace root>
```

This is the server configuration ID, not the per-file LSP `languageId`. JavaScript and TypeScript files can therefore share the configured TypeScript server for one root while separate roots receive separate processes.

`ensureServer()` reuses an initialized instance when present. For concurrent first edits, a `pending` map shares the same spawn promise so only one process is created for a server/root pair. A new process becomes usable in this order:

1. look up the configured command on `PATH` with `which`, matching the resolution behavior expected by `cross-spawn`;
2. spawn it with the workspace root as its working directory and `stdio` pipes for JSON-RPC;
3. create the protocol client;
4. complete the LSP initialize exchange within 10 seconds;
5. add the initialized server to the active map and start lifecycle timers.

There is a short interval in which the child process exists but cannot accept an edit because initialization has not completed. The manager exposes the server to callers only after initialization succeeds. The user's edit result is not diagnostic-ready until the later document update and wait also finish.

Technical ownership: `createServerManager()` and its private `ensureServer()`/`spawnServer()` flow own process readiness; `createLspClient()` in `src/client.ts` owns the initialize request and JSON-RPC connection.

### 4. Send the current document and settle diagnostics

Each active server has an `editQueue`. Work for the same server/root pair is chained in the order it is attached to that promise, including recovery after a previous queued edit rejected. This permits only one diagnostic waiter on a client at a time. Pi may complete sibling tools concurrently, so the queue is a per-server arrival order rather than a global assistant source-order guarantee. Different server/root pairs have separate queues and may run concurrently.

When a queue slot begins, `doEdit()` reads the file's current contents from disk. It does not retain the historical bytes associated with the original tool event, so multiple rapid edits can collapse to the latest disk contents by the time an earlier queue slot runs. The first tracked update sends `textDocument/didOpen` with the extension-specific LSP language ID; later updates send `textDocument/didChange`. The manager then records the document's latest activity time.

The client keeps the latest published diagnostics per file URI. As the wait begins immediately after the document notification, it snapshots the error/warning fingerprints of every other tracked URI. A fingerprint uses severity, start line, start character, and message. The target file is not part of that cross-file snapshot.

Two events can begin the 200 ms quiet-period countdown:

- the target URI publishes diagnostics, including an empty list for a clean file;
- another URI publishes an error/warning fingerprint set different from its pre-edit snapshot.

Each relevant publication resets the quiet period. When 200 ms pass without another relevant publication, the result settles as `ok`. This delay collects bursts in which a language server reports the edited file and then one or more dependent files. A publication for a previously unknown URI can participate because the client records unsolicited diagnostic URIs as they arrive.

```text
send current document
        |
        +--> target diagnostics arrive --------+
        |                                       |
        +--> changed related-file diagnostics --+--> 200 ms quiet --> settled result
        |
        +--> no relevant publication --> per-attempt timeout
```

If no relevant publication arrives before the configured per-attempt timeout, the manager returns a timeout result or retries. A retry waits for exponential backoff beginning at 500 ms, adds 0–50% jitter, caps an individual delay at 30 seconds, and sends `didChange` again with the same contents captured for that queue slot. `maxRetries` counts retries after the first attempt, so the default value of three allows four total attempts.

Once a relevant publication starts the quiet period, the per-attempt timeout is cleared. A server that continually publishes relevant changes can therefore keep resetting quiescence beyond the nominal timeout. Normal supported servers publish finite bursts, but the timeout is not an absolute wall-clock deadline after settling begins.

#### What URI generations do and do not guarantee

`didOpen`, `didChange`, and `didClose` increment a per-URI generation and replace or remove local document state. A publication is rejected when the diagnostic entry being updated has a different generation from the current local counter.

LSP `publishDiagnostics` notifications do not carry the local generation that caused them, however. If a document is closed and left closed until a delayed publication arrives, a later `didOpen` replaces that stored entry. If the URI is closed and reopened *before* a delayed publication from the previous open arrives, the notification can be accepted into the new entry because it cannot be identified as belonging to the earlier generation. The current generation bookkeeping therefore does not provide a complete stale-notification guarantee across rapid close/reopen cycles.

Technical ownership: `server-manager.ts` owns queueing, document-open state, timeout selection, and retries; `client.ts` owns document versions, URI generations, diagnostic snapshots, fingerprints, quiescence, and result assembly.

### 5. Make the outcome visible without claiming a false clean result

`formatDiagnostics()` keeps only errors and warnings. For the edited file it displays at most 50 entries while retaining the full count in the summary. For each changed related file it reports counts and, when available, the first error or warning. Paths are made relative to the session workspace where possible.

The three result statuses have different user meaning:

- `ok` means the wait settled after a relevant publication; a clean target with no changed related files produces no added output;
- `timeout` means the result may be incomplete, and the output includes the retry count when retries occurred;
- `unavailable` means the configured binary was missing or the server/root failed initialization, so the extension explicitly avoids presenting an unchecked file as clean.

When formatted output is non-empty, `index.ts` appends it to the original tool-result content, making it available to the agent in the same turn. It also sends a warning notification through `ctx.ui`. Notifications are visible in UI-capable pi modes and are no-ops in modes without UI, while the modified tool result remains the agent-facing feedback channel.

An unexpected exception from root detection, server orchestration, reading, or formatting is caught at the entrypoint and logged. In that path the original tool result is left unchanged; unlike an expected unavailable server, the user and agent do not receive an explicit diagnostic-unavailable suffix.

The representative success path maps to code as follows:

```text
successful write/edit result
  -> admission and physical boundary check       index.ts
  -> nearest root and initialized server         src/server-manager.ts
  -> didOpen/didChange and diagnostic settling   src/client.ts
  -> error/warning rendering                     src/format.ts
  -> tool-result replacement and UI notice       index.ts
```

## State, ordering, and lifetime

The extension deliberately keeps diagnostic and process state in memory. Understanding which state is durable prevents “running,” “ready,” and “remembered” from being treated as the same thing.

| State | Owner | Lifetime and important invariant |
|---|---|---|
| Resolved server configuration | `index.ts` | One extension session or command-triggered reinitialization. It is available before any server starts. |
| Active initialized servers | `src/server-manager.ts` | One manager lifetime. Entries are keyed by server ID/root and are inserted only after initialization. |
| In-flight server starts | `src/server-manager.ts` | One spawn attempt. Concurrent callers for a key share one promise. |
| Missing server IDs | `src/server-manager.ts` | One manager lifetime. A missing binary disables that configured ID across roots until reinitialization. |
| Failed server roots | `src/server-manager.ts` | One manager lifetime. Initialization failure disables only that server ID/root key until reinitialization. |
| Open-document activity | each managed server | Until document-idle close, server shutdown, or manager replacement. Timestamps drive cleanup. |
| Document versions and latest diagnostics | `src/client.ts` | One protocol-client lifetime. `didClose` removes tracked target state; unsolicited URI state may also exist. |
| Current cross-file callback | `src/client.ts` | One diagnostic wait. The per-server edit queue prevents competing callbacks on one client. |
| Global configuration file | `src/config.ts` | Durable at `~/.pi-lsp-lite.json`; writes are serialized and replaced atomically. |
| Project configuration file | repository owner | Durable repository data read by the extension; pi-lsp-lite never writes it. |

Same-server ordering is the main attribution safeguard: document notifications, waits, and retries for that process do not overlap. The ordering boundary is intentionally per server/root, not global, so unrelated languages or roots do not block one another.

Global configuration writes have a separate process-wide promise lock. Each write deep-merges with the current file, writes formatted JSON to a random temporary file in the same directory, and renames it over the destination. This makes the file replacement atomic, but the following server-manager restart is a separate step rather than part of one transaction. Configuration is durable before new lazy servers exist.

Idle cleanup has two layers:

- every 60 seconds, the manager closes documents inactive longer than `documentIdleTimeout` (120 seconds by default);
- a server shuts down after a fixed 240 seconds without an edit or retry resetting its idle timer; this server-idle threshold is not configurable.

Session shutdown stops the sweep, asks every active server to shut down, and waits with `Promise.allSettled()` so one failure does not prevent cleanup attempts for the others.

## Configuration and trust boundaries

Configuration controls both harmless timing and executable process shape. The merge rules therefore distinguish settings a repository may influence from settings that remain under the user's global control.

The resolved order is:

1. authored built-in defaults from `src/languages.ts`;
2. global user configuration from `~/.pi-lsp-lite.json`;
3. the first valid project configuration found at `.pi-lsp-lite.json`, then `.pi/lsp-lite.json`.

If the first project path is absent or invalid, the loader tries the second. Two valid project files are not merged; the first path wins.

| Capability | Global config | Project config |
|---|---:|---:|
| Add a server ID | yes | no |
| Override command or arguments | yes | no |
| Override extensions or root markers | yes | no |
| Disable a resolved server | yes | yes |
| Set per-server timeout or retry count | yes | yes |
| Set top-level diagnostic/document-idle timeout | yes | yes |

A new global server requires at least `command` and `extensions`; arguments and root markers default to empty arrays. Existing global servers can replace executable shape. Project configuration may disable a server or tune timing, but attempts to add a server or replace `command`, `args`, `extensions`, or `rootPatterns` are logged and ignored. The extension does not call pi's project-trust API while loading these files; its direct defense is that project data cannot select an executable or alter executable arguments.

`disabled: true` removes the server from the resolved list for that manager. If global configuration removes a built-in, a later project layer cannot re-enable it because project configuration cannot reconstruct server shape. `/lsp-toggle` re-enables through global configuration instead. For custom servers, the global writer preserves their stored command and extension fields while changing `disabled` back to false.

Timeout precedence at edit time is:

1. a resolved per-server timeout from global or project config;
2. the server configuration's timeout, including built-in per-language defaults;
3. the resolved top-level default.

The built-in per-attempt defaults are 5 seconds for Go, 30 seconds for Rust, 30 seconds for TypeScript/JavaScript, 15 seconds for Python, and 15 seconds for C/C++. Values are clamped to these ranges:

| Setting | Range |
|---|---:|
| Diagnostic timeout | 1–60 seconds |
| Document-idle timeout | 10–600 seconds |
| Retry count | 0–10 |

Server IDs and object keys named `__proto__`, `constructor`, or `prototype` are rejected or skipped where global configuration is written or enumerated. The global writer also ignores undefined values and treats an explicit null in its internal merge input as deletion.

The interactive management commands write only global configuration. `/lsp-add` validates IDs and extensions, writes the server even when its command is not currently on `PATH`, then warns about the missing command. Remove and toggle operations change `disabled`. After each mutation, `initConfig()` shuts down the current manager and reloads all layers.

Configuration is not watched. Pi's `/reload` causes a new `session_start`, and mutating commands explicitly reinitialize; external edits otherwise take effect only on the next such lifecycle.

## Commands and operational visibility

The commands separate observation from mutation. Status and diagnostic inspection read current process memory, while add/remove/toggle persist global choices and restart the in-memory manager.

| Command | What it observes or changes | Durable effect |
|---|---|---|
| `/lsp-status` | Built-ins, active custom servers, disabled global entries, command availability, and initialized processes | none |
| `/lsp-diag [path]` | Current non-empty diagnostic cache across active clients, optionally filtered to one URI | none |
| `/lsp-add` | Adds or updates a global custom server through prompts | global config write |
| `/lsp-remove` | Selects an active server and writes `disabled: true` | global config write |
| `/lsp-toggle` | Enables or disables built-in, active, or globally known IDs | global config write |
| `/lsp-install` | Runs a confirmed install command for a missing built-in registry entry | external package/tool installation |

`/lsp-status` distinguishes configured/enabled, installed, and running state. A configured server can be enabled but missing, installed but not running, or running once per active root. The status builder resolves commands when invoked and combines those results with the manager's process list.

`/lsp-diag` is a view over current client memory, not a fresh analysis request. Empty diagnostic arrays are omitted from that cache, and manager replacement or server shutdown discards the state.

The four mutating commands require an interactive-capable context. `/lsp-install` considers only the built-in install registry; custom servers must be installed manually. After confirmation it invokes the registry string through the platform shell (`cmd.exe` on Windows or `sh -c` elsewhere), then reinitializes configuration. Installation commands therefore cross an explicit user-confirmation and process-execution boundary.

## Failure and recovery semantics

Expected failures are isolated as narrowly as the current ownership model permits. Some failures become explicit diagnostic results; others are logged and leave the original edit result untouched.

| Failure or trigger | Detection and scope | Result / recovery |
|---|---|---|
| Invalid or unreadable config | config loader | Log and continue with other layers/defaults. |
| Unsupported, missing, failed, or out-of-workspace file | entrypoint admission | Silently leave the original tool result unchanged. |
| Missing binary | command resolution before spawn | Mark the configured server ID unavailable for this manager lifetime; every root for that ID returns `unavailable`. |
| Initialization error or 10-second timeout | server/root spawn | Kill the child, mark only that server/root unavailable for this manager lifetime, return `unavailable`. |
| No relevant diagnostics before timeout | client wait | Retry up to `maxRetries`; return `timeout` with the last collected data when exhausted. |
| Child exits after initialization | process `exit` event | Remove that active server; a later edit may spawn it again. |
| Unexpected edit-path exception | entrypoint catch | Log it and preserve the original tool result without an availability suffix. |
| Idle server | 240 seconds since last edit/retry activity | Attempt protocol shutdown, then process termination. A later edit starts a new server. |
| Session or command reinitialization | lifecycle/command trigger | Shut down all active servers and discard in-memory diagnostic state. |

Graceful shutdown and process termination are distinct stages. The client gives the LSP `shutdown` request up to 5 seconds, sends `exit` when successful, then disposes the connection. The manager sends `SIGTERM` to a still-running child and escalates to `SIGKILL` after 2 seconds. Server stderr and process errors are written to the console with server/root context.

## Packaging and process boundaries

pi-lsp-lite is distributed as an npm pi package. `package.json` points pi at `index.ts`; pi loads the TypeScript extension directly rather than consuming a compiled bundle. The package requires Node.js 22.19 or newer.

Third-party runtime modules (`cross-spawn`, `vscode-languageserver-protocol`, and `which`) are normal dependencies. The pi coding-agent package and `typebox` are declared as peer dependencies. The npm package contains the entrypoint and `src/` implementation plus the README and license; `.npmignore` excludes tests, repository architecture/contributor docs, workflows, and development configuration.

There are two process boundaries:

- the pi process owns extension configuration, managers, cached diagnostics, commands, and formatting;
- each initialized language server is a child process rooted at one detected workspace and communicates over stdio JSON-RPC.

The only durable state written by the extension is global configuration and any external installation performed after confirmation. Diagnostics, process status, open-document state, retry state, and failed/missing-server suppression disappear when the manager or pi session ends.

CI typechecks and unit-tests on Ubuntu and Windows. Pull requests also run one real-server integration lane for each built-in server, with TypeScript additionally exercised on Windows. The release workflow runs typecheck and unit tests again before npm publication but does not itself rerun every integration lane.

Operational visibility is intentionally lightweight: console errors for configuration and process failures, inline tool-result diagnostics, UI notifications, `/lsp-status`, and `/lsp-diag`. There is no metrics, tracing, or persistent log subsystem owned by this package.

## Current limitations and deliberate exclusions

These boundaries are current behavior, not future promises:

- Only successful pi tools named `write` and `edit` trigger checking. Mutations made by shell commands or other tools do not.
- The target must already exist so `realpath()` can resolve it, and its physical path must be strictly inside the session workspace.
- Diagnostic feedback includes only errors and warnings; target output is capped at 50 diagnostic entries plus a truncation count.
- Same-server queue slots read current disk contents when they execute, so rapid edits need not preserve every intermediate file version.
- A continually publishing server can extend quiescence beyond its nominal per-attempt timeout.
- Rapid close/reopen can accept a delayed `publishDiagnostics` notification from the previous open because the protocol notification carries no local generation.
- Diagnostic waits do not consume `ctx.signal`; cancellation is not propagated into manager waits, retries, or backoff.
- Diagnostic and process state is memory-only and disappears on reload, command reinitialization, idle shutdown, or session shutdown.
- Custom global servers cannot configure per-extension `languageIds` through `UserConfig`; they fall back to their server ID.
- A project layer cannot re-enable a server removed by global configuration.
- `/lsp-install` covers only built-in registry entries and executes the confirmed registry string through a shell.
- Completion, hover, code actions, formatting, semantic tokens, and workspace edits are outside the package's scope.

## Technical reference

The preceding sections describe behavior first. This reference attaches that behavior to the stable module and test seams used to maintain it.

### Module and dependency map

| Module | Responsibility | Depends on | Used by |
|---|---|---|---|
| `index.ts` | Extension lifecycle, edit admission, commands, and result composition | every authored `src/` module plus pi/Node APIs | pi package loader |
| `src/languages.ts` | Built-in server shapes, extension matching, LSP language-ID mapping, overlap warnings | none | entrypoint, config, server manager, tests |
| `src/config.ts` | Config parsing, validation, source-specific merge rules, timeout resolution, durable global writes | languages and Node filesystem/path/OS/crypto APIs | entrypoint, server manager defaults, status types, tests |
| `src/util.ts` | File URI conversion, command resolution, bounded root search, physical cwd predicate | Node APIs and `which` | entrypoint, client, server manager, tests |
| `src/client.ts` | LSP JSON-RPC lifecycle, document versions, diagnostics, fingerprint diff, quiescence | protocol library, util, Node child-process type | server manager, formatter type, tests |
| `src/server-manager.ts` | Child-process lifecycle, root-keyed reuse, spawn deduplication, edit serialization, retries, cleanup | config defaults, client, languages, util, `cross-spawn`, Node APIs | entrypoint, status types, integration/unit tests |
| `src/format.ts` | Agent-facing target and related-file diagnostic rendering | client result type, protocol severity, Node path/URL APIs | entrypoint, tests |
| `src/install-registry.ts` | Built-in platform install command data and selection | process platform | entrypoint, status type, tests |
| `src/status.ts` | Configured/enabled/installed/running state model and rendering | types from config, languages, manager, install registry | entrypoint, tests |

Dependency direction points inward from `index.ts` toward focused modules. `client.ts` does not know about process pooling or pi events; `server-manager.ts` does not know how results are rendered or appended; pure language/install/status helpers do not import the entrypoint. Tests replace the external language server at the protocol or process boundary rather than embedding test switches in production modules.

### Key units and seams

| Unit | Role and contract | Principal test or replacement seam |
|---|---|---|
| default extension factory | Registers hooks/commands and owns session-level manager replacement | manual `pi -e ./index.ts`; entrypoint behavior is otherwise indirectly covered |
| `loadConfig()` | Resolves built-in, global, and project layers into server/timing state | `test/config.test.ts` with temporary files |
| `writeGlobalConfig()` | Serializes deep-merge writes through temp-file replacement | `test/config.test.ts` with injected global path |
| `languageForFile()` / `languageIdForFile()` | Select configured server and per-file LSP identifier | `test/languages.test.ts` |
| `findWorkspaceRoot()` / `isInsideCwd()` | Own nearest-root and physical-workspace predicates | `test/util.test.ts`, `test/boundary.test.ts` |
| `createServerManager()` | Own one initialized process per server/root, queue edits, retry, and clean up | `test/server-manager.test.ts`; injectable options/config; fake process command |
| `createLspClient()` | Bridge stdio protocol notifications into one settled `DiagnosticResult` | `test/client.test.ts` plus `test/fake-server.ts` |
| `formatDiagnostics()` | Render explicit clean/timeout/unavailable and cross-file outcomes | `test/format.test.ts` |
| `buildServerStates()` / `formatServerStates()` | Combine configuration, binary lookup, and running-process views | `test/status.test.ts` with injected resolver/state |
| `installRegistry` / `installCommandFor()` | Own supported automatic installation commands | `test/install-registry.test.ts` |
| real-server suites | Verify syntax, clean-file, and selected cross-file behavior against supported servers | `test/integration/*.test.ts`, gated by `INTEGRATION` |

The fake server can delay, suppress, or defer publications; crash during initialization; hang on shutdown; and emit related-file diagnostics. Existing close/reopen coverage waits for a delayed publication before reopening. It does not cover reopening first and then receiving a publication from the previous open, which is why this architecture records that race as a current limitation rather than an invariant.
