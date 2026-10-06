"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const initServer = require("../vendor/clawd/src/server");

function harness(t, extra = {}) {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-server-test-"));
  const httpServer = new EventEmitter();
  const listened = [];
  httpServer.listen = port => { listened.push(port); return httpServer; };
  httpServer.close = () => {};
  let route;
  const updates = [];
  const shown = [];
  const deferred = [];
  const written = [];
  const ctx = {
    runtimeRegistryOptions: { runtimeDir }, runtimeInstanceId: "test",
    createHttpServer(handler) { route = handler; return httpServer; },
    getPortCandidates: () => [23333, 23334],
    writeRuntimeConfig(port, options) { written.push([port, options]); return true; },
    clearRuntimeConfig() {}, setImmediate() {}, manageClaudeHooksAutomatically: false,
    STATE_SVGS: { working: ["working.svg"], thinking: ["thinking.svg"], attention: ["attention.svg"], juggling: ["juggling.svg"] },
    sessions: new Map(), pendingPermissions: [], PASSTHROUGH_TOOLS: new Set(),
    permLog() {}, updateSession(...args) { updates.push(args); },
    showPermissionBubble(entry) { shown.push(entry); },
    deferPermissionEntry(entry) { deferred.push(entry); ctx.pendingPermissions.splice(ctx.pendingPermissions.indexOf(entry), 1); },
    ...extra,
  };
  const server = initServer(ctx);
  t.after(() => { server.cleanup(); fs.rmSync(runtimeDir, { recursive: true, force: true }); });
  const ready = server.startHttpServer();
  function request(url, body) {
    const req = new EventEmitter(); req.method = "POST"; req.url = url;
    const res = new EventEmitter();
    res.writeHead = (status, headers) => { res.statusCode = status; res.headers = headers || {}; res.headersSent = true; };
    res.end = value => { res.body = value; res.writableEnded = true; res.writableFinished = true; };
    res.destroy = () => { res.destroyed = true; };
    route(req, res);
    req.emit("data", Buffer.from(JSON.stringify(body)));
    req.emit("end");
    return res;
  }
  return { server, ctx, ready, httpServer, listened, updates, shown, deferred, written, request };
}

test("startup resolves only after listening and keeps one readiness promise", async t => {
  const { server, ready, httpServer, written } = harness(t);
  let resolved = false;
  ready.then(() => { resolved = true; });
  await Promise.resolve();
  assert.equal(resolved, false);
  assert.equal(server.startHttpServer(), ready);
  httpServer.emit("listening");
  assert.equal(await ready, 23333);
  assert.equal(written[0][1].instanceId, "test");
});

test("startup retries occupied ports and rejects when all are exhausted", async t => {
  const { ready, httpServer, listened } = harness(t);
  const failure = assert.rejects(ready, { code: "EADDRINUSE" });
  httpServer.emit("error", Object.assign(new Error("occupied"), { code: "EADDRINUSE" }));
  assert.deepEqual(listened, [23333, 23334]);
  httpServer.emit("error", Object.assign(new Error("occupied"), { code: "EADDRINUSE" }));
  await failure;
});

test("registration refresh publishes current visibility and workspace roots", async t => {
  let visible = false;
  const h = harness(t, { isPermissionUIAvailable: () => visible, workspaceRoots: ["/original"] });
  h.httpServer.emit("listening"); await h.ready;
  assert.equal(h.written.at(-1)[1].visible, false);
  visible = true;
  h.ctx.workspaceRoots = ["/updated"];
  assert.equal(h.server.refreshRuntimeRegistration(), true);
  assert.equal(h.written.at(-1)[1].visible, true);
  assert.deepEqual(h.written.at(-1)[1].workspaceRoots, ["/updated"]);
});

test("tool completion only closes its matching approval", async t => {
  const h = harness(t);
  h.httpServer.emit("listening"); await h.ready;
  const a = { sessionId: "s", agentId: "claude-code", toolCallId: "a", turnId: "turn" };
  const b = { sessionId: "s", agentId: "claude-code", toolCallId: "b", turnId: "turn" };
  h.ctx.pendingPermissions.push(a, b);
  const res = h.request("/state", { state: "thinking", event: "PostToolUse", session_id: "s", agent_id: "claude-code", tool_call_id: "a", turn_id: "turn" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(h.deferred, [a]);
  assert.deepEqual(h.ctx.pendingPermissions, [b]);
});

test("parent stop preserves a child's active approval", async t => {
  const h = harness(t);
  h.httpServer.emit("listening"); await h.ready;
  const child = { sessionId: "s", agentId: "claude-code", childAgentId: "child", toolCallId: "a" };
  h.ctx.pendingPermissions.push(child);
  h.request("/state", { state: "attention", event: "Stop", session_id: "s", agent_id: "claude-code" });
  assert.deepEqual(h.deferred, []);
  h.request("/state", { state: "thinking", event: "SubagentStop", session_id: "s", agent_id: "claude-code", child_agent_id: "child" });
  assert.deepEqual(h.deferred, [child]);
});

test("hidden permission UI immediately returns native fallback", async t => {
  const h = harness(t, { isPermissionUIAvailable: () => false });
  h.httpServer.emit("listening"); await h.ready;
  const res = h.request("/permission", { session_id: "s", agent_id: "codex", tool_name: "shell" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["x-clawd-server"], "clawd-on-vscode");
  assert.equal(res.body, "{}");
  assert.equal(h.shown.length, 0);
  assert.equal(h.ctx.pendingPermissions.length, 0);
});

test("permission entries retain provider and event identity", async t => {
  const h = harness(t);
  h.httpServer.emit("listening"); await h.ready;
  h.request("/permission", { session_id: "codex:s", agent_id: "codex", child_agent_id: "child", turn_id: "turn", tool_call_id: "call", request_id: "request", tool_name: "shell", cwd: "/project", source_pid: 123, agent_pid: 456, pid_chain: [123,456,"invalid",-2], editor: "code", source: "hook" });
  const entry = h.ctx.pendingPermissions[0];
  assert.equal(entry.agentId, "codex");
  assert.equal(entry.childAgentId, "child");
  assert.equal(entry.turnId, "turn");
  assert.equal(entry.toolCallId, "call");
  assert.equal(entry.requestId, "request");
  assert.equal(h.updates[0][3].cwd, "/project");
  assert.equal(h.updates[0][3].sourcePid, 123);
  assert.deepEqual(h.updates[0][3].pidChain, [123, 456]);
  assert.equal(h.updates[0][3].editor, "code");
  assert.equal(h.updates[0][3].source, "hook");
});

test("headless and passthrough tools defer instead of deciding for the user", async t => {
  const h = harness(t);
  h.httpServer.emit("listening"); await h.ready;
  h.ctx.sessions.set("s", { headless: true });
  assert.equal(h.request("/permission", { session_id: "s", tool_name: "Bash" }).body, "{}");
  h.ctx.PASSTHROUGH_TOOLS.add("TaskCreate");
  assert.equal(h.request("/permission", { session_id: "interactive", tool_name: "TaskCreate" }).body, "{}");
  assert.equal(h.ctx.pendingPermissions.length, 0);
});

test("real HTTP permission JSON falls through to a native prompt in a hidden view", async t => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-http-test-"));
  const server = initServer({
    runtimeRegistryOptions: { runtimeDir }, runtimeInstanceId: "http-test", workspaceRoots: ["/project"],
    getPortCandidates: () => [0], manageClaudeHooksAutomatically: false, setImmediate() {},
    pendingPermissions: [], sessions: new Map(), permLog() {}, isPermissionUIAvailable: () => false,
  });
  t.after(() => { server.cleanup(); fs.rmSync(runtimeDir, { recursive: true, force: true }); });
  const port = await server.startHttpServer();
  assert.ok(port > 0);
  const payload = JSON.stringify({ session_id: "codex:s", agent_id: "codex", tool_name: "shell", tool_call_id: "call", cwd: "/project" });
  const response = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, method: "POST", path: "/permission", timeout: 1000,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } }, res => {
      let body = "";
      res.setEncoding("utf8"); res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, header: res.headers["x-clawd-server"], body }));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("permission fallback timed out")));
    req.end(payload);
  });
  assert.deepEqual(response, { status: 200, header: "clawd-on-vscode", body: "{}" });
});
