"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const initServer = require("../vendor/clawd/src/server");

function createFakeHttpServer() {
  const handlers = {};
  const server = {
    on(event, handler) {
      handlers[event] = handler;
      return server;
    },
    listen(port, host) {
      server.port = port;
      server.host = host;
      if (handlers.listening) handlers.listening();
      return server;
    },
    close() {
      server.closed = true;
    },
  };
  return { handlers, server };
}

function noopSync() {
  return { added: 0, updated: 0 };
}

test("server startup syncs Claude hooks after the active port is known", () => {
  const fakeHttp = createFakeHttpServer();
  const syncCalls = [];
  let writtenPort = null;

  const server = initServer({
    autoStartWithClaude: false,
    createHttpServer: () => fakeHttp.server,
    getPortCandidates: () => [23334],
    writeRuntimeConfig: (port) => {
      writtenPort = port;
      return true;
    },
    clearRuntimeConfig: () => true,
    setImmediate: (fn) => fn(),
    fs: {
      watch: () => ({ close() {}, on() {} }),
    },
    syncClawdHooksImpl: (options) => {
      syncCalls.push(options);
      return { added: 0, updated: 0, removed: 0 };
    },
    syncGeminiHooksImpl: noopSync,
    syncCursorHooksImpl: noopSync,
    syncCodeBuddyHooksImpl: noopSync,
    syncKiroHooksImpl: noopSync,
    syncOpencodePluginImpl: noopSync,
  });

  server.startHttpServer();

  assert.equal(fakeHttp.server.host, "127.0.0.1");
  assert.equal(writtenPort, 23334);
  assert.deepEqual(syncCalls, [{ autoStart: false, port: 23334 }]);

  server.cleanup();
});

test("settings watcher re-syncs Claude hooks even when a stale marker remains", () => {
  const fakeHttp = createFakeHttpServer();
  const syncCalls = [];
  let watchCallback = null;
  let pendingTimer = null;

  const server = initServer({
    autoStartWithClaude: false,
    createHttpServer: () => fakeHttp.server,
    getPortCandidates: () => [23335],
    writeRuntimeConfig: () => true,
    clearRuntimeConfig: () => true,
    setImmediate: (fn) => fn(),
    setTimeout: (fn) => {
      pendingTimer = fn;
      return 1;
    },
    clearTimeout: () => {},
    now: () => 100000,
    settingsWatchRateLimitMs: 0,
    fs: {
      readFileSync: () => "stale but still contains clawd-hook.js",
      watch: (_dir, callback) => {
        watchCallback = callback;
        return { close() {}, on() {} };
      },
    },
    syncClawdHooksImpl: (options) => {
      syncCalls.push(options);
      return { added: 0, updated: 0, removed: 0 };
    },
    syncGeminiHooksImpl: noopSync,
    syncCursorHooksImpl: noopSync,
    syncCodeBuddyHooksImpl: noopSync,
    syncKiroHooksImpl: noopSync,
    syncOpencodePluginImpl: noopSync,
  });

  server.startHttpServer();
  assert.equal(typeof watchCallback, "function");

  syncCalls.length = 0;
  watchCallback("change", "settings.json");
  assert.equal(syncCalls.length, 0);

  pendingTimer();

  assert.deepEqual(syncCalls, [{ autoStart: false, port: 23335 }]);

  server.cleanup();
});
