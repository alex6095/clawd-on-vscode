"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const initState = require("../vendor/clawd/src/state");

function createState(t) {
  const visuals = [];
  const alive = new Set([1234]);
  const deferred = [];
  const ctx = {
    theme: {
      states: Object.fromEntries(["idle", "working", "thinking", "juggling", "attention", "notification", "error", "sleeping", "waking"].map(state => [state, [`${state}.svg`]])),
      timings: { minDisplay: {}, autoReturn: {}, deepSleepTimeout: 600000, yawnDuration: 0, wakeDuration: 0 },
      hitBoxes: { default: {} }, displayHintMap: {}, sleepSequence: { mode: "direct" },
    },
    processKill(pid) { if (!alive.has(pid)) throw Object.assign(new Error("gone"), { code: "ESRCH" }); },
    sendToRenderer(type, state) { if (type === "state-change") visuals.push(state); },
    sendToHitWin() {}, syncHitWin() {}, playSound() {}, buildContextMenu() {}, buildTrayMenu() {},
    pendingPermissions: [],
    deferPermissionEntry(entry) { deferred.push(entry); },
  };
  const state = initState(ctx);
  t.after(() => state.cleanup());
  return { state, ctx, visuals, alive, deferred };
}

test("parallel children stay active until every unique child stops", t => {
  const { state } = createState(t);
  state.updateSession("s", "working", "PreToolUse");
  for (const childAgentId of ["a", "b", "a"]) state.updateSession("s", "juggling", "SubagentStart", { childAgentId });
  assert.equal(state.sessions.get("s").activeChildren.size, 2);
  state.updateSession("s", "thinking", "SubagentStop", { childAgentId: "a" });
  assert.equal(state.sessions.get("s").state, "juggling");
  state.updateSession("s", "thinking", "SubagentStop", { childAgentId: "unknown" });
  assert.equal(state.sessions.get("s").activeChildren.size, 1);
  state.updateSession("s", "thinking", "SubagentStop", { childAgentId: "b" });
  assert.equal(state.sessions.get("s").state, "working");
});

test("legacy anonymous starts are counted individually", t => {
  const { state } = createState(t);
  state.updateSession("s", "thinking", "UserPromptSubmit");
  state.updateSession("s", "juggling", "SubagentStart");
  state.updateSession("s", "juggling", "SubagentStart");
  state.updateSession("s", "thinking", "SubagentStop");
  assert.equal(state.sessions.get("s").state, "juggling");
  state.updateSession("s", "thinking", "SubagentStop");
  assert.equal(state.sessions.get("s").state, "thinking");
});

test("parent completion waits for children before celebrating", t => {
  const { state, visuals } = createState(t);
  state.updateSession("s", "working", "PreToolUse");
  state.updateSession("s", "juggling", "SubagentStart", { childAgentId: "a" });
  state.updateSession("s", "attention", "Stop");
  assert.equal(state.sessions.get("s").state, "juggling");
  assert.equal(state.deriveSessionBadge(state.sessions.get("s")), "running");
  assert.equal(visuals.includes("attention"), false);
  state.updateSession("s", "thinking", "SubagentStop", { childAgentId: "a" });
  assert.equal(state.sessions.get("s").state, "idle");
  assert.equal(state.deriveSessionBadge(state.sessions.get("s")), "done");
  assert.equal(visuals.at(-1), "attention");
});

test("alive long-running work is retained while an exited owner is removed", t => {
  const { state, alive } = createState(t);
  state.updateSession("s", "working", "PreToolUse", { agentPid: 1234 });
  state.sessions.get("s").updatedAt = Date.now() - 3600000;
  state.cleanStaleSessions();
  assert.equal(state.sessions.get("s").state, "working");
  alive.delete(1234);
  state.cleanStaleSessions();
  assert.equal(state.sessions.has("s"), false);
});

test("a tool completion does not idle another active tool", t => {
  const { state } = createState(t);
  state.updateSession("s", "working", "PreToolUse", { toolCallId: "a" });
  state.updateSession("s", "working", "PreToolUse", { toolCallId: "b" });
  state.updateSession("s", "thinking", "PostToolUse", { toolCallId: "a" });
  assert.equal(state.sessions.get("s").state, "working");
  assert.deepEqual([...state.sessions.get("s").activeToolCalls], ["b"]);
  state.updateSession("s", "thinking", "PostToolUse", { toolCallId: "b" });
  assert.equal(state.sessions.get("s").state, "thinking");
});

test("metadata, tasks and notifications preserve the current workload", t => {
  const { state } = createState(t);
  state.updateSession("s", "working", "PreToolUse");
  state.updateSession("s", "idle", "CwdChanged", { metaOnly: true, cwd: "/new", model: "model-a" });
  state.updateSession("s", "attention", "TaskCompleted", { taskId: "t" });
  state.updateSession("s", "notification", "Notification");
  const session = state.sessions.get("s");
  assert.equal(session.state, "working");
  assert.equal(session.cwd, "/new");
  assert.equal(session.model, "model-a");
  assert.equal(session.tasks.get("t"), "completed");
});

test("failure ends the workload and metadata does not erase its badge", t => {
  const { state } = createState(t);
  state.updateSession("s", "working", "PreToolUse");
  state.updateSession("s", "error", "StopFailure");
  state.updateSession("s", "idle", "PostModelSwitch", { metaOnly: true, model: "model-b" });
  assert.equal(state.sessions.get("s").state, "idle");
  assert.equal(state.deriveSessionBadge(state.sessions.get("s")), "interrupted");
});

test("DND defers permissions to the native prompt", t => {
  const { state, ctx, deferred } = createState(t);
  const entry = { sessionId: "s" };
  ctx.pendingPermissions.push(entry);
  state.enableDoNotDisturb();
  assert.deepEqual(deferred, [entry]);
});

test("native approval holds its waiting visual until resolution then restores the workload", async t => {
  const { state, ctx, visuals } = createState(t);
  ctx.theme.timings.autoReturn.notification = 10;
  state.updateSession("s", "working", "PreToolUse");
  const permission = { sessionId: "s", res: { writableEnded: false, destroyed: false } };
  ctx.pendingPermissions.push(permission);
  state.updateSession("s", "notification", "PermissionRequest");
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(state.getCurrentState(), "notification");
  assert.equal(state.resolveDisplayState(), "notification");
  assert.equal(state.sessions.get("s").state, "working");
  assert.equal(visuals.filter(visual => visual === "notification").length, 1);
  ctx.pendingPermissions.splice(0, 1);
  assert.equal(state.refreshDisplayState(), "working");
  assert.equal(state.getCurrentState(), "working");
});

test("old Codex information cards do not hold the approval animation", t => {
  const { state, ctx } = createState(t);
  state.updateSession("s", "working", "PreToolUse");
  ctx.pendingPermissions.push({ sessionId: "s", isCodexNotify: true });
  assert.equal(state.resolveDisplayState(), "working");
});
