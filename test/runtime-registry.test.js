"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { writeRuntimeConfig, clearRuntimeConfig, readRuntimeEntries, readRuntimePort, selectRuntimeEntries,
  discoverClawdPort, postStateToRunningServer } = require("../vendor/clawd/hooks/server-config");

function registry(t) {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-registry-test-"));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  return { runtimeDir, now: () => 10000, isProcessAlive: () => true };
}

test("instances register independently and cleanup removes only its owner", t => {
  const opts = registry(t);
  assert.equal(writeRuntimeConfig(23333, { ...opts, instanceId: "a", workspaceRoots: ["/work/a"] }), true);
  assert.equal(writeRuntimeConfig(23334, { ...opts, instanceId: "b", workspaceRoots: ["/work/b"] }), true);
  assert.equal(readRuntimeEntries(opts).length, 2);
  clearRuntimeConfig({ ...opts, instanceId: "a" });
  assert.deepEqual(readRuntimeEntries(opts).map(entry => entry.instanceId), ["b"]);
  assert.equal(fs.existsSync(path.join(opts.runtimeDir, "runtime.json")), false);
});

test("routing chooses the longest root and observes path boundaries", t => {
  const opts = registry(t);
  for (const [instanceId, port, workspaceRoots] of [["parent", 23333, ["/work"]], ["nested", 23334, ["/work/a"]], ["blank", 23335, []]]) {
    writeRuntimeConfig(port, { ...opts, instanceId, workspaceRoots });
  }
  assert.equal(readRuntimePort({ ...opts, cwd: "/work/a/src" }), 23334);
  assert.equal(readRuntimePort({ ...opts, cwd: "/work/ab" }), 23333);
  assert.equal(readRuntimePort({ ...opts, cwd: "/elsewhere" }), 23335);
  assert.equal(selectRuntimeEntries({ ...opts, instanceId: "parent", cwd: "/work/a" })[0].port, 23333);
});

test("expired and dead registrations cannot steal events", t => {
  const opts = registry(t);
  writeRuntimeConfig(23333, { ...opts, instanceId: "a", workspaceRoots: ["/work/a"] });
  assert.equal(readRuntimeEntries({ ...opts, now: () => 1000000 }).length, 0);
  assert.equal(readRuntimeEntries({ ...opts, isProcessAlive: () => false }).length, 0);
});

test("unmatched events are not delivered to an unrelated live workspace", async t => {
  const opts = registry(t);
  writeRuntimeConfig(23333, { ...opts, instanceId: "a", workspaceRoots: ["/work/a"] });
  const probes = [];
  const port = await new Promise(resolve => discoverClawdPort({ ...opts, cwd: "/work/b", probePort(port, _timeout, callback) { probes.push(port); callback(true); } }, resolve));
  assert.equal(port, null);
  assert.deepEqual(probes, []);
});

test("state body cwd overrides a stale preferred port", async t => {
  const opts = registry(t);
  writeRuntimeConfig(23333, { ...opts, instanceId: "a", workspaceRoots: ["/work/a"] });
  writeRuntimeConfig(23334, { ...opts, instanceId: "b", workspaceRoots: ["/work/b"] });
  const posted = [];
  const result = await new Promise(resolve => postStateToRunningServer({ cwd: "/work/b", state: "working" }, {
    ...opts, preferredPort: 23333,
    postStateToPort(port, payload, _timeout, callback) { posted.push([port, JSON.parse(payload).cwd]); callback(true, port); },
  }, (ok, port) => resolve({ ok, port })));
  assert.deepEqual(result, { ok: true, port: 23334 });
  assert.deepEqual(posted, [[23334, "/work/b"]]);
});

test("a visible owner beats a newer hidden heartbeat within the same workspace", t => {
  const opts = registry(t);
  writeRuntimeConfig(23333, { ...opts, instanceId: "visible", workspaceRoots: ["/work/a"], visible: true });
  writeRuntimeConfig(23334, { ...opts, instanceId: "hidden", workspaceRoots: ["/work/a"], visible: false, now: () => 20000 });
  assert.equal(readRuntimePort({ ...opts, cwd: "/work/a/src" }), 23333);
  clearRuntimeConfig({ ...opts, instanceId: "visible" });
  assert.equal(readRuntimePort({ ...opts, cwd: "/work/a/src" }), 23334);
});

test("workspace specificity wins over visibility and blank fallbacks prefer a visible UI", t => {
  const opts = registry(t);
  writeRuntimeConfig(23333, { ...opts, instanceId: "parent", workspaceRoots: ["/work"], visible: true });
  writeRuntimeConfig(23334, { ...opts, instanceId: "nested", workspaceRoots: ["/work/a"], visible: false });
  writeRuntimeConfig(23335, { ...opts, instanceId: "blank-visible", workspaceRoots: [], visible: true });
  writeRuntimeConfig(23336, { ...opts, instanceId: "blank-hidden", workspaceRoots: [], visible: false, now: () => 20000 });
  assert.equal(readRuntimePort({ ...opts, cwd: "/work/a" }), 23334);
  assert.equal(readRuntimePort({ ...opts, cwd: "/elsewhere" }), 23335);
});
