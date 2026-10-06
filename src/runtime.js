"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { randomUUID } = require("crypto");
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
    this.runtimeInstanceId = randomUUID();
    this.startPromise = null;
    this.generation = 0;
    this.hookSessions = new Set();
    this.hookAgents = new Set();
    this.connectionState = "starting";
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

  selectedAgents() {
    const agents = this.getConfig().get("integrations.agents", ["claude-code", "codex"]);
    return Array.isArray(agents) ? agents : ["claude-code", "codex"];
  }

  isAgentEnabled(id) {
    return this.isRuntimeEnabled() && this.areIntegrationsEnabled()
      && vscode.workspace.isTrusted !== false && this.selectedAgents().includes(id || "claude-code");
  }

  workspaceRoots() {
    return (vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.fsPath);
  }

  acceptsSession(cwd) {
    if (this.getConfig().get("sessions.scope", "workspace") === "all") return true;
    const roots = this.workspaceRoots();
    if (!roots.length) return true;
    if (!cwd) return false;
    return roots.some((root) => {
      const relative = path.relative(root, cwd);
      return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
    });
  }

  ingestSession(sid, state, event, extra = {}, source = extra.source === "log" ? "log" : "hook") {
    if (!this.state || !this.isAgentEnabled(extra.agentId)) return;
    const existing = this.state.sessions.get(sid);
    const cwd = extra.cwd || existing && existing.cwd;
    if (!this.acceptsSession(cwd)) return;
    if (source === "log" && this.hookSessions.has(sid)) return;
    if (source === "hook") {
      this.hookSessions.add(sid);
      this.hookAgents.add(extra.agentId || "claude-code");
    }
    this.state.updateSession(sid, state, event, { ...extra, cwd, source });
  }

  isPermissionUIAvailable() {
    return !!(this.view && this.view.isVisible && this.isRuntimeEnabled() && !this.doNotDisturb);
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
      await vscode.commands.executeCommand("setContext", "clawd.dnd", this.doNotDisturb);
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
    if (!this.startPromise) {
      const pending = this.startOnce(this.generation);
      this.startPromise = pending;
      pending.finally(() => { if (this.startPromise === pending) this.startPromise = null; }).catch(() => {});
    }
    return this.startPromise;
  }

  async startOnce(generation) {
    await this.updateContextKeys();
    if (generation !== this.generation) return;

    if (!this.isRuntimeEnabled() || vscode.workspace.isTrusted === false) {
      this.disposeRuntime();
      this.ensureThemeReady();
      this.currentState = "paused";
      this.pushSnapshot();
      return;
    }

    if (this.started) {
      this.refreshRuntimeRegistration();
      this.pushSnapshot();
      return;
    }

    this.ensureThemeReady();

    this.connectionState = "starting";
    this.pushSnapshot();
    this.state = initState(this.createStateContext());
    this.server = initServer(this.createServerContext());
    const server = this.server;
    try {
      await server.startHttpServer();
    } catch (error) {
      if (generation === this.generation) {
        this.disposeRuntime();
        this.pushSnapshot();
      }
      throw error;
    }
    if (generation !== this.generation) { server.cleanup(); return; }
    if (!this.isRuntimeEnabled() || vscode.workspace.isTrusted === false) {
      this.disposeRuntime();
      this.currentState = "paused";
      this.pushSnapshot();
      return;
    }
    this.state.startStaleCleanup();
    this.startLogMonitors();
    this.started = true;
    this.connectionState = "connected";

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
    if (!this.areIntegrationsEnabled()) {
      await this.setIntegrationsEnabled(true);
      this.disposeRuntime();
    }
    await this.setRuntimeEnabled(true);
    await this.start({ force: true });
    return { message: "Clawd runtime resumed." };
  }

  disposeRuntime() {
    this.generation++;
    this.startPromise = null;
    this.started = false;
    this.connectionState = "disconnected";
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
    this.hookSessions.clear();
    this.hookAgents.clear();
  }

  clearPendingPermissionsForShutdown() {
    for (const entry of [...this.pendingPermissions]) {
      if (entry) this.deferPermissionEntry(entry, "Clawd unavailable; continue in the agent");
    }
  }

  deferPermissionEntry(entry, reason) {
    this.removePermission(entry);
    const { res, abortHandler } = entry;
    if (res && abortHandler) res.removeListener("close", abortHandler);
    if (res && !res.writableEnded && !res.destroyed) {
      if (typeof res.end === "function") {
        res.writeHead(200, { "Content-Type": "application/json", [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID });
        res.end("{}");
      } else if (typeof res.destroy === "function") res.destroy();
    }
    if (reason) this.log(reason);
  }

  dispose() {
    this.disposeRuntime();
  }

  refreshRuntimeRegistration() {
    if (this.server && typeof this.server.refreshRuntimeRegistration === "function") this.server.refreshRuntimeRegistration();
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
    this.ensureThemeReady();
    if (!themeLoader.discoverThemes().some((theme) => theme.id === themeId)) throw new Error("Unknown character");
    this.activeTheme = themeLoader.loadTheme(themeId, { strict: true });
    this.postThemeConfig();
    if (this.state) {
      this.state.refreshTheme();
      this.state.applyState(this.state.getCurrentState(), this.state.getSvgOverride(this.state.getCurrentState()));
    } else if (this.activeTheme && this.activeTheme.states && this.activeTheme.states.idle) {
      this.currentSvg = this.activeTheme.states.idle[0];
    }
    this.pushSnapshot();
    if (this.getConfig().get("theme") !== themeId) {
      await this.getConfig().update("theme", themeId, vscode.ConfigurationTarget.Global);
    }
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
      deferPermissionEntry: (...args) => this.deferPermissionEntry(...args),
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
      get manageClaudeHooksAutomatically() { return false; },
      get workspaceRoots() { return runtime.workspaceRoots(); },
      runtimeInstanceId: this.runtimeInstanceId,
      get autoStartWithClaude() { return false; },
      get doNotDisturb() { return runtime.doNotDisturb; },
      get hideBubbles() { return runtime.hideBubbles; },
      get pendingPermissions() { return runtime.pendingPermissions; },
      get PASSTHROUGH_TOOLS() {
        return new Set(["TaskCreate", "TaskUpdate", "TaskGet", "TaskList", "TaskStop", "TaskOutput"]);
      },
      get STATE_SVGS() { return runtime.state ? runtime.state.STATE_SVGS : {}; },
      get sessions() { return runtime.state ? runtime.state.sessions : new Map(); },
      isAgentEnabled: (id) => runtime.isAgentEnabled(id),
      isAgentPermissionsEnabled: (id) => runtime.isAgentEnabled(id),
      isPermissionUIAvailable: () => runtime.isPermissionUIAvailable(),
      setState: (...args) => this.state.setState(...args),
      updateSession: (...args) => this.ingestSession(...args),
      resolvePermissionEntry: (...args) => this.resolvePermissionEntry(...args),
      deferPermissionEntry: (...args) => this.deferPermissionEntry(...args),
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
    if (this.isAgentEnabled("codex") && this.getConfig().get("codex.logFallback", true)) try {
      const CodexLogMonitor = require(path.join(VENDOR_AGENTS_DIR, "codex-log-monitor"));
      const codexAgent = require(path.join(VENDOR_AGENTS_DIR, "codex"));
      this.codexMonitor = new CodexLogMonitor(codexAgent, (sid, state, event, extra = {}) => {
        this.ingestSession(sid, state, event, { ...extra, agentId: "codex" }, "log");
      });
      this.codexMonitor.start();
    } catch (err) {
      this.log(`Codex log monitor not started: ${err.message}`);
    }

    if (this.isAgentEnabled("gemini-cli")) try {
      const GeminiLogMonitor = require(path.join(VENDOR_AGENTS_DIR, "gemini-log-monitor"));
      const geminiAgent = require(path.join(VENDOR_AGENTS_DIR, "gemini-cli"));
      this.geminiMonitor = new GeminiLogMonitor(geminiAgent, (sid, state, event, extra = {}) => {
        this.ingestSession(sid, state, event, { ...extra, agentId: "gemini-cli" }, "log");
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
      void this.updateContextKeys();
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
    const runtimeEnabled = this.isRuntimeEnabled() && vscode.workspace.isTrusted !== false;
    this.viewPost("init", {
      serverPort: this.server ? this.server.getHookServerPort() : null,
      paused: !runtimeEnabled,
      connectionState: !runtimeEnabled ? "paused" : this.connectionState,
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
      reducedMotion: this.getConfig().get("animation.reducedMotion", "system"),
      assetMap,
      soundMap,
      agentIconMap,
      reactions: theme && theme.reactions ? theme.reactions : {},
      hitBoxes: theme && theme.hitBoxes || {},
      wideHitboxFiles: theme && theme.wideHitboxFiles || [],
      sleepingHitboxFiles: theme && theme.sleepingHitboxFiles || [],
      allFiles: Array.from(collectThemeFiles(theme)),
    };
  }

  serializeSessions() {
    if (!this.state) return [];
    const items = [];
    const waiting = new Set(this.pendingPermissions.filter((entry) => !entry.isCodexNotify).map((entry) => entry.sessionId));
    for (const [id, session] of this.state.sessions) {
      items.push({
        id,
        state: waiting.has(id) ? "notification" : session.state,
        status: waiting.has(id) ? "approval_waiting" : session.status,
        agentId: session.agentId || "agent",
        cwd: session.cwd || "",
        folder: session.cwd ? basename(session.cwd) : id.slice(-8),
        title: session.sessionTitle || null,
        updatedAt: session.updatedAt,
        sourcePid: session.sourcePid || null,
        pidChain: Array.isArray(session.pidChain) ? session.pidChain : [],
        host: session.host || "",
        source: session.source || "hook",
        activeChildren: session.activeChildren instanceof Set ? session.activeChildren.size : 0,
        model: session.model || null,
        turnId: session.turnId || null,
        toolCallId: session.toolCallId || null,
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
      suggestions: entry.agentId !== "codex" && Array.isArray(entry.suggestions) ? entry.suggestions : [],
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
      if (!entry.isOpencode) return;
      entry.opencodeAlwaysPicked = true;
      this.resolvePermissionEntry(entry, "allow");
      return;
    }

    if (typeof behavior === "string" && behavior.startsWith("suggestion:")) {
      if (entry.agentId === "codex") return;
      const idx = Number.parseInt(behavior.split(":")[1], 10);
      const suggestion = entry.suggestions && entry.suggestions[idx];
      if (!suggestion) {
        return;
      }
      entry.resolvedSuggestion = normalizeResolvedSuggestion(suggestion);
      this.resolvePermissionEntry(entry, "allow");
      return;
    }

    if (behavior === "deny-and-focus") {
      this.deferPermissionEntry(entry, "Continue this request in the agent");
      void this.focusTerminalForSession(entry.sessionId);
      return;
    }

    if (behavior === "allow" || behavior === "deny") this.resolvePermissionEntry(entry, behavior);
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
    if (this.state && typeof this.state.refreshDisplayState === "function") this.state.refreshDisplayState();
  }

  resolvePermissionEntry(entry, behavior, message) {
    if (entry.isCodexNotify) {
      this.removePermission(entry);
      return;
    }

    const idx = this.pendingPermissions.indexOf(entry);
    if (idx === -1) return;
    this.removePermission(entry);

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

    if (entry.isElicitation && entry.agentId !== "codex") {
      if (behavior === "allow" && entry.resolvedUpdatedInput) {
        this.sendPermissionResponse(res, {
          behavior: "allow",
          updatedInput: entry.resolvedUpdatedInput,
        });
      } else {
        this.sendPermissionResponse(res, "deny", message);
      }
      return;
    }

    const decision = { behavior: behavior === "deny" ? "deny" : "allow" };
    if (behavior === "deny" && message) decision.message = message;
    if (entry.resolvedSuggestion && entry.agentId !== "codex") decision.updatedPermissions = [entry.resolvedSuggestion];
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
    if (!this.state) {
      this.doNotDisturb = !this.doNotDisturb;
      await this.updateContextKeys();
      this.pushSnapshot();
      return this.doNotDisturb;
    }
    if (this.doNotDisturb) this.state.disableDoNotDisturb();
    else {
      this.clearPendingPermissionsForShutdown();
      this.state.enableDoNotDisturb();
    }
    this.pushSnapshot();
    await this.updateContextKeys();
    return this.doNotDisturb;
  }

  async installIntegrations() {
    if (vscode.workspace.isTrusted === false) throw new Error("Trust this workspace before installing agent hooks.");
    await this.setIntegrationsEnabled(true);
    await this.start({ force: true });
    const results = [];
    for (const id of this.selectedAgents()) {
      try {
        const result = this.runIntegrationInstaller(id, false);
        results.push({ agent: id, ok: true, ...result });
      } catch (error) {
        results.push({ agent: id, ok: false, error: error.message });
      }
    }
    const succeeded = results.filter((result) => result.ok).map((result) => result.agent);
    if (this.context.globalState) {
      const previous = this.context.globalState.get("installedAgents", []);
      await this.context.globalState.update("installedAgents", [...new Set([...previous, ...succeeded])]);
    }
    const failed = results.filter((result) => !result.ok);
    const trust = results.some((result) => result.ok && result.trustRequired);
    const names = succeeded.map((id) => id === "claude-code" ? "Claude Code" : id === "codex" ? "Codex" : id);
    const message = `${names.join(" and ") || "No agent connections"} set up.${failed.length ? ` ${failed.length} failed; open diagnostics for details.` : ""}${trust ? " Codex activity is available; review Clawd hooks in Codex for live events and approval cards." : ""}`;
    this.log(`${message}\n${JSON.stringify(results, null, 2)}`);
    return { message, details: results, ok: !failed.length, trustRequired: trust };
  }

  runIntegrationInstaller(id, uninstall) {
    const installers = {
      "claude-code": ["install", "registerHooks", "unregisterHooks"],
      codex: ["codex-install", "registerCodexHooks", "unregisterCodexHooks"],
      "gemini-cli": ["gemini-install", "registerGeminiHooks", "unregisterGeminiHooks"],
      "cursor-agent": ["cursor-install", "registerCursorHooks", "unregisterCursorHooks"],
      codebuddy: ["codebuddy-install", "registerCodeBuddyHooks", "unregisterCodeBuddyHooks"],
      "kiro-cli": ["kiro-install", "registerKiroHooks", "unregisterKiroHooks"],
      opencode: ["opencode-install", "registerOpencodePlugin", "unregisterOpencodePlugin"],
    };
    const spec = installers[id];
    if (!spec) throw new Error(`Unsupported agent: ${id}`);
    return require(path.join(VENDOR_HOOKS_DIR, spec[0]))[spec[uninstall ? 2 : 1]]({
      silent: true, port: this.server && this.server.getHookServerPort(), autoStart: false,
    });
  }

  async uninstallIntegrations() {
    const agents = this.context.globalState ? this.context.globalState.get("installedAgents", this.selectedAgents()) : this.selectedAgents();
    const results = [];
    for (const id of agents) {
      try { results.push({ agent: id, ok: true, ...this.runIntegrationInstaller(id, true) }); }
      catch (error) { results.push({ agent: id, ok: false, error: error.message }); }
    }
    if (this.context.globalState) await this.context.globalState.update("installedAgents", results.filter((r) => !r.ok).map((r) => r.agent));
    const ok = results.every((result) => result.ok);
    const message = ok ? "Clawd hooks removed from selected agents." : "Some hooks could not be removed; see Clawd diagnostics.";
    this.log(`${message}\n${JSON.stringify(results, null, 2)}`);
    return { message, details: results, ok };
  }

  async disableIntegrations() {
    await this.setIntegrationsEnabled(false);
    await this.pause();
    return { message: "Clawd integrations paused. Installed hooks fall back to the agent's own interface." };
  }

  async enableIntegrations() {
    await this.setIntegrationsEnabled(true);
    await this.restart();
    return { message: "Clawd integrations enabled. Use Install Agent Integrations if hooks are not installed." };
  }

  themes() {
    this.ensureThemeReady();
    return themeLoader.discoverThemes().map((theme) => ({ id: theme.id, label: theme.name }));
  }

  previewChoices() {
    this.ensureThemeReady();
    return Object.entries(this.activeTheme.states).flatMap(([state, files]) =>
      (Array.isArray(files) ? files : [files]).map((svg) => ({ label: state, description: svg, state, svg })));
  }

  previewAnimation(choice) {
    if (!this.previewChoices().some((item) => item.svg === choice.svg && item.state === choice.state)) return;
    this.viewPost("preview-animation", { state: choice.state, svg: choice.svg, duration: 6000 });
  }

  diagnostics() {
    const codex = require(path.join(VENDOR_HOOKS_DIR, "codex-install")).getCodexHookStatus();
    const data = {
      runtime: this.started ? "running" : this.isRuntimeEnabled() ? this.connectionState : "paused", instance: this.runtimeInstanceId,
      serverPort: this.server ? this.server.getHookServerPort() : null,
      trustedWorkspace: vscode.workspace.isTrusted !== false,
      workspaceRoots: this.workspaceRoots(), scope: this.getConfig().get("sessions.scope", "workspace"),
      selectedAgents: this.selectedAgents(), theme: this.activeTheme && this.activeTheme._id,
      sidebarVisible: !!(this.view && this.view.isVisible), sessions: this.serializeSessions(),
      pendingPermissions: this.pendingPermissions.length,
      notificationsQuiet: this.doNotDisturb,
      codex: { ...codex, hookObserved: [...this.hookSessions].some((id) => id.startsWith("codex:")), logFallbackRunning: !!this.codexMonitor },
    };
    this.log(JSON.stringify(data, null, 2));
    if (this.output && this.output.show) this.output.show(true);
    return data;
  }

  connectionStatus() {
    const codex = require(path.join(VENDOR_HOOKS_DIR, "codex-install")).getCodexHookStatus({ detectVersion: false });
    return {
      enabled: this.isRuntimeEnabled() && this.areIntegrationsEnabled(),
      running: this.started,
      selectedAgents: this.selectedAgents(),
      installedAgents: this.context.globalState ? this.context.globalState.get("installedAgents", []) : [],
      claudeObserved: this.hookAgents.has("claude-code"),
      codex: { ...codex, hookObserved: [...this.hookSessions].some((id) => id.startsWith("codex:")), logFallbackRunning: !!this.codexMonitor },
    };
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

  async focusTerminalWindow(sourcePid, cwd, _editor, pidChain) {
    const pids = new Set();
    if (Number.isFinite(sourcePid) && sourcePid > 0) pids.add(sourcePid);
    if (Array.isArray(pidChain)) {
      for (const pid of pidChain) if (Number.isFinite(pid) && pid > 0) pids.add(pid);
    }

    for (const terminal of vscode.window.terminals) {
      let pid = null;
      try { pid = await terminal.processId; } catch {}
      if (pid && pids.has(pid)) {
        terminal.show(false);
        return true;
      }
    }
    if (cwd) {
      const matches = vscode.window.terminals.filter((terminal) => {
        const value = terminal.shellIntegration && terminal.shellIntegration.cwd || terminal.creationOptions && terminal.creationOptions.cwd;
        const terminalCwd = typeof value === "string" ? value : value && value.fsPath;
        return terminalCwd && path.resolve(terminalCwd) === path.resolve(cwd);
      });
      if (matches.length === 1) { matches[0].show(false); return true; }
    }
    if (vscode.window.showInformationMessage) {
      void vscode.window.showInformationMessage("This session's terminal is outside this VS Code window. Continue in its agent window.");
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
