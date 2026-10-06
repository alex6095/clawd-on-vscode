"use strict";

const vscode = require("vscode");
const { createRuntime } = require("./runtime");
const { ClawdViewProvider } = require("./view-provider");
const { showConnectionHelp } = require("./connection-help");

let runtime = null;
let provider = null;
let output = null;

async function activate(context) {
  output = vscode.window.createOutputChannel("Clawd");
  runtime = createRuntime(context, output);
  provider = new ClawdViewProvider(context, runtime);
  context.subscriptions.push(output, provider, runtime);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider("clawd.petView", provider, {
    webviewOptions: { retainContextWhenHidden: true },
  }));
  const guard = (fn) => async (...args) => {
    try { return await fn(...args); }
    catch (error) {
      runtime.log(error.stack || error.message);
      void vscode.window.showErrorMessage(`Clawd: ${error.message}`);
    }
  };
  const command = (name, fn) => context.subscriptions.push(vscode.commands.registerCommand(`clawd.${name}`, guard(fn)));
  const report = async (action) => {
    const result = await action();
    if (result.ok === false) void vscode.window.showWarningMessage(result.message);
    else void vscode.window.showInformationMessage(result.message);
    return result;
  };
  command("open", () => vscode.commands.executeCommand("clawd.petView.focus"));
  command("installIntegrations", async () => {
    const names = { "claude-code": "Claude Code", codex: "Codex", "gemini-cli": "Gemini CLI", "cursor-agent": "Cursor Agent", codebuddy: "CodeBuddy", "kiro-cli": "Kiro CLI", opencode: "OpenCode" };
    const picked = await vscode.window.showQuickPick(Object.entries(names).map(([id, label]) => ({
      id, label, picked: runtime.selectedAgents().includes(id),
    })), { canPickMany: true, placeHolder: "Connect these coding agents to Clawd" });
    if (!picked || !picked.length) return;
    await runtime.getConfig().update("integrations.agents", picked.map((item) => item.id), vscode.ConfigurationTarget.Global);
    const result = await runtime.installIntegrations();
    if (!result.ok) void vscode.window.showWarningMessage(result.message);
    else if (result.trustRequired) {
      const action = await vscode.window.showInformationMessage(result.message, "Connection Guide");
      if (action) await showConnectionHelp(vscode, runtime);
    } else void vscode.window.showInformationMessage(result.message);
    return result;
  });
  command("uninstallIntegrations", () => report(() => runtime.uninstallIntegrations()));
  command("toggleDnd", () => runtime.toggleDnd());
  command("muteNotifications", () => runtime.doNotDisturb ? undefined : runtime.toggleDnd());
  command("unmuteNotifications", () => runtime.doNotDisturb ? runtime.toggleDnd() : undefined);
  command("showConnectionHelp", () => showConnectionHelp(vscode, runtime));
  command("setTheme", async () => {
    const picked = await vscode.window.showQuickPick(runtime.themes(), { placeHolder: "Choose a character" });
    if (picked) await runtime.setTheme(picked.id);
  });
  command("previewAnimation", async () => {
    await vscode.commands.executeCommand("clawd.petView.focus");
    const picked = await vscode.window.showQuickPick(runtime.previewChoices(), { placeHolder: "Preview an animation for six seconds" });
    if (picked) runtime.previewAnimation(picked);
  });
  command("showDiagnostics", () => runtime.diagnostics());
  command("restartRuntime", () => runtime.restart());
  command("pauseRuntime", () => runtime.pause());
  command("resumeRuntime", () => runtime.resume());
  command("disableIntegrations", () => report(() => runtime.disableIntegrations()));
  command("enableIntegrations", () => report(() => runtime.enableIntegrations()));

  let configTimer;
  const changed = new Set();
  context.subscriptions.push({ dispose() { clearTimeout(configTimer); } });
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (!event.affectsConfiguration("clawd")) return;
    for (const key of ["theme", "integrations", "sessions.scope", "codex.logFallback", "runtime.enabled"]) {
      if (event.affectsConfiguration(`clawd.${key}`)) changed.add(key);
    }
    clearTimeout(configTimer);
    configTimer = setTimeout(guard(async () => {
      const keys = new Set(changed);
      changed.clear();
      if (keys.has("theme")) {
        const id = runtime.getConfig().get("theme", "clawd");
        if (!runtime.activeTheme || runtime.activeTheme._id !== id) await runtime.setTheme(id);
      }
      if (["integrations", "sessions.scope", "codex.logFallback"].some((key) => keys.has(key))) {
        runtime.disposeRuntime();
        await runtime.start();
      } else if (keys.has("runtime.enabled")) await runtime.start();
      runtime.postThemeConfig();
      runtime.pushSnapshot();
    }), 100);
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(guard(async () => {
    runtime.disposeRuntime();
    await runtime.start();
  })));
  context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(guard(() => runtime.start())));
  await runtime.updateContextKeys();
  if (runtime.getConfig().get("autoStartRuntime", true) && runtime.isRuntimeEnabled()) await guard(() => runtime.start())();
}

function deactivate() {
  if (runtime) runtime.dispose();
  runtime = null;
  provider = null;
  output = null;
}

module.exports = { activate, deactivate };
