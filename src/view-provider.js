"use strict";

const { randomBytes } = require("crypto");
const vscode = require("vscode");

class ClawdViewProvider {
  constructor(context, runtime) {
    this.context = context;
    this.runtime = runtime;
    this.view = null;
    this.disposables = [];
    this.runtime.attachView(this);
  }

  resolveWebviewView(webviewView) {
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
        vscode.Uri.joinPath(this.context.extensionUri, "vendor", "clawd"),
      ],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((message) => {
      this.handleMessage(message).catch((error) => this.reportError(error));
    }, null, this.disposables);
    this.disposables.push(webviewView.onDidChangeVisibility(() => {
      if (!this.isVisible) this.runtime.clearPendingPermissionsForShutdown();
      this.runtime.refreshRuntimeRegistration();
      this.post("visibility-change", { visible: this.isVisible });
      if (this.isVisible) this.runtime.pushSnapshot();
    }));
    this.disposables.push(webviewView.onDidDispose(() => {
      this.runtime.clearPendingPermissionsForShutdown();
      if (this.view === webviewView) this.view = null;
      this.runtime.refreshRuntimeRegistration();
    }));
    void this.runtime.start().catch((error) => this.reportError(error));
  }

  get isVisible() { return !!(this.view && this.view.visible); }

  reportError(error) {
    this.runtime.log(error.stack || error.message);
    this.post("install-result", { message: error.message });
    void vscode.window.showErrorMessage(`Clawd: ${error.message}`);
  }

  post(type, payload) {
    if (!this.view) return;
    void this.view.webview.postMessage({ type, payload });
  }

  asWebviewUri(filePath) {
    if (!this.view || !filePath) return null;
    return this.view.webview.asWebviewUri(vscode.Uri.file(filePath));
  }

  async handleMessage(message) {
    if (!message || typeof message !== "object") return;
    switch (message.type) {
      case "ready":
        this.runtime.pushSnapshot();
        break;
      case "permission-decide":
        this.runtime.decidePermission(message.id, message.behavior);
        break;
      case "focus-terminal":
        if (typeof message.sessionId === "string") await this.runtime.focusTerminalForSession(message.sessionId);
        else await this.runtime.focusBestTerminal();
        break;
      case "toggle-dnd":
        await this.runtime.toggleDnd();
        break;
      case "install-integrations":
        await vscode.commands.executeCommand("clawd.installIntegrations");
        break;
      case "disable-integrations":
        await this.runtime.disableIntegrations();
        break;
      case "enable-integrations":
        await this.runtime.enableIntegrations();
        break;
      case "set-theme":
        if (message.themeId) await this.runtime.setTheme(message.themeId);
        break;
      case "restart-runtime":
        await this.runtime.restart();
        break;
      case "pause-runtime":
        await this.runtime.pause();
        break;
      case "resume-runtime":
        await this.runtime.resume();
        break;
      default:
        break;
    }
  }

  getHtml(webview) {
    const nonce = getNonce();
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "clawd.css"));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "clawd.js"));

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; media-src ${webview.cspSource}; connect-src ${webview.cspSource}; style-src ${webview.cspSource} 'nonce-${nonce}' 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${cssUri}" rel="stylesheet" nonce="${nonce}">
  <title>Clawd</title>
</head>
<body>
  <main class="clawd-shell">
    <section class="pet-stage" id="petStage" aria-label="Clawd pet">
      <div id="petContainer" class="pet-container"></div>
    </section>

    <section class="activity" aria-live="polite" aria-atomic="true">
      <div id="activityLabel" class="activity-label">Waking up…</div>
      <div id="activityNote" class="activity-note" hidden></div>
    </section>

    <div class="activity-content">
      <section class="permissions" id="permissions" aria-label="Agent approvals"></section>
      <section class="sessions" id="sessions" aria-label="Agent sessions"></section>
    </div>
    <section class="toast-log" id="toastLog" aria-live="polite"></section>
  </main>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }

  dispose() {
    this.runtime.clearPendingPermissionsForShutdown();
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    this.view = null;
  }
}

function getNonce() {
  return randomBytes(24).toString("base64");
}

module.exports = {
  ClawdViewProvider,
};
