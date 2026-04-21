"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { unregisterHooks } = require("../vendor/clawd/hooks/install");
const { unregisterGeminiHooks } = require("../vendor/clawd/hooks/gemini-install");
const { unregisterCursorHooks } = require("../vendor/clawd/hooks/cursor-install");
const { unregisterCodeBuddyHooks } = require("../vendor/clawd/hooks/codebuddy-install");
const { unregisterKiroHooks } = require("../vendor/clawd/hooks/kiro-install");
const { unregisterOpencodePlugin } = require("../vendor/clawd/hooks/opencode-install");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clawd-uninstall-test-"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

test("Claude unregister removes Clawd command and HTTP hooks only", () => {
  const settingsPath = path.join(tempDir(), "settings.json");
  writeJson(settingsPath, {
    hooks: {
      SessionStart: [
        { type: "command", command: "\"/usr/bin/node\" \"/app/clawd-hook.js\" SessionStart" },
        { type: "command", command: "echo user" },
      ],
      PermissionRequest: [
        { type: "http", url: "http://127.0.0.1:23333/permission", timeout: 600 },
        { type: "http", url: "http://example.test/permission", timeout: 600 },
      ],
    },
  });

  const result = unregisterHooks({ settingsPath });
  const settings = readJson(settingsPath);

  assert.equal(result.removed, 2);
  assert.deepEqual(settings.hooks.SessionStart, [{ type: "command", command: "echo user" }]);
  assert.deepEqual(settings.hooks.PermissionRequest, [
    { type: "http", url: "http://example.test/permission", timeout: 600 },
  ]);
});

test("Gemini unregister preserves unrelated flat hooks", () => {
  const settingsPath = path.join(tempDir(), "settings.json");
  writeJson(settingsPath, {
    hooks: {
      BeforeTool: [
        { type: "command", command: "\"/usr/bin/node\" \"/app/gemini-hook.js\"" },
        { type: "command", command: "echo user" },
      ],
    },
  });

  const result = unregisterGeminiHooks({ settingsPath, silent: true });
  const settings = readJson(settingsPath);

  assert.deepEqual(result, { removed: 1, changed: true });
  assert.deepEqual(settings.hooks.BeforeTool, [{ type: "command", command: "echo user" }]);
});

test("Cursor unregister preserves unrelated flat hooks", () => {
  const hooksPath = path.join(tempDir(), "hooks.json");
  writeJson(hooksPath, {
    version: 1,
    hooks: {
      preToolUse: [
        { command: "\"/usr/bin/node\" \"/app/cursor-hook.js\"" },
        { command: "echo user" },
      ],
    },
  });

  const result = unregisterCursorHooks({ hooksPath, silent: true });
  const settings = readJson(hooksPath);

  assert.deepEqual(result, { removed: 1, changed: true });
  assert.deepEqual(settings.hooks.preToolUse, [{ command: "echo user" }]);
});

test("CodeBuddy unregister removes nested Clawd command and local permission hook only", () => {
  const settingsPath = path.join(tempDir(), "settings.json");
  writeJson(settingsPath, {
    hooks: {
      PreToolUse: [
        {
          matcher: "",
          hooks: [
            { type: "command", command: "\"/usr/bin/node\" \"/app/codebuddy-hook.js\"" },
            { type: "command", command: "echo user" },
          ],
        },
      ],
      PermissionRequest: [
        {
          matcher: "",
          hooks: [
            { type: "http", url: "http://127.0.0.1:23333/permission", timeout: 600 },
            { type: "http", url: "http://example.test/permission", timeout: 600 },
          ],
        },
      ],
    },
  });

  const result = unregisterCodeBuddyHooks({ settingsPath, silent: true });
  const settings = readJson(settingsPath);

  assert.deepEqual(result, { removed: 2, changed: true });
  assert.deepEqual(settings.hooks.PreToolUse, [
    { matcher: "", hooks: [{ type: "command", command: "echo user" }] },
  ]);
  assert.deepEqual(settings.hooks.PermissionRequest, [
    { matcher: "", hooks: [{ type: "http", url: "http://example.test/permission", timeout: 600 }] },
  ]);
});

test("Kiro unregister edits agent configs and preserves clawd.json", () => {
  const agentsDir = path.join(tempDir(), "agents");
  writeJson(path.join(agentsDir, "dev.json"), {
    name: "dev",
    hooks: {
      preToolUse: [
        { command: "\"/usr/bin/node\" \"/app/kiro-hook.js\"" },
        { command: "echo user" },
      ],
    },
  });
  writeJson(path.join(agentsDir, "clawd.json"), {
    name: "clawd",
    description: "custom user edits",
    hooks: {
      stop: [{ command: "\"/usr/bin/node\" \"/app/kiro-hook.js\"" }],
    },
  });

  const result = unregisterKiroHooks({ agentsDir, silent: true });

  assert.equal(result.removed, 2);
  assert.equal(result.changed, true);
  assert.deepEqual(result.files.sort(), ["clawd.json", "dev.json"]);
  assert.equal(readJson(path.join(agentsDir, "clawd.json")).description, "custom user edits");
  assert.deepEqual(readJson(path.join(agentsDir, "dev.json")).hooks.preToolUse, [{ command: "echo user" }]);
  assert.equal(readJson(path.join(agentsDir, "clawd.json")).hooks.stop, undefined);
});

test("opencode unregister preserves package plugins and removes absolute Clawd plugin paths", () => {
  const configPath = path.join(tempDir(), "opencode.json");
  writeJson(configPath, {
    plugin: [
      "opencode-wakatime",
      "@vendor/opencode-plugin",
      "/Users/me/App.app/Contents/Resources/app.asar.unpacked/hooks/opencode-plugin",
      "/Users/me/other-plugin",
    ],
  });

  const result = unregisterOpencodePlugin({
    configPath,
    pluginDir: "/new/location/hooks/opencode-plugin",
    silent: true,
  });
  const settings = readJson(configPath);

  assert.equal(result.removed, 1);
  assert.deepEqual(settings.plugin, [
    "opencode-wakatime",
    "@vendor/opencode-plugin",
    "/Users/me/other-plugin",
  ]);
});
