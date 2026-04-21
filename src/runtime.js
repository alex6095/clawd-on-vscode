"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { fileURLToPath } = require("url");
const vscode = require("vscode");
const { collectThemeFiles, toAssetMap } = require("./asset-map");

const VENDOR_DIR = path.join(__dirname, "..", "vendor", "clawd");
const VENDOR_SRC_DIR = path.join(VENDOR_DIR, "src");
const VENDOR_HOOKS_DIR = path.join(VENDOR_DIR, "hooks");
const VENDOR_AGENTS_DIR = path.join(VENDOR_DIR, "agents");
const VENDOR_AGENT_ICONS_DIR = path.join(VENDOR_DIR, "assets", "icons", "agents");

const AGENT_ICON_FILES = [
  ["claude-code", "claude-code.png"],
  ["codex", "codex.svg"],
  ["gemini-cli", "gemini-cli.png"],
  ["cursor-agent", "cursor-agent.png"],
  ["copilot-cli", "copilot-cli.png"],
  ["opencode", "opencode.png"],
];

const themeLoader = require(path.join(VENDOR_SRC_DIR, "theme-loader"));
const initState = require(path.join(VENDOR_SRC_DIR, "state"));
const initServer = require(path.join(VENDOR_SRC_DIR, "server"));
const {
  CLAWD_SERVER_HEADER,
  CLAWD_SERVER_ID,
} = require(path.join(VENDOR_HOOKS_DIR, "server-config"));

function basename(value) {
  return value ? path.basename(value) : "";
}

function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function serializeInput(input) {
  if (!input || typeof input !== "object") return "";
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

const FILE_PREVIEW_MAX_BYTES = 12000;

function readFilePreview(filePath, maxBytes = FILE_PREVIEW_MAX_BYTES) {
  if (!filePath || typeof filePath !== "string") return null;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return { exists: true, isFile: false, size: stat.size };

    const byteLength = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(byteLength);
    const fd = fs.openSync(filePath, "r");
    try {
      fs.readSync(fd, buffer, 0, byteLength, 0);
    } finally {
      fs.closeSync(fd);
    }

    return {
      exists: true,
      isFile: true,
      size: stat.size,
      truncated: stat.size > maxBytes,
      content: buffer.toString("utf8"),
    };
  } catch (err) {
    if (err && err.code === "ENOENT") return { exists: false };
    return { exists: null, error: err && err.message ? err.message : String(err) };
  }
}

function normalizeResolvedSuggestion(suggestion) {
  if (!suggestion || typeof suggestion !== "object") return null;
  switch (suggestion.type) {
    case "addRules":
    case "replaceRules":
    case "removeRules": {
      const rules = Array.isArray(suggestion.rules)
        ? suggestion.rules
        : [{ toolName: suggestion.toolName, ruleContent: suggestion.ruleContent }];
      return {
        type: suggestion.type,
        destination: suggestion.destination || "localSettings",
        behavior: suggestion.behavior || "allow",
        rules: rules.filter((rule) => rule && typeof rule === "object"),
      };
    }
    case "setMode":
      return {
        type: "setMode",
        mode: suggestion.mode,
        destination: suggestion.destination || "localSettings",
      };
    case "addDirectories":
    case "removeDirectories":
      return {
        type: suggestion.type,
        directories: Array.isArray(suggestion.directories) ? suggestion.directories.filter(Boolean) : [],
        destination: suggestion.destination || "localSettings",
      };
    default:
      return null;
  }
}

class ClawdRuntime {
  constructor(context, output) {
    this.context = context;
    this.output = output;
    this.view = null;
    this.started = false;
    this.activeTheme = null;
    this.state = null;
    this.server = null;
    this.codexMonitor = null;
    this.geminiMonitor = null;
    this.pendingPermissions = [];
    this.doNotDisturb = false;
    this.hideBubbles = false;
    this.currentState = "idle";
    this.currentSvg = null;
  }

  attachView(view) {
    this.view = view;
  }

  log(message) {
    if (this.output) this.output.appendLine(`[Clawd] ${message}`);
  }

  getConfig() {
    return vscode.workspace.getConfiguration("clawd");
  }

  isRuntimeEnabled() {
    return this.getConfig().get("runtime.enabled", true) !== false;
  }

  areIntegrationsEnabled() {
    return this.getConfig().get("integrations.enabled", true) !== false;
  }

  async setRuntimeEnabled(enabled) {
    await this.getConfig().update("runtime.enabled", !!enabled, vscode.ConfigurationTarget.Global);
    await this.updateContextKeys();
  }

  async setIntegrationsEnabled(enabled) {
    await this.getConfig().update("integrations.enabled", !!enabled, vscode.ConfigurationTarget.Global);
    await this.updateContextKeys();
  }

  async updateContextKeys() {
    try {
      await vscode.commands.executeCommand("setContext", "clawd.runtime.paused", !this.isRuntimeEnabled());
      await vscode.commands.executeCommand("setContext", "clawd.integrations.enabled", this.areIntegrationsEnabled());
    } catch {}
  }

  ensureThemeReady() {
    const userData = this.context.globalStorageUri.fsPath;
    fs.mkdirSync(userData, { recursive: true });
    themeLoader.init(VENDOR_SRC_DIR, userData);
    this.activeTheme = this.loadConfiguredTheme();
    if (!this.currentSvg && this.activeTheme && this.activeTheme.states && this.activeTheme.states.idle) {
      this.currentSvg = this.activeTheme.states.idle[0];
    }
  }

  async start(options = {}) {
    if (options.force) await this.setRuntimeEnabled(true);
    await this.updateContextKeys();

    if (!this.isRuntimeEnabled()) {
      this.disposeRuntime();
      this.ensureThemeReady();
      this.currentState = "paused";
      this.pushSnapshot();
      return;
    }

    if (this.started) {
      this.pushSnapshot();
      return;
    }

    this.ensureThemeReady();

    this.state = initState(this.createStateContext());
    this.server = initServer(this.createServerContext());
    this.server.startHttpServer();
    this.state.startStaleCleanup();
    this.startLogMonitors();
    this.started = true;

    this.state.applyState("idle", this.activeTheme.states.idle[0]);
    this.pushSnapshot();
    this.log("runtime started");
  }

  async restart() {
    if (!this.isRuntimeEnabled()) await this.setRuntimeEnabled(true);
    this.disposeRuntime();
    this.started = false;
    await this.start({ force: true });
  }

  async pause() {
    await this.setRuntimeEnabled(false);
    this.disposeRuntime();
    this.started = false;
    this.ensureThemeReady();
    this.currentState = "paused";
    this.pushSnapshot();
    this.log("runtime paused");
    return { message: "Clawd runtime paused." };
  }

  async resume() {
    await this.setRuntimeEnabled(true);
    await this.start({ force: true });
    return { message: "Clawd runtime resumed." };
  }

  disposeRuntime() {
    this.clearPendingPermissionsForShutdown();
    try { if (this.codexMonitor) this.codexMonitor.stop(); } catch {}
    try { if (this.geminiMonitor) this.geminiMonitor.stop(); } catch {}
    try { if (this.state) this.state.cleanup(); } catch {}
    try { if (this.server) this.server.cleanup(); } catch {}
    this.codexMonitor = null;
    this.geminiMonitor = null;
    this.state = null;
    this.server = null;
    this.pendingPermissions = [];
  }

  clearPendingPermissionsForShutdown() {
    for (const entry of [...this.pendingPermissions]) {
      if (!entry) continue;
      if (entry._clawdId) this.viewPost("permission-hide", { id: entry._clawdId });
      if (entry.isCodexNotify || entry.isOpencode) continue;
      const { res, abortHandler } = entry;
      try {
        if (res && abortHandler) res.removeListener("close", abortHandler);
      } catch {}
      try {
        if (res && !res.writableEnded && !res.destroyed) res.destroy();
      } catch {}
    }
  }

  dispose() {
    this.disposeRuntime();
  }

  loadConfiguredTheme() {
    const configured = vscode.workspace.getConfiguration("clawd").get("theme", "clawd");
    try {
      return themeLoader.loadTheme(configured, { strict: true });
    } catch (err) {
      this.log(`failed to load theme "${configured}", falling back to clawd: ${err.message}`);
      return themeLoader.loadTheme("clawd", { strict: true });
    }
  }

  async setTheme(themeId) {
    await vscode.workspace.getConfiguration("clawd").update("theme", themeId, vscode.ConfigurationTarget.Global);
    this.activeTheme = themeLoader.loadTheme(themeId, { strict: true });
    if (this.state) {
      this.state.refreshTheme();
      this.state.applyState(this.state.getCurrentState(), this.state.getSvgOverride(this.state.getCurrentState()));
    } else if (this.activeTheme && this.activeTheme.states && this.activeTheme.states.idle) {
      this.currentSvg = this.activeTheme.states.idle[0];
    }
    this.postThemeConfig();
  }

  createStateContext() {
    const runtime = this;
    return {
      get theme() { return themeLoader.getActiveTheme(); },
      get doNotDisturb() { return runtime.doNotDisturb; },
      set doNotDisturb(value) { runtime.doNotDisturb = !!value; },
      get hideBubbles() { return runtime.hideBubbles; },
      get pendingPermissions() { return runtime.pendingPermissions; },
      get miniMode() { return false; },
      get miniTransitioning() { return false; },
      get mouseOverPet() { return false; },
      get miniSleepPeeked() { return false; },
      set miniSleepPeeked(_value) {},
      get miniPeeked() { return false; },
      set miniPeeked(_value) {},
      get idlePaused() { return false; },
      set idlePaused(_value) {},
      get forceEyeResend() { return false; },
      set forceEyeResend(_value) {},
      get mouseStillSince() { return Date.now(); },
      sendToRenderer: (channel, ...args) => this.sendToRenderer(channel, ...args),
      sendToHitWin: () => {},
      syncHitWin: () => {},
      playSound: (name) => this.playSound(name),
      t: (key) => key,
      focusTerminalWindow: (...args) => this.focusTerminalWindow(...args),
      resolvePermissionEntry: (...args) => this.resolvePermissionEntry(...args),
      miniPeekIn: () => {},
      miniPeekOut: () => {},
      buildContextMenu: () => {},
      buildTrayMenu: () => {},
      debugLog: (message) => this.log(message),
      isOneshotDisabled: () => false,
      hasAnyEnabledAgent: () => runtime.isRuntimeEnabled() && runtime.areIntegrationsEnabled(),
    };
  }

  createServerContext() {
    const runtime = this;
    return {
      get manageClaudeHooksAutomatically() { return runtime.areIntegrationsEnabled(); },
      get autoStartWithClaude() { return false; },
      get doNotDisturb() { return runtime.doNotDisturb; },
      get hideBubbles() { return runtime.hideBubbles; },
      get pendingPermissions() { return runtime.pendingPermissions; },
      get PASSTHROUGH_TOOLS() {
        return new Set(["TaskCreate", "TaskUpdate", "TaskGet", "TaskList", "TaskStop", "TaskOutput"]);
      },
      get STATE_SVGS() { return runtime.state ? runtime.state.STATE_SVGS : {}; },
      get sessions() { return runtime.state ? runtime.state.sessions : new Map(); },
      isAgentEnabled: () => runtime.isRuntimeEnabled() && runtime.areIntegrationsEnabled(),
      isAgentPermissionsEnabled: () => runtime.isRuntimeEnabled() && runtime.areIntegrationsEnabled(),
      setState: (...args) => this.state.setState(...args),
      updateSession: (...args) => this.state.updateSession(...args),
      resolvePermissionEntry: (...args) => this.resolvePermissionEntry(...args),
      sendPermissionResponse: (...args) => this.sendPermissionResponse(...args),
      showPermissionBubble: (entry) => this.showPermissionBubble(entry),
      replyOpencodePermission: (...args) => this.replyOpencodePermission(...args),
      permLog: (message) => this.log(`permission: ${message}`),
      syncClawdHooksImpl: ({ port, autoStart }) => this.syncClaudeHooks(port, autoStart),
      syncGeminiHooksImpl: () => {},
      syncCursorHooksImpl: () => {},
      syncCodeBuddyHooksImpl: () => {},
      syncKiroHooksImpl: () => {},
      syncOpencodePluginImpl: () => {},
    };
  }

  startLogMonitors() {
    try {
      const CodexLogMonitor = require(path.join(VENDOR_AGENTS_DIR, "codex-log-monitor"));
      const codexAgent = require(path.join(VENDOR_AGENTS_DIR, "codex"));
      this.codexMonitor = new CodexLogMonitor(codexAgent, (sid, state, event, extra = {}) => {
        if (state === "codex-permission") {
          this.state.updateSession(sid, "notification", event, {
            cwd: extra.cwd,
            agentId: "codex",
            sessionTitle: extra.sessionTitle,
          });
          this.showCodexNotifyBubble({
            sessionId: sid,
            command: extra.permissionDetail && extra.permissionDetail.command,
          });
          return;
        }
        this.dismissCodexNotifyBubble(sid);
        this.state.updateSession(sid, state, event, {
          cwd: extra.cwd,
          agentId: "codex",
          sessionTitle: extra.sessionTitle,
        });
      });
      this.codexMonitor.start();
    } catch (err) {
      this.log(`Codex log monitor not started: ${err.message}`);
    }

    try {
      const GeminiLogMonitor = require(path.join(VENDOR_AGENTS_DIR, "gemini-log-monitor"));
      const geminiAgent = require(path.join(VENDOR_AGENTS_DIR, "gemini-cli"));
      this.geminiMonitor = new GeminiLogMonitor(geminiAgent, (sid, state, event, extra = {}) => {
        this.state.updateSession(sid, state, event, {
          cwd: extra.cwd,
          agentId: "gemini-cli",
        });
      });
      this.geminiMonitor.start();
    } catch (err) {
      this.log(`Gemini log monitor not started: ${err.message}`);
    }
  }

  sendToRenderer(channel, ...args) {
    if (channel === "state-change") {
      const [state, svg] = args;
      this.currentState = state;
      this.currentSvg = svg;
      this.viewPost("state-change", {
        state,
        svg,
        sessions: this.serializeSessions(),
      });
      return;
    }
    if (channel === "dnd-change") {
      this.viewPost("dnd-change", { enabled: !!args[0] });
      return;
    }
    if (channel === "play-sound") {
      this.viewPost("play-sound", { uri: args[0] });
      return;
    }
    this.viewPost(channel, { args });
  }

  viewPost(type, payload) {
    if (this.view) this.view.post(type, payload);
  }

  pushSnapshot() {
    if (!this.view) return;
    const runtimeEnabled = this.isRuntimeEnabled();
    this.viewPost("init", {
      serverPort: this.server ? this.server.getHookServerPort() : null,
      paused: !runtimeEnabled,
      integrationsEnabled: this.areIntegrationsEnabled(),
      dnd: this.doNotDisturb,
      themeId: this.activeTheme && this.activeTheme._id,
      themes: themeLoader.discoverThemes().map((theme) => ({ id: theme.id, name: theme.name })),
      config: this.buildRendererConfig(),
      state: runtimeEnabled ? this.currentState : "paused",
      svg: this.currentSvg,
      sessions: runtimeEnabled ? this.serializeSessions() : [],
      permissions: runtimeEnabled ? this.pendingPermissions.map((entry) => this.serializePermission(entry)) : [],
    });
  }

  postThemeConfig() {
    this.viewPost("theme-config", {
      themeId: this.activeTheme && this.activeTheme._id,
      config: this.buildRendererConfig(),
    });
  }

  buildRendererConfig() {
    const config = themeLoader.getRendererConfig() || {};
    const theme = themeLoader.getActiveTheme();
    const assetMap = toAssetMap(theme, (filename) => {
      try {
        return this.view ? this.view.asWebviewUri(themeLoader.getAssetPath(filename)) : null;
      } catch {
        return null;
      }
    });
    const soundMap = {};
    for (const soundName of ["complete", "confirm"]) {
      const soundUrl = themeLoader.getSoundUrl(soundName);
      if (!soundUrl || !this.view) continue;
      try {
        soundMap[soundName] = String(this.view.asWebviewUri(fileURLToPath(soundUrl)));
      } catch {}
    }
    const agentIconMap = {};
    if (this.view) {
      for (const [agentId, filename] of AGENT_ICON_FILES) {
        try {
          agentIconMap[agentId] = String(
            this.view.asWebviewUri(path.join(VENDOR_AGENT_ICONS_DIR, filename))
          );
        } catch {}
      }
    }
    return {
      ...config,
      assetMap,
      soundMap,
      agentIconMap,
      reactions: theme && theme.reactions ? theme.reactions : {},
      allFiles: Array.from(collectThemeFiles(theme)),
    };
  }

  serializeSessions() {
    if (!this.state) return [];
    const items = [];
    for (const [id, session] of this.state.sessions) {
      items.push({
        id,
        state: session.state,
        agentId: session.agentId || "agent",
        cwd: session.cwd || "",
        folder: session.cwd ? basename(session.cwd) : id.slice(-8),
        title: session.sessionTitle || null,
        updatedAt: session.updatedAt,
        sourcePid: session.sourcePid || null,
        pidChain: Array.isArray(session.pidChain) ? session.pidChain : [],
        host: session.host || "",
      });
    }
    items.sort((a, b) => {
      const pa = this.state.STATE_PRIORITY[a.state] || 0;
      const pb = this.state.STATE_PRIORITY[b.state] || 0;
      return pb - pa || b.updatedAt - a.updatedAt;
    });
    return items;
  }

  playSound(name) {
    const enabled = vscode.workspace.getConfiguration("clawd").get("sound.enabled", true);
    if (!enabled) return;
    const soundUrl = themeLoader.getSoundUrl(name);
    if (!soundUrl || !this.view) return;
    try {
      this.viewPost("play-sound", { uri: String(this.view.asWebviewUri(fileURLToPath(soundUrl))) });
    } catch {}
  }

  showPermissionBubble(entry) {
    if (!entry._clawdId) entry._clawdId = makeId("perm");
    this.viewPost("permission-show", this.serializePermission(entry));
  }

  showCodexNotifyBubble({ sessionId, command }) {
    const entry = {
      _clawdId: makeId("codex"),
      res: null,
      abortHandler: null,
      suggestions: [],
      sessionId,
      toolName: "CodexExec",
      toolInput: { command: command || "(unknown)" },
      createdAt: Date.now(),
      isCodexNotify: true,
      agentId: "codex",
    };
    this.pendingPermissions.push(entry);
    this.showPermissionBubble(entry);
  }

  dismissCodexNotifyBubble(sessionId) {
    for (const entry of [...this.pendingPermissions]) {
      if (entry.isCodexNotify && (!sessionId || entry.sessionId === sessionId)) {
        this.resolvePermissionEntry(entry, "deny");
      }
    }
  }

  serializePermission(entry) {
    const isElicitation = !!entry.isElicitation;
    const toolInput = entry.toolInput && typeof entry.toolInput === "object" ? entry.toolInput : {};
    const questions = isElicitation && Array.isArray(toolInput.questions) ? toolInput.questions : null;
    const previewFilePath = ["Write", "Edit", "NotebookEdit"].includes(entry.toolName)
      ? toolInput.file_path || toolInput.notebook_path
      : null;
    return {
      id: entry._clawdId,
      agentId: entry.agentId || "claude-code",
      sessionId: entry.sessionId || "default",
      toolName: entry.toolName || "Unknown",
      toolInput,
      inputPreview: serializeInput(entry.toolInput),
      suggestions: Array.isArray(entry.suggestions) ? entry.suggestions : [],
      isElicitation,
      isOpencode: !!entry.isOpencode,
      isCodexNotify: !!entry.isCodexNotify,
      canAlways: !!(entry.isOpencode && Array.isArray(entry.opencodeAlwaysCandidates) && entry.opencodeAlwaysCandidates.length),
      questions,
      preview: previewFilePath ? { file: readFilePreview(previewFilePath) } : null,
      createdAt: entry.createdAt || Date.now(),
    };
  }

  decidePermission(id, behavior) {
    const entry = this.pendingPermissions.find((candidate) => candidate._clawdId === id);
    if (!entry) return;

    if (entry.isCodexNotify) {
      this.resolvePermissionEntry(entry, "deny");
      return;
    }

    if (entry.isElicitation && behavior && typeof behavior === "object" && behavior.type === "elicitation-submit") {
      entry.resolvedUpdatedInput = this.buildElicitationUpdatedInput(entry.toolInput, behavior.answers);
      this.resolvePermissionEntry(entry, "allow");
      return;
    }

    if (behavior === "opencode-always") {
      entry.opencodeAlwaysPicked = true;
      this.resolvePermissionEntry(entry, "allow");
      return;
    }

    if (typeof behavior === "string" && behavior.startsWith("suggestion:")) {
      const idx = Number.parseInt(behavior.split(":")[1], 10);
      const suggestion = entry.suggestions && entry.suggestions[idx];
      if (!suggestion) {
        this.resolvePermissionEntry(entry, "deny", "Invalid suggestion index");
        return;
      }
      entry.resolvedSuggestion = normalizeResolvedSuggestion(suggestion);
      this.resolvePermissionEntry(entry, "allow");
      return;
    }

    if (behavior === "deny-and-focus") {
      this.removePermission(entry);
      this.focusTerminalForSession(entry.sessionId);
      return;
    }

    this.resolvePermissionEntry(entry, behavior === "allow" ? "allow" : "deny");
  }

  buildElicitationUpdatedInput(toolInput, answers) {
    const input = toolInput && typeof toolInput === "object" ? toolInput : {};
    const questions = Array.isArray(input.questions) ? input.questions : [];
    const normalizedAnswers = {};
    for (const question of questions) {
      if (!question || typeof question.question !== "string") continue;
      const answer = answers && Object.prototype.hasOwnProperty.call(answers, question.question)
        ? answers[question.question]
        : undefined;
      if (typeof answer === "string" && answer.trim()) normalizedAnswers[question.question] = answer.trim();
    }
    return { ...input, questions, answers: normalizedAnswers };
  }

  removePermission(entry) {
    const idx = this.pendingPermissions.indexOf(entry);
    if (idx !== -1) this.pendingPermissions.splice(idx, 1);
    this.viewPost("permission-hide", { id: entry._clawdId });
  }

  resolvePermissionEntry(entry, behavior, message) {
    if (entry.isCodexNotify) {
      this.removePermission(entry);
      return;
    }

    const idx = this.pendingPermissions.indexOf(entry);
    if (idx === -1) return;
    this.pendingPermissions.splice(idx, 1);
    this.viewPost("permission-hide", { id: entry._clawdId });

    const { res, abortHandler } = entry;
    if (res && abortHandler) res.removeListener("close", abortHandler);

    if (entry.isOpencode) {
      const reply = behavior === "deny" ? "reject" : (entry.opencodeAlwaysPicked ? "always" : "once");
      this.replyOpencodePermission({
        bridgeUrl: entry.opencodeBridgeUrl,
        bridgeToken: entry.opencodeBridgeToken,
        requestId: entry.opencodeRequestId,
        reply,
        toolName: entry.toolName,
      });
      return;
    }

    if (!res || res.writableEnded || res.destroyed) return;

    if (entry.isElicitation) {
      if (behavior === "allow" && entry.resolvedUpdatedInput) {
        this.sendPermissionResponse(res, {
          behavior: "allow",
          updatedInput: entry.resolvedUpdatedInput,
        });
      } else {
        this.sendPermissionResponse(res, "deny", message, "Elicitation");
        this.focusTerminalForSession(entry.sessionId);
      }
      return;
    }

    const decision = { behavior: behavior === "deny" ? "deny" : "allow" };
    if (behavior === "deny" && message) decision.message = message;
    if (entry.resolvedSuggestion) decision.updatedPermissions = [entry.resolvedSuggestion];
    this.sendPermissionResponse(res, decision);
  }

  sendPermissionResponse(res, decisionOrBehavior, message, hookEventName = "PermissionRequest") {
    const decision = typeof decisionOrBehavior === "string"
      ? { behavior: decisionOrBehavior, ...(message ? { message } : {}) }
      : decisionOrBehavior;
    const body = JSON.stringify({ hookSpecificOutput: { hookEventName, decision } });
    res.writeHead(200, {
      "Content-Type": "application/json",
      [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID,
    });
    res.end(body);
  }

  replyOpencodePermission({ bridgeUrl, bridgeToken, requestId, reply, toolName }) {
    if (!bridgeUrl || !bridgeToken || !requestId) return;
    let parsed;
    try {
      parsed = new URL(`${bridgeUrl.replace(/\/$/, "")}/reply`);
    } catch {
      return;
    }
    const body = JSON.stringify({ request_id: requestId, reply });
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        Authorization: `Bearer ${bridgeToken}`,
      },
      timeout: 5000,
      family: 4,
    }, (res) => res.resume());
    req.on("error", (err) => this.log(`opencode reply failed for ${toolName || requestId}: ${err.message}`));
    req.on("timeout", () => req.destroy());
    req.write(body);
    req.end();
  }

  async toggleDnd() {
    await this.start();
    if (!this.state) {
      this.pushSnapshot();
      return this.doNotDisturb;
    }
    if (this.doNotDisturb) this.state.disableDoNotDisturb();
    else this.state.enableDoNotDisturb();
    this.pushSnapshot();
    return this.doNotDisturb;
  }

  async installIntegrations() {
    await this.setIntegrationsEnabled(true);
    await this.start({ force: true });
    const port = this.server.getHookServerPort();
    const results = [];
    const run = (name, fn) => {
      try {
        const result = fn();
        results.push(`${name}: ${JSON.stringify(result)}`);
      } catch (err) {
        results.push(`${name}: failed (${err.message})`);
      }
    };

    run("Claude Code", () => this.syncClaudeHooks(port, false));
    run("Gemini CLI", () => require(path.join(VENDOR_HOOKS_DIR, "gemini-install")).registerGeminiHooks({ silent: true }));
    run("Cursor Agent", () => require(path.join(VENDOR_HOOKS_DIR, "cursor-install")).registerCursorHooks({ silent: true }));
    run("CodeBuddy", () => require(path.join(VENDOR_HOOKS_DIR, "codebuddy-install")).registerCodeBuddyHooks({ silent: true }));
    run("Kiro CLI", () => require(path.join(VENDOR_HOOKS_DIR, "kiro-install")).registerKiroHooks({ silent: true }));
    run("opencode", () => require(path.join(VENDOR_HOOKS_DIR, "opencode-install")).registerOpencodePlugin({ silent: true }));

    const message = `Clawd integrations synced on port ${port}.`;
    this.log(`${message}\n${results.join("\n")}`);
    this.viewPost("install-result", { message, details: results });
    await this.updateContextKeys();
    return { message, details: results };
  }

  async uninstallIntegrations() {
    const results = [];
    const run = (name, fn) => {
      try {
        const result = fn();
        results.push(`${name}: ${JSON.stringify(result)}`);
      } catch (err) {
        results.push(`${name}: failed (${err.message})`);
      }
    };

    run("Claude Code", () => require(path.join(VENDOR_HOOKS_DIR, "install")).unregisterHooks({ silent: true }));
    run("Gemini CLI", () => require(path.join(VENDOR_HOOKS_DIR, "gemini-install")).unregisterGeminiHooks({ silent: true }));
    run("Cursor Agent", () => require(path.join(VENDOR_HOOKS_DIR, "cursor-install")).unregisterCursorHooks({ silent: true }));
    run("CodeBuddy", () => require(path.join(VENDOR_HOOKS_DIR, "codebuddy-install")).unregisterCodeBuddyHooks({ silent: true }));
    run("Kiro CLI", () => require(path.join(VENDOR_HOOKS_DIR, "kiro-install")).unregisterKiroHooks({ silent: true }));
    run("opencode", () => require(path.join(VENDOR_HOOKS_DIR, "opencode-install")).unregisterOpencodePlugin({ silent: true }));

    const message = "Clawd agent integrations disabled.";
    this.log(`${message}\n${results.join("\n")}`);
    this.viewPost("install-result", { message, details: results });
    return { message, details: results };
  }

  async disableIntegrations() {
    await this.setIntegrationsEnabled(false);
    const result = await this.uninstallIntegrations();
    await this.pause();
    await this.updateContextKeys();
    return result;
  }

  async enableIntegrations() {
    await this.setIntegrationsEnabled(true);
    const result = await this.installIntegrations();
    await this.updateContextKeys();
    return result;
  }

  syncClaudeHooks(port, autoStart = false) {
    const result = require(path.join(VENDOR_HOOKS_DIR, "install")).registerHooks({
      silent: true,
      port,
      autoStart: !!autoStart,
    });
    if (result.added > 0 || result.updated > 0 || result.removed > 0) {
      this.log(`Claude Code hooks synced on port ${port}: added=${result.added}, updated=${result.updated}, removed=${result.removed}`);
    }
    return result;
  }

  async focusBestTerminal() {
    const sessions = this.serializeSessions();
    const best = sessions.find((session) => session.sourcePid || session.pidChain.length);
    if (!best) return false;
    return this.focusTerminalWindow(best.sourcePid, best.cwd, null, best.pidChain);
  }

  async focusTerminalForSession(sessionId) {
    if (!this.state) return false;
    const session = this.state.sessions.get(sessionId);
    if (!session) return false;
    return this.focusTerminalWindow(session.sourcePid, session.cwd, session.editor, session.pidChain);
  }

  async focusTerminalWindow(sourcePid, _cwd, _editor, pidChain) {
    const pids = new Set();
    if (Number.isFinite(sourcePid) && sourcePid > 0) pids.add(sourcePid);
    if (Array.isArray(pidChain)) {
      for (const pid of pidChain) if (Number.isFinite(pid) && pid > 0) pids.add(pid);
    }
    if (pids.size === 0) return false;

    for (const terminal of vscode.window.terminals) {
      let pid = null;
      try { pid = await terminal.processId; } catch {}
      if (pid && pids.has(pid)) {
        terminal.show(false);
        return true;
      }
    }
    return false;
  }
}

function createRuntime(context, output) {
  return new ClawdRuntime(context, output);
}

module.exports = {
  createRuntime,
  ClawdRuntime,
};
