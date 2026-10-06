"use strict";

// Run by VS Code's --extensionTestsPath against the installed VSIX directory.
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

function post(port, route, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request({ hostname: "127.0.0.1", port, path: route, method: "POST", timeout: 5000,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, text }));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("HTTP request timed out")));
    req.end(body);
  });
}

async function until(fn) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("VS Code smoke check timed out");
}

async function run() {
  assert.ok(process.env.CLAWD_RUNTIME_DIR, "Run only with an isolated runtime registry");
  const results = [];
  const config = vscode.workspace.getConfiguration("clawd");
  await config.update("codex.logFallback", false, vscode.ConfigurationTarget.Global);
  const extension = vscode.extensions.getExtension("alex6095.clawd-on-vscode");
  assert.ok(extension, "VSIX installed");
  await extension.activate();
  const diagnostics = () => vscode.commands.executeCommand("clawd.showDiagnostics");
  let data;
  await until(async () => { data = await diagnostics(); return data.runtime === "running"; });
  results.push("Installed extension activates and awaits a listening server");
  const port = data.serverPort;
  const session = { session_id: "codex:smoke", agent_id: "codex", cwd: process.env.CLAWD_RUNTIME_DIR, source: "hook", turn_id: "turn-smoke" };
  assert.equal((await post(port, "/state", { ...session, state: "thinking", event: "UserPromptSubmit" })).status, 200);
  data = await diagnostics();
  assert.equal(data.sessions.find((item) => item.id === session.session_id).state, "thinking");
  assert.equal(data.codex.hookObserved, true);
  results.push("Real HTTP hook reaches VS Code runtime and is identified as native Codex");
  for (const child of ["child-a", "child-b"]) {
    await post(port, "/state", { ...session, state: "juggling", event: "SubagentStart", child_agent_id: child });
  }
  await post(port, "/state", { ...session, state: "working", event: "SubagentStop", child_agent_id: "child-a" });
  data = await diagnostics();
  const active = data.sessions.find((item) => item.id === session.session_id);
  assert.equal(active.state, "juggling");
  results.push("One child finishing preserves the remaining parallel child");
  await vscode.commands.executeCommand("workbench.action.closeSidebar");
  const fallback = await post(port, "/permission", { ...session, hook_event_name: "PermissionRequest", tool_name: "Bash", tool_use_id: "approval-smoke", tool_input: { command: "echo clawd-smoke" } });
  assert.equal(fallback.status, 200);
  assert.deepEqual(JSON.parse(fallback.text), {});
  results.push("Hidden sidebar returns native approval fallback over HTTP");
  for (const theme of ["clawd", "calico", "neobjuk"]) {
    await config.update("theme", theme, vscode.ConfigurationTarget.Global);
    await until(async () => (await diagnostics()).theme === theme);
  }
  results.push("All three installed character themes load");
  const commands = await vscode.commands.getCommands(true);
  for (const command of ["clawd.showConnectionHelp", "clawd.muteNotifications", "clawd.unmuteNotifications"]) assert.ok(commands.includes(command));
  results.push("Connection guide and notification controls are registered in the installed extension");
  await vscode.commands.executeCommand("clawd.pauseRuntime");
  assert.equal((await diagnostics()).runtime, "paused");
  await vscode.commands.executeCommand("clawd.muteNotifications");
  assert.equal((await diagnostics()).notificationsQuiet, true);
  assert.equal((await diagnostics()).runtime, "paused");
  await vscode.commands.executeCommand("clawd.unmuteNotifications");
  assert.equal((await diagnostics()).notificationsQuiet, false);
  results.push("Quiet notifications toggle while paused without starting activity");
  await vscode.commands.executeCommand("clawd.resumeRuntime");
  assert.equal((await diagnostics()).runtime, "running");
  await vscode.commands.executeCommand("clawd.restartRuntime");
  assert.equal((await diagnostics()).runtime, "running");
  results.push("Pause, resume, and restart leave a working server");
  const directory = process.env.CLAWD_SMOKE_RESULTS || process.env.CLAWD_RUNTIME_DIR;
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "vscode-smoke.json"), JSON.stringify({ version: extension.packageJSON.version, vscode: vscode.version, results }, null, 2));
  console.log(`Clawd VS Code smoke: ${results.length} checks passed.`);
}

module.exports = { run };
