"use strict";

const vscode = require("vscode");
const { createRuntime } = require("./runtime");
const { ClawdViewProvider } = require("./view-provider");

let runtime = null;
let provider = null;
let output = null;

async function activate(context) {
  output = vscode.window.createOutputChannel("Clawd");
  runtime = createRuntime(context, output);
  provider = new ClawdViewProvider(context, runtime);

  context.subscriptions.push(output, provider, runtime);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("clawd.petView", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("clawd.open", () => vscode.commands.executeCommand("clawd.petView.focus")),
    vscode.commands.registerCommand("clawd.installIntegrations", async () => {
      const result = await runtime.installIntegrations();
      vscode.window.showInformationMessage(result.message);
    }),
    vscode.commands.registerCommand("clawd.toggleDnd", async () => {
      const enabled = await runtime.toggleDnd();
      vscode.window.showInformationMessage(`Clawd Do Not Disturb ${enabled ? "enabled" : "disabled"}.`);
    }),
    vscode.commands.registerCommand("clawd.setTheme", async () => {
      await runtime.start();
      const picked = await vscode.window.showQuickPick([
        { label: "Clawd", id: "clawd" },
        { label: "Calico", id: "calico" },
      ], { placeHolder: "Choose a Clawd theme" });
      if (picked) await runtime.setTheme(picked.id);
    }),
    vscode.commands.registerCommand("clawd.restartRuntime", async () => {
      await runtime.restart();
      vscode.window.showInformationMessage("Clawd runtime restarted.");
    }),
    vscode.commands.registerCommand("clawd.pauseRuntime", async () => {
      const result = await runtime.pause();
      vscode.window.showInformationMessage(result.message);
    }),
    vscode.commands.registerCommand("clawd.resumeRuntime", async () => {
      const result = await runtime.resume();
      vscode.window.showInformationMessage(result.message);
    }),
    vscode.commands.registerCommand("clawd.disableIntegrations", async () => {
      const result = await runtime.disableIntegrations();
      vscode.window.showInformationMessage(result.message);
    }),
    vscode.commands.registerCommand("clawd.enableIntegrations", async () => {
      const result = await runtime.enableIntegrations();
      vscode.window.showInformationMessage(result.message);
    })
  );

  await runtime.updateContextKeys();

  if (
    vscode.workspace.getConfiguration("clawd").get("autoStartRuntime", true)
    && runtime.isRuntimeEnabled()
  ) {
    await runtime.start();
  }
}

function deactivate() {
  if (runtime) runtime.dispose();
  runtime = null;
  provider = null;
  output = null;
}

module.exports = {
  activate,
  deactivate,
};
