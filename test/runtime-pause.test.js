"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

function loadRuntimeWithFakes(initialConfig = {}) {
  const counters = {
    serverInit: 0,
    serverStart: 0,
    serverCleanup: 0,
    stateInit: 0,
    stateCleanup: 0,
    monitorStarts: 0,
    monitorStops: 0,
    context: new Map(),
  };
  const config = new Map(Object.entries({
    "runtime.enabled": true,
    "integrations.enabled": true,
    theme: "clawd",
    ...initialConfig,
  }));
  const posts = [];

  const fakeVscode = {
    ConfigurationTarget: { Global: 1 },
    Uri: {
      file: (filePath) => ({ fsPath: filePath }),
      joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath || "", ...parts) }),
    },
    commands: {
      executeCommand: async (command, key, value) => {
        if (command === "setContext") counters.context.set(key, value);
        return undefined;
      },
    },
    workspace: {
      getConfiguration: () => ({
        get: (key, defaultValue) => config.has(key) ? config.get(key) : defaultValue,
        update: async (key, value) => {
          config.set(key, value);
        },
      }),
    },
    window: {
      terminals: [],
    },
  };

  class FakeMonitor {
    start() {
      counters.monitorStarts++;
    }
    stop() {
      counters.monitorStops++;
    }
  }

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    const normalized = String(request).replace(/\\/g, "/");
    if (request === "vscode") return fakeVscode;
    if (normalized.endsWith("/vendor/clawd/src/state")) {
      return (ctx) => {
        counters.stateInit++;
        return {
          STATE_SVGS: { idle: "idle.svg", paused: "idle.svg" },
          STATE_PRIORITY: {},
          sessions: new Map(),
          startStaleCleanup() {},
          cleanup() { counters.stateCleanup++; },
          applyState(state, svg) { ctx.sendToRenderer("state-change", state, svg); },
          refreshTheme() {},
          getCurrentState() { return "idle"; },
          getSvgOverride() { return null; },
          enableDoNotDisturb() { ctx.doNotDisturb = true; },
          disableDoNotDisturb() { ctx.doNotDisturb = false; },
          setState(state, svg) { ctx.sendToRenderer("state-change", state, svg); },
          updateSession() {},
        };
      };
    }
    if (normalized.endsWith("/vendor/clawd/src/server")) {
      return () => {
        counters.serverInit++;
        return {
          startHttpServer() { counters.serverStart++; },
          cleanup() { counters.serverCleanup++; },
          getHookServerPort() { return 23333; },
        };
      };
    }
    if (
      normalized.endsWith("/vendor/clawd/agents/codex-log-monitor")
      || normalized.endsWith("/vendor/clawd/agents/gemini-log-monitor")
    ) {
      return FakeMonitor;
    }
    if (
      normalized.endsWith("/vendor/clawd/agents/codex")
      || normalized.endsWith("/vendor/clawd/agents/gemini-cli")
    ) {
      return {};
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const runtimePath = require.resolve("../src/runtime.js");
  delete require.cache[runtimePath];
  const runtimeModule = require(runtimePath);
  const runtime = new runtimeModule.ClawdRuntime(
    { globalStorageUri: { fsPath: path.join(os.tmpdir(), `clawd-runtime-test-${process.pid}`) } },
    { appendLine() {} }
  );
  runtime.attachView({
    post(type, payload) {
      posts.push({ type, payload });
    },
    asWebviewUri(filePath) {
      return `vscode-resource:${filePath}`;
    },
  });

  return {
    runtime,
    counters,
    config,
    posts,
    restore() {
      Module._load = originalLoad;
      delete require.cache[runtimePath];
    },
  };
}

test("start sends a paused snapshot without starting server or monitors when runtime is disabled", async () => {
  const harness = loadRuntimeWithFakes({ "runtime.enabled": false });
  try {
    await harness.runtime.start();
    const init = harness.posts.find((post) => post.type === "init");

    assert.equal(harness.counters.serverInit, 0);
    assert.equal(harness.counters.serverStart, 0);
    assert.equal(harness.counters.monitorStarts, 0);
    assert.equal(init.payload.paused, true);
    assert.equal(init.payload.serverPort, null);
    assert.equal(init.payload.state, "paused");
    assert.deepEqual(init.payload.sessions, []);
    assert.deepEqual(init.payload.permissions, []);
  } finally {
    harness.restore();
  }
});

test("pause stops monitors, closes runtime, clears config-visible permissions", async () => {
  const harness = loadRuntimeWithFakes();
  try {
    await harness.runtime.start();
    let destroyed = false;
    harness.runtime.pendingPermissions.push({
      _clawdId: "perm-1",
      res: {
        writableEnded: false,
        destroyed: false,
        removeListener() {},
        destroy() { destroyed = true; this.destroyed = true; },
      },
      abortHandler() {},
    });

    const result = await harness.runtime.pause();

    assert.equal(result.message, "Clawd runtime paused.");
    assert.equal(harness.config.get("runtime.enabled"), false);
    assert.equal(harness.counters.monitorStops, 2);
    assert.equal(harness.counters.stateCleanup, 1);
    assert.equal(harness.counters.serverCleanup, 1);
    assert.equal(destroyed, true);
    assert.deepEqual(harness.runtime.pendingPermissions, []);
    assert.equal(harness.posts.some((post) => post.type === "permission-hide" && post.payload.id === "perm-1"), true);
  } finally {
    harness.restore();
  }
});

test("restart from paused enables and starts the runtime", async () => {
  const harness = loadRuntimeWithFakes({ "runtime.enabled": false });
  try {
    await harness.runtime.restart();

    assert.equal(harness.config.get("runtime.enabled"), true);
    assert.equal(harness.counters.serverInit, 1);
    assert.equal(harness.counters.serverStart, 1);
    assert.equal(harness.counters.monitorStarts, 2);
    assert.equal(harness.posts.some((post) => post.type === "init" && post.payload.paused === false), true);
  } finally {
    harness.restore();
  }
});
