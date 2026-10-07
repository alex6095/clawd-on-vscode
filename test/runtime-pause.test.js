"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

function loadRuntimeWithFakes(initialConfig = {}, options = {}) {
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
    if (normalized.endsWith("/vendor/clawd/hooks/codex-install")) {
      return { getCodexHookStatus: () => ({ installed: false }) };
    }
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
          startHttpServer() { counters.serverStart++; return options.startGate; },
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
    vscode: fakeVscode,
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
    assert.equal(harness.counters.monitorStops, 1);
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
    assert.equal(harness.counters.monitorStarts, 1);
    assert.equal(harness.posts.some((post) => post.type === "init" && post.payload.paused === false), true);
  } finally {
    harness.restore();
  }
});

test("concurrent starts create only one server and one selected monitor", async () => {
  const harness = loadRuntimeWithFakes();
  try {
    await Promise.all([harness.runtime.start(), harness.runtime.start(), harness.runtime.start()]);
    assert.equal(harness.counters.serverStart, 1);
    assert.equal(harness.counters.monitorStarts, 1);
  } finally { harness.runtime.dispose(); harness.restore(); }
});

test("single Resume action restores legacy-disabled integrations and observation", async () => {
  const harness = loadRuntimeWithFakes({ "runtime.enabled": false, "integrations.enabled": false });
  try {
    await harness.runtime.resume();
    assert.equal(harness.config.get("integrations.enabled"), true);
    assert.equal(harness.runtime.isAgentEnabled("codex"), true);
    assert.equal(harness.counters.monitorStarts, 1);
    assert.equal(harness.posts.at(-1).payload.connectionState, "connected");
    await harness.runtime.toggleDnd();
    assert.equal(harness.counters.context.get("clawd.dnd"), true);
  } finally { harness.runtime.dispose(); harness.restore(); }
});

test("failed startup publishes a disconnected status instead of an endless startup", async () => {
  const harness = loadRuntimeWithFakes({}, { startGate: Promise.resolve().then(() => { throw new Error("bind failed"); }) });
  try {
    await assert.rejects(harness.runtime.start(), /bind failed/);
    assert.equal(harness.posts.at(-1).payload.connectionState, "disconnected");
    assert.equal(harness.runtime.started, false);
    assert.equal(harness.runtime.diagnostics().runtime, "disconnected");
  } finally { harness.runtime.dispose(); harness.restore(); }
});

test("quiet notifications can change while paused without resuming activity", async () => {
  const harness = loadRuntimeWithFakes({ "runtime.enabled": false });
  try {
    await harness.runtime.toggleDnd();
    assert.equal(harness.runtime.doNotDisturb, true);
    assert.equal(harness.counters.context.get("clawd.dnd"), true);
    assert.equal(harness.counters.serverStart, 0);
    assert.equal(harness.config.get("runtime.enabled"), false);
    assert.equal(harness.posts.at(-1).payload.dnd, true);
  } finally { harness.runtime.dispose(); harness.restore(); }
});

test("disabling the runtime during server startup closes the eventual listener", async () => {
  let release;
  const startGate = new Promise((resolve) => { release = resolve; });
  const harness = loadRuntimeWithFakes({}, { startGate });
  try {
    const pending = harness.runtime.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.counters.serverStart, 1);
    harness.config.set("runtime.enabled", false);
    release();
    await pending;
    assert.equal(harness.runtime.started, false);
    assert.equal(harness.counters.serverCleanup, 1);
    assert.equal(harness.counters.monitorStarts, 0);
  } finally { harness.runtime.dispose(); harness.restore(); }
});

test("handoff and sidebar shutdown reply neutrally instead of leaving approval pending", async () => {
  const harness = loadRuntimeWithFakes();
  try {
    let response;
    const entry = { _clawdId: "approval", sessionId: "codex:a", res: {
      removeListener() {}, writeHead(status) { assert.equal(status, 200); }, end(body) { response = JSON.parse(body); },
    } };
    harness.runtime.pendingPermissions.push(entry);
    harness.runtime.decidePermission("approval", "deny-and-focus");
    assert.deepEqual(response, {});
    assert.equal(harness.runtime.pendingPermissions.length, 0);
  } finally { harness.restore(); }
});

test("Codex approval never emits Claude-only updatedPermissions fields", () => {
  const harness = loadRuntimeWithFakes();
  try {
    let response;
    const entry = { _clawdId: "approval", agentId: "codex", resolvedSuggestion: { type: "setMode", mode: "bypassPermissions" }, res: {
      writeHead() {}, end(body) { response = JSON.parse(body); },
    } };
    harness.runtime.pendingPermissions.push(entry);
    harness.runtime.resolvePermissionEntry(entry, "allow");
    assert.deepEqual(response, { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
  } finally { harness.restore(); }
});

test("workspace filtering respects directory boundaries and native hooks override log fallback", async () => {
  const harness = loadRuntimeWithFakes();
  try {
    harness.vscode.workspace.workspaceFolders = [{ uri: { fsPath: path.resolve("/project") } }];
    await harness.runtime.start();
    const updates = [];
    harness.runtime.state.updateSession = (...args) => updates.push(args);
    harness.runtime.ingestSession("codex:1", "thinking", "UserPromptSubmit", { agentId: "codex", cwd: path.resolve("/project/sub"), sourcePid: 42 });
    harness.runtime.ingestSession("codex:1", "idle", "Log", { agentId: "codex", cwd: path.resolve("/project") }, "log");
    harness.runtime.ingestSession("codex:2", "thinking", "Log", { agentId: "codex", cwd: path.resolve("/project-other") }, "log");
    assert.equal(updates.length, 1);
    assert.equal(updates[0][3].sourcePid, 42);
    assert.equal(updates[0][3].source, "hook");
  } finally { harness.runtime.dispose(); harness.restore(); }
});

test("session terminal focus chooses the requested session PID", async () => {
  const harness = loadRuntimeWithFakes();
  try {
    await harness.runtime.start();
    const focused = [];
    harness.vscode.window.terminals = [11, 22].map((pid) => ({ processId: Promise.resolve(pid), show() { focused.push(pid); } }));
    harness.runtime.state.sessions.set("second", { sourcePid: 33, pidChain: [33, 22] });
    assert.equal(await harness.runtime.focusTerminalForSession("second"), true);
    assert.deepEqual(focused, [22]);
  } finally { harness.runtime.dispose(); harness.restore(); }
});

test("HTTP log events preserve their source and do not disable local fallback", async () => {
  const harness = loadRuntimeWithFakes();
  try {
    await harness.runtime.start();
    const updates = [];
    harness.runtime.state.updateSession = (...args) => updates.push(args);
    harness.runtime.createServerContext().updateSession("codex:remote", "working", "PreToolUse", { agentId: "codex", source: "log" });
    harness.runtime.ingestSession("codex:remote", "attention", "Stop", { agentId: "codex" }, "log");
    assert.equal(updates.length, 2);
    assert.equal(updates[0][3].source, "log");
    assert.equal(harness.runtime.hookSessions.has("codex:remote"), false);
  } finally { harness.runtime.dispose(); harness.restore(); }
});

test("untrusted workspaces do not start a hook server", async () => {
  const harness = loadRuntimeWithFakes();
  try {
    harness.vscode.workspace.isTrusted = false;
    await harness.runtime.start();
    assert.equal(harness.counters.serverStart, 0);
    assert.equal(harness.counters.monitorStarts, 0);
  } finally { harness.restore(); }
});

test("renderer snapshots serialize only available theme leisure animations", async () => {
  for (const theme of ["clawd", "calico", "neobjuk"]) {
    const harness = loadRuntimeWithFakes({ theme, "runtime.enabled": false });
    try {
      await harness.runtime.start();
      const config = harness.posts.find((post) => post.type === "init").payload.config;
      assert.ok(config.idleAnimations.length, `${theme} exposes leisure reactions`);
      for (const animation of config.idleAnimations) {
        assert.ok(config.assetMap[animation.file], `${theme}:${animation.file} has an asset URI`);
        assert.ok(animation.duration >= 1000 && animation.duration <= 8000);
        assert.ok(!/working|thinking|reading|debugger|notification|error|sleep/.test(animation.file));
      }
    } finally { harness.runtime.dispose(); harness.restore(); }
  }
});
