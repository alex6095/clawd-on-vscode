"use strict";

const path = require("path");
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
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
        vscode.Uri.joinPath(this.context.extensionUri, "vendor", "clawd"),
      ],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((message) => this.handleMessage(message), null, this.disposables);
    void this.runtime.start();
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
        await this.runtime.focusBestTerminal();
        break;
      case "toggle-dnd":
        await this.runtime.toggleDnd();
        break;
      case "install-integrations":
        await this.runtime.installIntegrations();
        break;
      case "set-theme":
        if (message.themeId) await this.runtime.setTheme(message.themeId);
        break;
      case "restart-runtime":
        await this.runtime.restart();
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
    <header class="toolbar">
      <button class="icon-button" id="installBtn" title="Install agent integrations" aria-label="Install agent integrations">
        <svg class="icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path fill="currentColor" d="M11 1h-1v3H6V1H5v3H4v4l2 2v5h1v-5h2v5h1v-5l2-2V4h-1z"/>
        </svg>
      </button>
      <button class="icon-button" id="dndBtn" title="Toggle Do Not Disturb" aria-label="Toggle Do Not Disturb">
        <svg class="icon bell-on" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path fill="currentColor" d="M8 1a1.5 1.5 0 0 0-1.5 1.5v.55A5 5 0 0 0 3 8v3l-1.5 1.5V13h13v-.5L13 11V8a5 5 0 0 0-3.5-4.95V2.5A1.5 1.5 0 0 0 8 1zM6.5 14a1.5 1.5 0 1 0 3 0z"/>
        </svg>
        <svg class="icon bell-off" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path fill="currentColor" d="M8 1a1.5 1.5 0 0 0-1.5 1.5v.55A5 5 0 0 0 3 8v3l-1.5 1.5V13h13v-.5L13 11V8a5 5 0 0 0-3.5-4.95V2.5A1.5 1.5 0 0 0 8 1zM6.5 14a1.5 1.5 0 1 0 3 0z"/>
          <path stroke="currentColor" stroke-width="1.5" d="M2 2l12 12"/>
          <path stroke="var(--vscode-sideBar-background,#1e1e1e)" stroke-width="3" d="M2.5 1.5l12 12" opacity="0.9"/>
          <path stroke="currentColor" stroke-width="1.5" d="M2 2l12 12"/>
        </svg>
      </button>
      <button class="icon-button" id="themeBtn" title="Switch character" aria-label="Switch character">
        <svg class="icon theme-icon theme-icon-calico" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path fill="currentColor" fill-rule="evenodd" d="M3.15 5.9 2.35 2.45c-.08-.35.31-.61.6-.4L5.5 3.9A6.1 6.1 0 0 1 8 3.4c.89 0 1.73.17 2.5.5l2.55-1.85c.29-.21.68.05.6.4l-.8 3.45C13.57 6.7 14 7.73 14 8.9c0 2.83-2.37 4.85-6 4.85s-6-2.02-6-4.85c0-1.17.43-2.2 1.15-3zM5 7.8h1v1.6H5zm5 0h1v1.6h-1z"/>
        </svg>
        <svg class="icon theme-icon theme-icon-clawd" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path fill="currentColor" fill-rule="evenodd" d="M3 5h10v7H3zM1 8h2v2H1zm12 0h2v2h-2zM4 12h1v3H4zm2 0h1v3H6zm3 0h1v3H9zm2 0h1v3h-1zM5 7h1v2H5zm5 0h1v2h-1z"/>
        </svg>
      </button>
      <button class="icon-button" id="restartBtn" title="Restart Clawd runtime" aria-label="Restart Clawd runtime">
        <svg class="icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path fill="currentColor" d="M8 2.5a5.5 5.5 0 0 1 5.03 3.28l-.92.39A4.5 4.5 0 1 0 12.5 8.5h1.01A5.5 5.5 0 1 1 8 2.5z"/>
          <path fill="currentColor" d="M10.5 5.5h4v-4l-1.35 1.35A5.48 5.48 0 0 0 10.5 1v1.5a4 4 0 0 1 1.65.35z"/>
        </svg>
      </button>
    </header>

    <section class="pet-stage" id="petStage" aria-label="Clawd pet">
      <div class="pet-shadow"></div>
      <div id="petContainer" class="pet-container"></div>
    </section>

    <section class="status-strip">
      <div>
        <div class="eyebrow">State</div>
        <div id="stateLabel" class="status-value">Starting</div>
      </div>
      <div>
        <div class="eyebrow">Server</div>
        <div id="serverLabel" class="status-value">...</div>
      </div>
    </section>

    <section class="permissions" id="permissions"></section>
    <section class="sessions-wrap">
      <section class="sessions" id="sessions"></section>
    </section>
    <section class="toast-log" id="toastLog" aria-live="polite"></section>
  </main>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }

  dispose() {
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }
}

function getNonce() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let i = 0; i < 32; i++) value += alphabet[Math.floor(Math.random() * alphabet.length)];
  return value;
}

module.exports = {
  ClawdViewProvider,
};
