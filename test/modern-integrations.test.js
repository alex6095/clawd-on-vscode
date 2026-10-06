"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const CodexLogMonitor = require("../vendor/clawd/agents/codex-log-monitor");
const codex = require("../vendor/clawd/agents/codex");
const { registerCodexHooks, unregisterCodexHooks, getCodexHookStatus, quoteShell } = require("../vendor/clawd/hooks/codex-install");
const { registerHooks, unregisterHooks } = require("../vendor/clawd/hooks/install");
const { buildStateBody: codexBody } = require("../vendor/clawd/hooks/codex-hook");
const { buildStateBody: claudeBody } = require("../vendor/clawd/hooks/clawd-hook");
const { sanitizePermissionResponse, requestPermission } = require("../vendor/clawd/hooks/permission-client");
const { CLAWD_SERVER_HEADER, CLAWD_SERVER_ID } = require("../vendor/clawd/hooks/server-config");

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-modern-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const record = (type, payload, timestamp = new Date().toISOString()) => JSON.stringify({ type, payload, timestamp });
const filename = "rollout-2026-10-06T00-00-00-00000000-0000-0000-0000-000000000001.jsonl";
function monitor() {
  const events = [];
  const instance = new CodexLogMonitor(codex, (...args) => events.push(args));
  instance._resolveTrackedAgentPid = () => 77;
  return { instance, events };
}

test("Codex restores historical metadata without replaying history and recognizes custom tools", (t) => {
  const dir = fixture(t);
  const file = path.join(dir, filename);
  const old = "2020-01-01T00:00:00.000Z";
  fs.writeFileSync(file, [
    record("session_meta", { cwd: "/workspace/resumed" }, old),
    record("turn_context", { summary: "A resumed session" }, old),
    record("event_msg", { type: "task_complete" }, old),
    record("event_msg", { type: "task_started" }),
    record("response_item", { type: "custom_tool_call", name: "apply_patch" }),
    record("event_msg", { type: "task_complete" }),
  ].join("\n") + "\n");
  const { instance, events } = monitor();
  instance._pollFile(file, filename);
  assert.deepEqual(events.map((event) => event[1]), ["thinking", "working", "attention"]);
  assert.equal(events.at(-1)[3].cwd, "/workspace/resumed");
  assert.equal(events.at(-1)[3].sessionTitle, "A resumed session");
  assert.equal(events.at(-1)[3].source, "log");
  assert.equal(events.at(-1)[3].agentPid, 77);
});

test("long-running commands and escalation arguments do not fabricate approvals", async () => {
  const { instance, events } = monitor();
  const tracked = { sessionId: "codex:a", lastState: null, hadToolUse: false };
  instance._processLine(record("response_item", { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "sleep 30", sandbox_permissions: "require_escalated", justification: "test" }) }), tracked);
  await new Promise((resolve) => setTimeout(resolve, 2100));
  assert.deepEqual(events.map((event) => event[1]), ["working"]);
  assert.equal(tracked.approvalTimer, undefined);
});

test("Codex polling is bounded and recovers after large lines and truncation", (t) => {
  const dir = fixture(t);
  const file = path.join(dir, filename);
  fs.writeFileSync(file, "x".repeat(2 * 1024 * 1024 + 10) + "\n" + record("event_msg", { type: "task_started" }) + "\n");
  const { instance, events } = monitor();
  instance._pollFile(file, filename);
  assert.equal(instance._tracked.get(file).offset, 1024 * 1024);
  instance._pollFile(file, filename);
  instance._pollFile(file, filename);
  assert.equal(events.at(-1)[1], "thinking");
  fs.writeFileSync(file, record("event_msg", { type: "turn_aborted" }) + "\n");
  instance._pollFile(file, filename);
  assert.equal(events.at(-1)[1], "idle");
});

test("Codex reads split UTF-8 metadata and honors CODEX_HOME", (t) => {
  const dir = fixture(t);
  const original = process.env.CODEX_HOME;
  process.env.CODEX_HOME = dir;
  t.after(() => { if (original === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = original; });
  const { instance, events } = monitor();
  assert.equal(instance._baseDir, path.join(dir, "sessions"));
  const file = path.join(dir, filename);
  const bytes = Buffer.from(record("session_meta", { cwd: "/작업" }) + "\n");
  const cut = bytes.indexOf(Buffer.from("작")) + 1;
  fs.writeFileSync(file, bytes.subarray(0, cut));
  instance._pollFile(file, filename);
  fs.appendFileSync(file, bytes.subarray(cut));
  instance._pollFile(file, filename);
  assert.equal(events.at(-1)[3].cwd, "/작업");
});

test("Codex installer merges, updates and uninstalls only its own command hooks", (t) => {
  const dir = fixture(t);
  const file = path.join(dir, "hooks.json");
  const user = { matcher: "Bash", hooks: [{ type: "command", command: "echo user" }] };
  fs.writeFileSync(file, JSON.stringify({ description: "User hooks", hooks: { Stop: [user, { hooks: [{ type: "command", command: 'node "/old/codex-hook.js" Stop' }] }] } }));
  const configPath = path.join(dir, "config.toml");
  fs.writeFileSync(configPath, "[features]\nhooks = false\n");
  const options = { codexHome: dir, nodeBin: "/usr/bin/node", detectVersion: false };
  const first = registerCodexHooks(options);
  assert.equal(first.updated, 1);
  assert.equal(first.installed, true);
  assert.equal(first.trustRequired, true);
  assert.equal(first.disabledInUserConfig, true);
  const contents = fs.readFileSync(file, "utf8");
  const second = registerCodexHooks(options);
  assert.equal(second.changed, false);
  assert.equal(fs.readFileSync(file, "utf8"), contents);
  assert.equal(fs.readFileSync(configPath, "utf8"), "[features]\nhooks = false\n");
  const installed = JSON.parse(contents);
  assert.equal(installed.hooks.PermissionRequest[0].hooks[0].type, "command");
  assert.equal(installed.hooks.PermissionRequest[0].hooks[0].timeout, 600);
  assert.equal(installed.hooks.PermissionRequest[0].hooks[0].statusMessage, "Clawd: show approval request");
  assert.equal(installed.hooks.Interrupt[0].hooks[0].timeout, 3);
  unregisterCodexHooks(options);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { description: "User hooks", hooks: { Stop: [user] } });
  assert.equal(getCodexHookStatus(options).installed, false);
});

test("installer refuses invalid configuration without overwriting it", (t) => {
  const file = path.join(fixture(t), "hooks.json");
  fs.writeFileSync(file, "{invalid");
  assert.throws(() => registerCodexHooks({ hooksPath: file, nodeBin: "node" }), /Cannot read Codex hooks/);
  assert.equal(fs.readFileSync(file, "utf8"), "{invalid");
  assert.equal(quoteShell("/tmp/don't/$expand/node", "linux"), "'/tmp/don'\"'\"'t/$expand/node'");
  assert.equal(quoteShell("C:\\Program Files\\node.exe", "win32"), '"C:\\Program Files\\node.exe"');
});

test("Claude migrates fixed-port permissions, preserves user hooks, and gates new events", (t) => {
  const file = path.join(fixture(t), "settings.json");
  const user = { matcher: "", hooks: [{ type: "command", command: "echo custom" }] };
  fs.writeFileSync(file, JSON.stringify({ hooks: {
    WorktreeCreate: [{ hooks: [{ type: "command", command: 'node "/old/clawd-hook.js" WorktreeCreate' }] }, user],
    PermissionRequest: [{ hooks: [{ type: "http", url: "http://127.0.0.1:23333/permission" }, { type: "http", url: "https://example.com/permission" }] }],
  } }));
  const options = { settingsPath: file, nodeBin: "/usr/bin/node", silent: true, claudeVersionInfo: { status: "known", version: "2.1.84", source: "fixture" } };
  registerHooks(options);
  const settings = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(settings.hooks.WorktreeCreate, [user]);
  assert.ok(settings.hooks.TaskCreated);
  assert.ok(settings.hooks.CwdChanged);
  assert.equal(settings.hooks.PostModelSwitch, undefined);
  assert.equal(settings.hooks.PermissionDenied, undefined);
  const perms = settings.hooks.PermissionRequest.flatMap((entry) => entry.hooks);
  assert.equal(perms.filter((entry) => entry.type === "http").length, 1);
  assert.equal(perms.find((entry) => entry.type === "http").url, "https://example.com/permission");
  assert.ok(perms.find((entry) => entry.type === "command" && /PermissionRequest/.test(entry.command)));
  const prior = fs.readFileSync(file, "utf8");
  registerHooks(options);
  assert.equal(fs.readFileSync(file, "utf8"), prior);
  unregisterHooks({ settingsPath: file });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).hooks.WorktreeCreate, [user]);
});

test("provider and subagent identities survive hook mapping", () => {
  const payload = { session_id: "session", agent_id: "child", agent_type: "Explore", turn_id: "turn", tool_use_id: "call", cwd: "/repo" };
  const resolver = () => ({ stablePid: 77, agentPid: null, pidChain: [77] });
  for (const [build, provider] of [[codexBody, "codex"], [claudeBody, "claude-code"]]) {
    const body = build("SubagentStart", payload, resolver);
    assert.equal(body.agent_id, provider);
    assert.equal(body.child_agent_id, "child");
    assert.equal(body.turn_id, "turn");
    assert.equal(body.tool_call_id, "call");
    assert.equal(body.source, "hook");
  }
  assert.equal(codexBody("SessionStart", payload, resolver).session_id, "codex:session");
  const moved = claudeBody("CwdChanged", { ...payload, new_cwd: "/new" }, resolver);
  assert.equal(moved.cwd, "/new");
  assert.equal(moved.meta_only, true);
  assert.equal(claudeBody("WorktreeCreate", payload, resolver), null);
});

test("Codex approval responses exclude Claude-specific fields and decline invalid responses", () => {
  const reply = { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: { cmd: "different" }, updatedPermissions: [{ type: "rule" }], interrupt: true } } };
  assert.deepEqual(sanitizePermissionResponse(reply, "codex"), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
  assert.deepEqual(sanitizePermissionResponse(reply, "claude-code").hookSpecificOutput.decision.updatedInput, { cmd: "different" });
  assert.equal(sanitizePermissionResponse({}, "codex"), null);
  assert.equal(sanitizePermissionResponse({ hookSpecificOutput: { hookEventName: "Elicitation", decision: { behavior: "allow" } } }, "codex"), null);
});

test("permission bridge waits for a decision and defers missing UI or dropped connections", async (t) => {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const payload = JSON.parse(body);
      received.push(payload);
      if (payload.tool_name === "drop") return res.destroy();
      res.setHeader(CLAWD_SERVER_HEADER, CLAWD_SERVER_ID);
      res.end(JSON.stringify(payload.tool_name === "defer" ? {} : { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "User declined" } } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const port = server.address().port;
  const options = { discoverClawdPort: (query, done) => { assert.equal(query.cwd, "/repo"); done(port); }, timeoutMs: 1000 };
  const payload = { cwd: "/repo", agent_id: "codex", session_id: "codex:a", tool_name: "Bash" };
  assert.equal((await requestPermission(payload, options)).hookSpecificOutput.decision.behavior, "deny");
  assert.equal(received[0].session_id, "codex:a");
  assert.equal(await requestPermission({ ...payload, tool_name: "defer" }, options), null);
  assert.equal(await requestPermission({ ...payload, tool_name: "drop" }, options), null);
  assert.equal(await requestPermission(payload, { discoverClawdPort: (_, done) => done(null) }), null);
});
