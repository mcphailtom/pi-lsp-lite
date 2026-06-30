import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildServerStates, formatServerStates } from "../src/status.js";
import type { InstallEntry } from "../src/install-registry.js";
import type { LanguageServerConfig } from "../src/languages.js";

const builtinTs: LanguageServerConfig = {
  id: "typescript",
  extensions: [".ts"],
  command: "typescript-language-server",
  args: ["--stdio"],
  rootPatterns: ["tsconfig.json"],
};

const customLua: LanguageServerConfig = {
  id: "lua",
  extensions: [".lua"],
  command: "lua-language-server",
  args: [],
  rootPatterns: [".luarc.json"],
};

const installRegistry = new Map<string, InstallEntry>([
  ["typescript", { command: { default: "npm install -g typescript-language-server typescript" }, description: "TypeScript" }],
]);

describe("buildServerStates", () => {
  it("includes built-ins, active custom servers, and disabled global servers", async () => {
    const states = await buildServerStates({
      builtins: [builtinTs],
      active: [builtinTs, customLua],
      globalConfig: {
        servers: {
          haskell: {
            disabled: true,
            command: "haskell-language-server-wrapper",
            extensions: [".hs"],
          },
        },
      },
      running: [
        {
          id: "typescript",
          root: "/repo",
          pid: 123,
          uptime: 5_000,
          openDocuments: 2,
          lastActivity: Date.now(),
        },
      ],
      installRegistry,
      resolveCommand: async (command) => command === "typescript-language-server" ? "/bin/typescript-language-server" : null,
    });

    assert.deepEqual(states.map((s) => s.id), ["haskell", "lua", "typescript"]);

    const typescript = states.find((s) => s.id === "typescript");
    assert.ok(typescript);
    assert.equal(typescript.enabled, true);
    assert.equal(typescript.installed, true);
    assert.equal(typescript.installable, true);
    assert.equal(typescript.running.length, 1);

    const lua = states.find((s) => s.id === "lua");
    assert.ok(lua);
    assert.equal(lua.enabled, true);
    assert.equal(lua.installed, false);
    assert.equal(lua.installable, false);

    const haskell = states.find((s) => s.id === "haskell");
    assert.ok(haskell);
    assert.equal(haskell.enabled, false);
    assert.equal(haskell.command, "haskell-language-server-wrapper");
    assert.equal(haskell.installed, false);
  });
  it("uses global command overrides when a built-in is disabled", async () => {
    const states = await buildServerStates({
      builtins: [builtinTs],
      active: [],
      globalConfig: {
        servers: {
          typescript: {
            disabled: true,
            command: "custom-typescript-language-server",
          },
        },
      },
      running: [],
      installRegistry,
      resolveCommand: async (command) => command === "custom-typescript-language-server" ? "/bin/custom-typescript-language-server" : null,
    });

    const typescript = states.find((s) => s.id === "typescript");
    assert.ok(typescript);
    assert.equal(typescript.enabled, false);
    assert.equal(typescript.command, "custom-typescript-language-server");
    assert.equal(typescript.installed, true);
  });
});

describe("formatServerStates", () => {
  it("shows installed/running and missing/manual states", () => {
    const output = formatServerStates([
      {
        id: "typescript",
        command: "typescript-language-server",
        enabled: true,
        installed: true,
        installable: true,
        running: [{ id: "typescript", root: "/repo", pid: 123, uptime: 5_000, openDocuments: 2, lastActivity: Date.now() }],
      },
      {
        id: "lua",
        command: "lua-language-server",
        enabled: true,
        installed: false,
        installable: false,
        running: [],
      },
    ]);

    assert.match(output, /typescript — enabled — installed — running pid=123 root=\/repo/);
    assert.match(output, /lua — enabled — missing — not running — cmd=lua-language-server — manual install required/);
  });
});
