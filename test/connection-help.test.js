"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { connectionItems, showConnectionHelp } = require("../src/connection-help");

const status = (codex = {}) => ({ enabled: true, selectedAgents: ["claude-code", "codex"], installedAgents: ["claude-code"], claudeObserved: false, codex: { installed: true, hookObserved: false, logFallbackRunning: true, ...codex } });

test("connection guide distinguishes installed hooks from observed native events", () => {
  const fallback = connectionItems(status()).find((item) => item.action === "codex");
  assert.equal(fallback.description, "Basic activity tracking");
  assert.match(fallback.detail, /Start a Codex task/);
  assert.match(fallback.detail, /If Codex shows Review hooks/);
  const observed = connectionItems(status({ hookObserved: true })).find((item) => item.action === "codex");
  assert.equal(observed.description, "Live events received");
  assert.match(observed.detail, /actual permission requests/);
  assert.equal(connectionItems({ ...status(), enabled: false })[0].action, "resume");
});

test("hook guide opens installed Codex without granting trust or sending a prompt", async () => {
  const calls = [];
  const vscode = {
    window: {
      showQuickPick: async (items) => items.find((item) => item.action === "explain"),
      showInformationMessage: async (message, options) => {
        calls.push({ message, ...(options && options.modal ? { detail: options.detail } : {}) });
        return options && options.modal ? "Open Codex" : undefined;
      },
    },
    commands: { getCommands: async () => ["chatgpt.openSidebar"], executeCommand: async (id) => calls.push({ command: id }) },
  };
  await showConnectionHelp(vscode, { connectionStatus: () => status() });
  assert.deepEqual(calls.filter((item) => item.command), [{ command: "chatgpt.openSidebar" }]);
  assert.match(calls[0].detail, /same computer or SSH host/);
  assert.match(calls[0].detail, /request only/);
  assert.match(calls.at(-1).message, /Allow selected/);
});

test("hook guide gives CLI instructions when Codex extension is unavailable", async () => {
  const messages = [];
  await showConnectionHelp({
    window: { showQuickPick: async () => ({ action: "codex" }), showInformationMessage: async (message, options) => { messages.push(message); return options && options.modal ? "Open Codex" : undefined; } },
    commands: { getCommands: async () => [], executeCommand: async () => assert.fail("must not invoke a missing command") },
  }, { connectionStatus: () => status() });
  assert.match(messages.at(-1), /CLI.*\/hooks/);
});

test("enabled but stopped connections offer a working restart action", async () => {
  const stopped = { ...status(), running: false };
  assert.equal(connectionItems(stopped)[0].action, "restart");
  assert.equal(connectionItems({ ...stopped, enabled: false })[0].action, "resume");
  assert.equal(connectionItems({ ...stopped, running: true }).some((item) => item.action === "restart"), false);
  let restarts = 0;
  await showConnectionHelp({
    window: { showQuickPick: async (items) => items.find((item) => item.action === "restart") },
  }, { connectionStatus: () => stopped, restart: async () => { restarts++; } });
  assert.equal(restarts, 1);
});

test("disabled Codex hooks explain the setting before trust review without changing it", async () => {
  const disabled = status({ disabledInUserConfig: true, hookObserved: true });
  const item = connectionItems(disabled).find((entry) => entry.action === "codex-disabled");
  assert.match(item.description, /disabled.*settings/);
  assert.match(item.detail, /Review alone does not enable/);
  const messages = [];
  const urls = [];
  await showConnectionHelp({
    window: {
      showQuickPick: async (items) => items.find((entry) => entry.action === "codex-disabled"),
      showInformationMessage: async (message, options) => { messages.push({ message, ...options }); return "Official Guide"; },
    },
    Uri: { parse: (url) => url },
    env: { openExternal: async (url) => urls.push(url) },
    commands: { executeCommand: async () => assert.fail("guidance must not install hooks or change settings") },
  }, { connectionStatus: () => disabled });
  assert.match(messages[0].detail, /hooks = true.*\[features\]/);
  assert.match(messages[0].detail, /restart Codex.*review/);
  assert.deepEqual(urls, ["https://learn.chatgpt.com/docs/hooks#turn-hooks-off"]);
});
