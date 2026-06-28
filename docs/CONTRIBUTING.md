# Contributing

## Setup

```bash
git clone https://github.com/mcphailtom/pi-lsp-lite
cd pi-lsp-lite
npm install
```

## Development workflow

```bash
# typecheck
npm run check

# unit tests (no servers required)
npm test

# integration tests (requires gopls, rust-analyzer, typescript-language-server, pylsp, clangd on PATH)
npm run test:integration

# test in pi
pi -e ./index.ts
```

## Project structure

See [ARCHITECTURE.md](ARCHITECTURE.md) for module layout and design decisions.

## Tests

### Unit tests (`test/*.test.ts`)

Use a fake LSP server (`test/fake-server.ts`) that speaks JSON-RPC over stdio with configurable behaviour (delays, crashes, canned diagnostics). No real language servers needed.

### Integration tests (`test/integration/*.test.ts`)

Guarded by `process.env.INTEGRATION`. Each suite shares a warm server instance within a single workspace. Tests use polling patterns for assertions to handle async diagnostic publishing. Require real servers on PATH.

Run with:

```bash
npm run test:integration
```

### Adding tests

- Unit tests go in `test/<module>.test.ts`
- Integration tests go in `test/integration/<server>.test.ts`
- Use `node:test` and `node:assert/strict`
- The fake server supports options via `--options=<json>` CLI arg

## Adding a language

1. Add a config entry to `src/languages.ts`
2. Add an integration test in `test/integration/<server>.test.ts`
3. Update the prerequisites table in `README.md`

## Code style

- TypeScript strict mode, ESM
- `noUnusedLocals` and `noUnusedParameters` enabled
- Factory functions over classes
- No comments unless the code genuinely can't carry the meaning
- Commit messages are plain lowercase sentence fragments

## Submitting changes

- One logical change per commit
- All PRs require CI to pass (typecheck + unit tests + 5 per-server integration jobs)
- Run `npm run check && npm test` before pushing
- Integration tests run automatically on PR via per-server CI jobs
