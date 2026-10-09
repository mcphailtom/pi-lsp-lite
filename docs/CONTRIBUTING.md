# Contributing

## Setup

Use Node.js 22.19 or newer.

```bash
git clone https://github.com/mcphailtom/pi-lsp-lite
cd pi-lsp-lite
npm install
```

## Development workflow

```bash
# typecheck
npm run check

# unit tests (no real language servers required)
npm test

# all real-server integration tests (servers must be on PATH)
npm run test:integration

# test the extension in pi
pi -e ./index.ts
```

The full integration command expects `gopls`, `rust-analyzer`, `typescript-language-server`, `pylsp`, and `clangd`. During focused development, run the affected suite directly with `INTEGRATION=1 npx tsx --test test/integration/<server>.test.ts`.

## Documentation ownership

Each document has one job:

- [ARCHITECTURE.md](ARCHITECTURE.md) describes implemented current state: runtime flow, ownership, state, trust boundaries, failure semantics, process boundaries, limitations, and test seams.
- The repository `README.md` is the end-user contract for installation, supported servers, commands, configuration, and visible behavior.
- This guide owns contributor setup, validation, and documentation-maintenance expectations.
- Proposed work and sequencing belong in an issue, pull request, or project plan—not in current-state architecture.

Before accepting a change to runtime behavior, ownership, configuration, security, process lifecycle, or deployment:

1. compare the diff with the affected architecture sections and invariants;
2. update the architecture in the same logical change, or explicitly confirm that the implemented model did not change;
3. update the README only when installation, commands, configuration, supported behavior, or user-visible output changed;
4. remove retired current-state descriptions instead of preserving implementation history in normative sections.

`ARCHITECTURE.md` records `Validated against commit: <sha>`. Advance that marker only after source, tests, and architecture agree. A documentation-only clarification may continue to name the code commit it actually validated.

## Tests

### Unit tests (`test/*.test.ts`)

Unit tests use `node:test` and `node:assert/strict`. The fake LSP server in `test/fake-server.ts` speaks JSON-RPC over stdio and can delay or suppress diagnostics, crash during initialization, hang during shutdown, defer publication to a later attempt, and publish related-file diagnostics. No real language server is required.

Place focused tests beside the owning module as `test/<module>.test.ts`. Extend the fake server only when a protocol or lifecycle behavior cannot be exercised through its existing options; do not add production test switches.

### Integration tests (`test/integration/*.test.ts`)

Integration suites are guarded by `process.env.INTEGRATION`. Each suite shares a warm server instance within one temporary workspace and uses polling where real servers publish asynchronously.

Add or change integration coverage when behavior depends on a real server rather than the fake protocol boundary. Keep fixtures temporary and clean them up in suite teardown.

### Choosing validation

- Documentation-only changes: verify links and rendered Markdown; run `npm run check && npm test` to prove the documented baseline remains green.
- Type/config/formatting changes: run `npm run check`, `npm test`, and the focused affected test file while iterating.
- Language-server behavior changes: also run the affected real-server integration suite when the binary is available.
- Package-boundary changes: inspect `npm pack --dry-run --json` so published contents and runtime dependencies are explicit.

Pull requests run typecheck and unit tests on Ubuntu and Windows plus required real-server jobs for Go, Rust, TypeScript, Python, and C/C++. A missing local binary is validation coverage to report, not a reason to claim that integration passed.

## Adding a built-in language

Adding a language crosses configuration, process, test, installation, and documentation seams. Complete the applicable steps rather than treating `src/languages.ts` as the whole feature:

1. Add the server definition and root markers to `builtinLanguages` in `src/languages.ts`.
2. Add `languageIds` when different extensions handled by the server require different LSP identifiers.
3. Add an `installRegistry` entry and platform-specific command only when `/lsp-install` should manage that server; otherwise document manual installation.
4. Add focused language/config/install/status tests for the new data and edge cases.
5. Add a real-server suite under `test/integration/` and a required CI job.
6. Update the architecture's supported-flow and technical-reference sections.
7. Update the README support/install tables and any package description or keywords affected by the new language.

Globally configured custom servers do not require repository changes, but their configuration is limited to the fields accepted by `UserConfig`.

## Code style

- TypeScript strict mode and ESM.
- `noUnusedLocals` and `noUnusedParameters` remain enabled.
- Prefer factory functions and explicit typed boundaries over class or wrapper indirection that does not simplify ownership.
- Comments explain only non-obvious invariants, security boundaries, or protocol behavior; do not narrate straightforward code.
- Keep feature logic in its owning module rather than scattering server-specific conditionals through shared paths.
- Commit messages are lowercase sentence fragments with one logical change per commit.

There is no generated documentation or formatter step in the repository. Preserve the surrounding style and keep exported contracts legible through names and types; assess any broader API/document-comment standard as an explicit repository decision rather than adding ad hoc comments.

## Submitting changes

- Re-read every file before editing and avoid unrelated cleanup.
- Run `npm run check && npm test` before pushing.
- Run focused integration or package validation required by the changed boundary.
- Confirm architecture and README impact explicitly.
- Keep one logical change per commit.
- All pull requests must pass the repository's required typecheck/unit and five real-server integration checks.
