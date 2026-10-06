// src/server.js — HTTP server + routes (/state, /permission, /health)
// Extracted from main.js L1337-1528

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const {
  CLAWD_SERVER_HEADER,
  CLAWD_SERVER_ID,
  DEFAULT_SERVER_PORT,
  clearRuntimeConfig,
  getPortCandidates,
  readRuntimePort,
  readRuntimeEntries,
  selectRuntimeEntries,
  writeRuntimeConfig,
} = require("../hooks/server-config");

// ExitPlanMode (Plan Review) and AskUserQuestion (elicitation) happen to
// travel through /permission, but they're UX flows — not approvals the
// sub-gate is named for. Silencing them would break plan-mode and leave
// CC hanging on an elicitation.
function shouldBypassCCBubble(ctx, toolName, agentId) {
  if (toolName === "ExitPlanMode" || toolName === "AskUserQuestion") return false;
  if (typeof ctx.isAgentPermissionsEnabled !== "function") return false;
  return !ctx.isAgentPermissionsEnabled(agentId);
}

function shouldBypassOpencodeBubble(ctx) {
  if (typeof ctx.isAgentPermissionsEnabled !== "function") return false;
  return !ctx.isAgentPermissionsEnabled("opencode");
}

function permissionMatchesEvent(perm, data, sid, agentId) {
  if (perm.sessionId !== sid || (perm.agentId && perm.agentId !== agentId)) return false;
  if (data.turn_id && perm.turnId && data.turn_id !== perm.turnId) return false;
  if (data.child_agent_id && perm.childAgentId && data.child_agent_id !== perm.childAgentId) return false;
  if (data.event === "SessionEnd") return true;
  if (data.event === "SubagentStop") return !!data.child_agent_id && data.child_agent_id === perm.childAgentId;
  if (data.event === "Stop" || data.event === "StopFailure") return !perm.childAgentId || !!data.child_agent_id;
  const toolCallId = data.tool_call_id || data.tool_use_id;
  if (toolCallId) return toolCallId === perm.toolCallId;
  if (data.request_id) return data.request_id === perm.requestId || data.request_id === perm.opencodeRequestId;
  return !perm.toolCallId && !perm.requestId && !!data.tool_name && data.tool_name === perm.toolName;
}

// Truncate large string values in objects (recursive) — bubble only needs a preview
const PREVIEW_MAX = 500;
const FILE_INPUT_PREVIEW_MAX = 12000;
const PLAN_INPUT_PREVIEW_MAX = 24000;
const MAX_PERMISSION_SUGGESTIONS = 20;
const MAX_ELICITATION_QUESTIONS = 5;
const MAX_ELICITATION_OPTIONS = 5;
const MAX_ELICITATION_HEADER = 48;
const MAX_ELICITATION_PROMPT = 240;
const MAX_ELICITATION_OPTION_LABEL = 80;
const MAX_ELICITATION_OPTION_DESCRIPTION = 160;

function truncateDeep(obj, depth) {
  if ((depth || 0) > 10) return obj;
  if (Array.isArray(obj)) return obj.map(v => truncateDeep(v, (depth || 0) + 1));
  if (obj && typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = truncateDeep(v, (depth || 0) + 1);
    return out;
  }
  return typeof obj === "string" && obj.length > PREVIEW_MAX
    ? obj.slice(0, PREVIEW_MAX) + "\u2026" : obj;
}

function truncateString(value, max) {
  if (typeof value !== "string") return value;
  return value.length > max ? `${value.slice(0, Math.max(0, max - 18))}\n... [truncated]` : value;
}

function normalizePermissionToolInput(rawInput, toolName) {
  const input = truncateDeep(rawInput);
  if (!input || typeof input !== "object" || !rawInput || typeof rawInput !== "object") return input;

  if (toolName === "Write") {
    input.content = truncateString(rawInput.content, FILE_INPUT_PREVIEW_MAX);
  } else if (toolName === "Edit") {
    input.old_string = truncateString(rawInput.old_string, FILE_INPUT_PREVIEW_MAX);
    input.new_string = truncateString(rawInput.new_string, FILE_INPUT_PREVIEW_MAX);
    if (Array.isArray(rawInput.edits)) {
      input.edits = rawInput.edits.slice(0, 20).map((edit) => {
        if (!edit || typeof edit !== "object") return edit;
        return {
          ...edit,
          old_string: truncateString(edit.old_string, FILE_INPUT_PREVIEW_MAX),
          new_string: truncateString(edit.new_string, FILE_INPUT_PREVIEW_MAX),
        };
      });
    }
  } else if (toolName === "NotebookEdit") {
    input.new_source = truncateString(rawInput.new_source, FILE_INPUT_PREVIEW_MAX);
  } else if (toolName === "ExitPlanMode") {
    input.plan = truncateString(rawInput.plan, PLAN_INPUT_PREVIEW_MAX);
  }

  return input;
}

function clampPreviewText(value, max) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.length > max ? `${trimmed.slice(0, Math.max(0, max - 1))}\u2026` : trimmed;
}

function normalizePermissionSuggestions(rawSuggestions) {
  const suggestions = Array.isArray(rawSuggestions)
    ? rawSuggestions.filter((entry) => entry && typeof entry === "object")
    : [];
  const addRulesItems = suggestions.filter((entry) => entry.type === "addRules");
  const nonAddRules = suggestions.filter((entry) => entry.type !== "addRules");
  const mergedAddRules = addRulesItems.length > 1
    ? {
        type: "addRules",
        destination: addRulesItems[0].destination || "localSettings",
        behavior: addRulesItems[0].behavior || "allow",
        rules: addRulesItems.flatMap((entry) => (
          Array.isArray(entry.rules) ? entry.rules : [{ toolName: entry.toolName, ruleContent: entry.ruleContent }]
        )),
      }
    : addRulesItems[0] || null;

  if (!mergedAddRules) return nonAddRules.slice(0, MAX_PERMISSION_SUGGESTIONS);
  if (nonAddRules.length + 1 <= MAX_PERMISSION_SUGGESTIONS) return [...nonAddRules, mergedAddRules];
  return [
    ...nonAddRules.slice(0, MAX_PERMISSION_SUGGESTIONS - 1),
    mergedAddRules,
  ];
}

function normalizeElicitationToolInput(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return toolInput;
  if (!Array.isArray(toolInput.questions)) return toolInput;

  const questions = toolInput.questions
    .slice(0, MAX_ELICITATION_QUESTIONS)
    .map((question) => {
      if (!question || typeof question !== "object") return null;
      const options = Array.isArray(question.options)
        ? question.options
          .slice(0, MAX_ELICITATION_OPTIONS)
          .map((option) => {
            if (!option || typeof option !== "object") return null;
            return {
              ...option,
              label: clampPreviewText(option.label, MAX_ELICITATION_OPTION_LABEL),
              description: clampPreviewText(option.description, MAX_ELICITATION_OPTION_DESCRIPTION),
            };
          })
          .filter(Boolean)
        : [];

      const normalized = {
        ...question,
        header: clampPreviewText(question.header, MAX_ELICITATION_HEADER),
        question: clampPreviewText(question.question, MAX_ELICITATION_PROMPT),
        options,
      };
      if (!normalized.question) return null;
      return normalized;
    })
    .filter(Boolean);

  return {
    ...toolInput,
    questions,
  };
}

module.exports = function initServer(ctx) {

const fsApi = ctx.fs || fs;
const pathApi = ctx.path || path;
const osApi = ctx.os || os;
const createHttpServer = ctx.createHttpServer || http.createServer.bind(http);
const setImmediateFn = ctx.setImmediate || setImmediate;
const setTimeoutFn = ctx.setTimeout || setTimeout;
const clearTimeoutFn = ctx.clearTimeout || clearTimeout;
const setIntervalFn = ctx.setInterval || setInterval;
const clearIntervalFn = ctx.clearInterval || clearInterval;
const nowFn = typeof ctx.now === "function" ? ctx.now : Date.now;
const clearRuntimeConfigFn = ctx.clearRuntimeConfig || clearRuntimeConfig;
const getPortCandidatesFn = ctx.getPortCandidates || getPortCandidates;
const readRuntimePortFn = ctx.readRuntimePort || readRuntimePort;
const writeRuntimeConfigFn = ctx.writeRuntimeConfig || writeRuntimeConfig;
const settingsWatchDebounceMs = Number.isFinite(ctx.settingsWatchDebounceMs) ? ctx.settingsWatchDebounceMs : 1000;
const settingsWatchRateLimitMs = Number.isFinite(ctx.settingsWatchRateLimitMs) ? ctx.settingsWatchRateLimitMs : 5000;

let httpServer = null;
let activeServerPort = null;
let settingsWatcher = null;
let settingsWatchDebounceTimer = null;
let settingsWatchLastSyncTime = 0;
let startPromise = null;
let rejectStart = null;
let stopped = false;
let registryHeartbeat = null;
const instanceId = ctx.runtimeInstanceId || crypto.randomUUID();
const registryOptions = { ...ctx.runtimeRegistryOptions, instanceId, workspaceRoots: ctx.workspaceRoots || [] };

function getRegistrationOptions() {
  return { ...registryOptions, workspaceRoots: ctx.workspaceRoots || [],
    visible: typeof ctx.isPermissionUIAvailable === "function" && ctx.isPermissionUIAvailable() === true };
}

function refreshRuntimeRegistration() {
  if (stopped || !activeServerPort) return false;
  return writeRuntimeConfigFn(activeServerPort, getRegistrationOptions());
}

function sendNativeFallback(res) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(200, { "Content-Type": "application/json", [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID });
  res.end("{}");
}

function deferPermissionEntry(entry, reason) {
  if (typeof ctx.deferPermissionEntry === "function") return ctx.deferPermissionEntry(entry, reason);
  if (entry.res && entry.abortHandler) entry.res.removeListener("close", entry.abortHandler);
  if (entry.res) sendNativeFallback(entry.res);
  // Legacy desktop cleanup still closes its bubble. A finished response will
  // not receive the old deny reply, and an opencode request stays native.
  if (!entry.isOpencode && typeof ctx.resolvePermissionEntry === "function") ctx.resolvePermissionEntry(entry, "deny", reason);
  else {
    const index = ctx.pendingPermissions.indexOf(entry);
    if (index >= 0) ctx.pendingPermissions.splice(index, 1);
    if (entry.bubble && typeof entry.bubble.close === "function") entry.bubble.close();
  }
}

function ownsEvent(data) {
  if (data.instance_id && data.instance_id !== instanceId) return false;
  const cwd = data.cwd || (ctx.sessions && ctx.sessions.get(data.session_id)?.cwd);
  if (!cwd && !data.instance_id) return true; // legacy hooks lack routing fields
  const entries = readRuntimeEntries(registryOptions);
  if (!entries.length) return true;
  const owner = selectRuntimeEntries({ ...registryOptions, instanceId: data.instance_id, cwd }, entries)[0];
  return !!owner && owner.instanceId === instanceId;
}


function shouldManageClaudeHooks() {
  return ctx.manageClaudeHooksAutomatically !== false;
}

function getClaudeSettingsDir() {
  return typeof ctx.claudeSettingsDir === "string"
    ? ctx.claudeSettingsDir
    : pathApi.join(osApi.homedir(), ".claude");
}

function getClaudeSettingsPath() {
  return typeof ctx.claudeSettingsPath === "string"
    ? ctx.claudeSettingsPath
    : pathApi.join(getClaudeSettingsDir(), SETTINGS_FILENAME);
}

function getHookServerPort() {
  return activeServerPort || readRuntimePortFn() || DEFAULT_SERVER_PORT;
}

function syncClawdHooks() {
  try {
    if (typeof ctx.syncClawdHooksImpl === "function") {
      return ctx.syncClawdHooksImpl({
        autoStart: ctx.autoStartWithClaude,
        port: getHookServerPort(),
      });
    }
    const { registerHooks } = require("../hooks/install.js");
    const { added, updated, removed } = registerHooks({
      silent: true,
      autoStart: ctx.autoStartWithClaude,
      port: getHookServerPort(),
    });
    if (added > 0 || updated > 0 || removed > 0) {
      console.log(`Clawd: synced hooks (added ${added}, updated ${updated}, removed ${removed})`);
    }
  } catch (err) {
    console.warn("Clawd: failed to sync hooks:", err.message);
  }
}

function syncGeminiHooks() {
  try {
    if (typeof ctx.syncGeminiHooksImpl === "function") return ctx.syncGeminiHooksImpl();
    const { registerGeminiHooks } = require("../hooks/gemini-install.js");
    const { added, updated } = registerGeminiHooks({ silent: true });
    if (added > 0 || updated > 0) {
      console.log(`Clawd: synced Gemini hooks (added ${added}, updated ${updated})`);
    }
  } catch (err) {
    console.warn("Clawd: failed to sync Gemini hooks:", err.message);
  }
}

function syncCodeBuddyHooks() {
  try {
    if (typeof ctx.syncCodeBuddyHooksImpl === "function") return ctx.syncCodeBuddyHooksImpl();
    const { registerCodeBuddyHooks } = require("../hooks/codebuddy-install.js");
    const { added, updated } = registerCodeBuddyHooks({ silent: true });
    if (added > 0 || updated > 0) {
      console.log(`Clawd: synced CodeBuddy hooks (added ${added}, updated ${updated})`);
    }
  } catch (err) {
    console.warn("Clawd: failed to sync CodeBuddy hooks:", err.message);
  }
}

function syncKiroHooks() {
  try {
    if (typeof ctx.syncKiroHooksImpl === "function") return ctx.syncKiroHooksImpl();
    const { registerKiroHooks } = require("../hooks/kiro-install.js");
    const { added, updated } = registerKiroHooks({ silent: true });
    if (added > 0 || updated > 0) {
      console.log(`Clawd: synced Kiro hooks (added ${added}, updated ${updated})`);
    }
  } catch (err) {
    console.warn("Clawd: failed to sync Kiro hooks:", err.message);
  }
}

function syncCursorHooks() {
  try {
    if (typeof ctx.syncCursorHooksImpl === "function") return ctx.syncCursorHooksImpl();
    const { registerCursorHooks } = require("../hooks/cursor-install.js");
    const { added, updated } = registerCursorHooks({ silent: true });
    if (added > 0 || updated > 0) {
      console.log(`Clawd: synced Cursor hooks (added ${added}, updated ${updated})`);
    }
  } catch (err) {
    console.warn("Clawd: failed to sync Cursor hooks:", err.message);
  }
}

function syncOpencodePlugin() {
  try {
    if (typeof ctx.syncOpencodePluginImpl === "function") return ctx.syncOpencodePluginImpl();
    const { registerOpencodePlugin } = require("../hooks/opencode-install.js");
    const { added, created } = registerOpencodePlugin({ silent: true });
    if (added || created) {
      console.log(`Clawd: synced opencode plugin (added=${added}, created=${created})`);
    }
  } catch (err) {
    console.warn("Clawd: failed to sync opencode plugin:", err.message);
  }
}

function sendStateHealthResponse(res) {
  const registration = getRegistrationOptions();
  const body = JSON.stringify({ ok: true, app: CLAWD_SERVER_ID, port: getHookServerPort(), instanceId, workspaceRoots: registration.workspaceRoots, visible: registration.visible });
  res.writeHead(200, {
    "Content-Type": "application/json",
    [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID,
  });
  res.end(body);
}

const SETTINGS_FILENAME = "settings.json";
// Watch ~/.claude/ directory for settings.json overwrites (e.g. CC-Switch)
// that wipe our hooks or leave stale hook paths / PermissionRequest ports.
// Re-run the idempotent sync whenever settings.json changes so extension
// updates, runtime port drift, and external settings rewrites all converge.
// Watch the directory (not the file) because atomic rename replaces the inode
// and fs.watch on the old file silently stops firing on Windows.
function stopClaudeSettingsWatcher() {
  if (settingsWatchDebounceTimer) {
    clearTimeoutFn(settingsWatchDebounceTimer);
    settingsWatchDebounceTimer = null;
  }
  settingsWatchLastSyncTime = 0;
  if (!settingsWatcher) return false;
  try {
    settingsWatcher.close();
  } catch {}
  settingsWatcher = null;
  return true;
}

function startClaudeSettingsWatcher() {
  if (settingsWatcher) return false;
  const settingsDir = getClaudeSettingsDir();
  try {
    settingsWatcher = fsApi.watch(settingsDir, (_event, filename) => {
      if (filename && filename !== SETTINGS_FILENAME) return;
      if (settingsWatchDebounceTimer) return;
      settingsWatchDebounceTimer = setTimeoutFn(() => {
        settingsWatchDebounceTimer = null;
        // Rate-limit: don't re-sync within 5s to avoid write wars with CC-Switch
        if (nowFn() - settingsWatchLastSyncTime < settingsWatchRateLimitMs) return;
        settingsWatchLastSyncTime = nowFn();
        syncClawdHooks();
      }, settingsWatchDebounceMs);
    });
    if (settingsWatcher && typeof settingsWatcher.on === "function") settingsWatcher.on("error", (err) => {
      console.warn("Clawd: settings watcher error:", err.message);
    });
    return true;
  } catch (err) {
    console.warn("Clawd: failed to watch settings directory:", err.message);
    settingsWatcher = null;
    return false;
  }
}

// /state POST body size cap. Raised from 1024 to 4096 to give new fields
// (session_title) headroom on top of cwd / pid_chain / host / etc. Still a
// local-only 127.0.0.1 endpoint — not an Internet DoS concern.
const MAX_STATE_BODY_BYTES = 4096;

function startHttpServer() {
  if (startPromise) return startPromise;
  stopped = false;
  let resolveStart;
  startPromise = new Promise((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
  try {
  httpServer = createHttpServer((req, res) => {
    if (req.method === "GET" && (req.url === "/state" || req.url === "/health")) {
      sendStateHealthResponse(res);
    } else if (req.method === "POST" && req.url === "/state") {
      let body = "";
      let bodySize = 0;
      let tooLarge = false;
      req.on("data", (chunk) => {
        if (tooLarge) return;
        bodySize += chunk.length;
        if (bodySize > MAX_STATE_BODY_BYTES) { tooLarge = true; return; }
        body += chunk;
      });
      req.on("end", () => {
        if (tooLarge) {
          res.writeHead(413);
          res.end("state payload too large");
          return;
        }
        try {
          const data = JSON.parse(body);
          if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("expected state object");
          if (!ownsEvent(data)) {
            res.writeHead(409, { [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID });
            res.end("event belongs to another window");
            return;
          }
          const { state, svg, session_id, event } = data;
          let display_svg;
          if (data.display_svg === null) display_svg = null;
          else if (typeof data.display_svg === "string") display_svg = path.basename(data.display_svg);
          else display_svg = undefined;
          const source_pid = Number.isFinite(data.source_pid) && data.source_pid > 0 ? Math.floor(data.source_pid) : null;
          const cwd = typeof data.cwd === "string" ? data.cwd : "";
          const editor = (data.editor === "code" || data.editor === "cursor") ? data.editor : null;
          const pidChain = Array.isArray(data.pid_chain) ? data.pid_chain.filter(n => Number.isFinite(n) && n > 0) : null;
          const rawAgentPid = data.agent_pid ?? data.claude_pid ?? data.cursor_pid;
          const agentPid = Number.isFinite(rawAgentPid) && rawAgentPid > 0 ? Math.floor(rawAgentPid) : null;
          const agentId = typeof data.agent_id === "string" ? data.agent_id : "claude-code";
          const host = typeof data.host === "string" ? data.host : null;
          const headless = data.headless === true;
          // Session title (Claude Code /rename or Codex turn_context.summary).
          // Non-string / empty values are silently dropped — matches the
          // "ignore + fall back" pattern used by cwd / agent_id above.
          const rawTitle = typeof data.session_title === "string" ? data.session_title.trim() : "";
          const sessionTitle = rawTitle || null;
          // Agent gate: user disabled this agent in the settings panel. Drop
          // with 204 so hook scripts get a quick no-op response instead of
          // hanging on our HTTP connection. Still surfaces as a success code
          // so hook exit behavior is unchanged.
          if (typeof ctx.isAgentEnabled === "function" && !ctx.isAgentEnabled(agentId)) {
            res.writeHead(204, { [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID });
            res.end();
            return;
          }
          if (ctx.STATE_SVGS[state]) {
            const sid = session_id || "default";
            if (state.startsWith("mini-") && !svg) {
              res.writeHead(400);
              res.end("mini states require svg override");
              return;
            }
            if (event === "PostToolUse" || event === "PostToolUseFailure" || event === "Stop" || event === "StopFailure" || event === "SessionEnd" || event === "SubagentStop") {
              for (const perm of [...ctx.pendingPermissions]) {
                if (permissionMatchesEvent(perm, data, sid, agentId)) {
                  deferPermissionEntry(perm, "Request completed in native client");
                }
              }
            }
            if (svg) {
              const safeSvg = path.basename(svg);
              ctx.setState(state, safeSvg);
            } else {
              ctx.updateSession(sid, state, event, {
                sourcePid: source_pid,
                cwd,
                editor,
                pidChain,
                agentPid,
                agentId,
                host,
                headless,
                displayHint: display_svg,
                sessionTitle,
                childAgentId: data.child_agent_id,
                turnId: data.turn_id,
                toolCallId: data.tool_call_id || data.tool_use_id,
                requestId: data.request_id,
                source: data.source || "hook",
                metaOnly: data.meta_only === true,
                model: data.model,
                agentType: data.agent_type,
                taskId: data.task_id,
                teammateName: data.teammate_name,
                teamName: data.team_name,
              });
            }
            res.writeHead(200, { [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID });
            res.end("ok");
          } else {
            res.writeHead(400);
            res.end("unknown state");
          }
        } catch {
          res.writeHead(400);
          res.end("bad json");
        }
      });
    } else if (req.method === "POST" && req.url === "/permission") {
      ctx.permLog(`/permission hit | DND=${ctx.doNotDisturb} pending=${ctx.pendingPermissions.length}`);
      let body = "";
      let bodySize = 0;
      let tooLarge = false;
      req.on("data", (chunk) => {
        if (tooLarge) return;
        bodySize += chunk.length;
        if (bodySize > 524288) { tooLarge = true; return; }
        body += chunk;
      });
      req.on("end", () => {
        if (tooLarge) {
          ctx.permLog("SKIPPED: permission payload too large");
          sendNativeFallback(res);
          return;
        }

        let data;
        try {
          data = JSON.parse(body);
          if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("expected permission object");
        } catch {
          res.writeHead(400);
          res.end("bad json");
          return;
        }

        try {
          if (!ownsEvent(data)) {
            res.writeHead(409, { [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID });
            res.end("event belongs to another window");
            return;
          }
          if (typeof ctx.isPermissionUIAvailable === "function" && !ctx.isPermissionUIAvailable()) {
            sendNativeFallback(res);
            return;
          }
          // ── opencode branch ──
          // opencode plugin (agents/opencode.js) posts fire-and-forget. We
          // always 200 ACK immediately; the user's decision routes through
          // a separate REST call to opencode's own server (see permission.js
          // replyOpencodePermission). This means no res is retained on the
          // permEntry, no res.on("close") abort handler, and hideBubbles
          // degrades to "TUI only" (plugin doesn't wait on us).
          //
          // DND handling is branch-specific: opencode cannot observe the
          // HTTP response (fire-and-forget), so a generic HTTP deny would
          // leave the TUI hanging until timeout. Instead we route DND
          // through the same reverse bridge the plugin uses for replies.
          if (data.agent_id === "opencode") {
            res.writeHead(200, { [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID });
            res.end("ok");

            // Agent gate: same silent-drop semantics as DND — plugin is
            // fire-and-forget, so 200 ACK satisfies it; skipping the bridge
            // reply lets the opencode TUI fall back to its built-in prompt.
            if (typeof ctx.isAgentEnabled === "function" && !ctx.isAgentEnabled("opencode")) {
              ctx.permLog("opencode disabled → silent drop, TUI fallback");
              return;
            }

            const toolName = typeof data.tool_name === "string" && data.tool_name ? data.tool_name : "unknown";
            const rawInput = data.tool_input && typeof data.tool_input === "object" ? data.tool_input : {};
            const toolInput = truncateDeep(rawInput);
            const sessionId = typeof data.session_id === "string" ? data.session_id : "default";
            const requestId = typeof data.request_id === "string" ? data.request_id : null;
            const bridgeUrl = typeof data.bridge_url === "string" ? data.bridge_url : "";
            const bridgeToken = typeof data.bridge_token === "string" ? data.bridge_token : "";
            const alwaysCandidates = Array.isArray(data.always) ? data.always : [];
            const patterns = Array.isArray(data.patterns) ? data.patterns : [];

            ctx.permLog(`opencode perm: tool=${toolName} session=${sessionId} req=${requestId} bridge=${bridgeUrl} always=${alwaysCandidates.length}`);

            // bridge_url/bridge_token are required — this is the reverse
            // channel Clawd uses to send the decision back to the plugin,
            // which then calls opencode's in-process Hono route. Without it
            // we have no way to resolve the pending permission.
            if (!requestId || !bridgeUrl || !bridgeToken) {
              const missing = !requestId ? "request_id" : (!bridgeUrl ? "bridge_url" : "bridge_token");
              ctx.permLog(`SKIPPED opencode perm: missing ${missing}`);
              return;
            }

            // DND: drop silently — do NOT reply via bridge. opencode TUI
            // will fall back to its built-in permission prompt so the user
            // can confirm in the terminal themselves. Spike 2026-04-06
            // confirmed this works: TUI shows Allow/Reject without hanging.
            if (ctx.doNotDisturb) {
              ctx.permLog(`opencode DND → silent drop, TUI fallback — request=${requestId}`);
              return;
            }

            // No HTTP connection to hold open — only degradation is to
            // not render a bubble and let the TUI prompt handle it.
            const opencodeSubGateBypass = shouldBypassOpencodeBubble(ctx);
            if (ctx.hideBubbles || opencodeSubGateBypass) {
              ctx.permLog(`opencode bubble hidden: tool=${toolName} — TUI fallback (hideBubbles=${ctx.hideBubbles} subGateBypass=${opencodeSubGateBypass})`);
              return;
            }

            const permEntry = {
              res: null,
              abortHandler: null,
              suggestions: [],
              sessionId,
              bubble: null,
              hideTimer: null,
              toolName,
              toolInput,
              resolvedSuggestion: null,
              createdAt: Date.now(),
              agentId: "opencode",
              isOpencode: true,
              opencodeRequestId: requestId,
              opencodeBridgeUrl: bridgeUrl,
              opencodeBridgeToken: bridgeToken,
              opencodeAlwaysCandidates: alwaysCandidates,
              opencodePatterns: patterns,
              toolCallId: data.tool_call_id || data.tool_use_id || null,
              requestId,
              childAgentId: data.child_agent_id || null,
              turnId: data.turn_id || null,
            };
            ctx.pendingPermissions.push(permEntry);
            // Play notification animation on the pet body so the bubble doesn't
            // appear "silently". Mirrors the Codex path (main.js showCodexNotifyBubble)
            // and the Elicitation branch below. state.js:581 has a special
            // PermissionRequest branch that setStates notification without
            // mutating session state — so working/thinking is preserved for resolve.
            ctx.updateSession(sessionId, "notification", "PermissionRequest", { agentId: "opencode" });
            ctx.permLog(`opencode showing bubble: tool=${toolName} session=${sessionId}`);
            try {
              ctx.showPermissionBubble(permEntry);
            } catch (bubbleErr) {
              // If bubble creation fails (BrowserWindow error, bad html,
              // window-positioning crash, etc), we have already 200-ACKed
              // the plugin and it is waiting for a bridge reply. Without
              // this rescue the permEntry would linger in pendingPermissions
              // until the opencode TUI hits its own timeout (minutes).
              // Pop the ghost entry and send an immediate reject so the
              // TUI unblocks and the user can re-answer in the terminal.
              ctx.permLog(`opencode bubble failed: ${bubbleErr && bubbleErr.message} — native fallback`);
              const popIdx = ctx.pendingPermissions.indexOf(permEntry);
              if (popIdx !== -1) ctx.pendingPermissions.splice(popIdx, 1);
            }
            return;
          }

          // ── Claude Code branch ──
          // DND: destroy connection — do NOT send deny on the user's behalf.
          // CC falls back to its built-in chat permission prompt so the user
          // decides themselves. Spike 2026-04-07 confirmed: CC shows Allow/
          // Deny in chat, no hang, no timeout. Same pattern as opencode
          // silent drop (95cbfc7).
          if (ctx.doNotDisturb) {
            ctx.permLog("CC DND → destroy connection, CC chat fallback");
            sendNativeFallback(res);
            return;
          }

          // Agent gate: mirror DND — destroy the connection so CC (or
          // codebuddy, since they share this path) falls back to its built-in
          // chat prompt. Any non-opencode agent_id passing through here
          // gets the same treatment.
          const ccAgentId = typeof data.agent_id === "string" && data.agent_id ? data.agent_id : "claude-code";
          if (typeof ctx.isAgentEnabled === "function" && !ctx.isAgentEnabled(ccAgentId)) {
            ctx.permLog(`${ccAgentId} disabled → destroy connection, chat fallback`);
            sendNativeFallback(res);
            return;
          }

          const toolName = typeof data.tool_name === "string" ? data.tool_name : "Unknown";
          const rawInput = data.tool_input && typeof data.tool_input === "object" ? data.tool_input : {};
          const toolInput = normalizePermissionToolInput(rawInput, toolName);
          const sessionId = data.session_id || "default";
          // Tag the permEntry with the source agent. Clawd's HTTP permission
          // path is shared between Claude Code and codebuddy (both set
          // capabilities.permissionApproval=true and POST here). Stamping lets
          // dismissPermissionsByAgent() clean up the right ones when the user
          // disables an agent mid-flight.
          const permAgentId = typeof data.agent_id === "string" && data.agent_id ? data.agent_id : "claude-code";
          const rawSuggestions = Array.isArray(data.permission_suggestions) ? data.permission_suggestions : [];
          const suggestions = normalizePermissionSuggestions(rawSuggestions);
          const eventIdentity = { toolCallId: data.tool_call_id || data.tool_use_id || null,
            requestId: data.request_id || null, childAgentId: data.child_agent_id || null, turnId: data.turn_id || null,
            source: data.source || "hook", cwd: data.cwd || "", sourcePid: data.source_pid || null, agentPid: data.agent_pid || null,
            pidChain: Array.isArray(data.pid_chain) ? data.pid_chain.filter(pid => Number.isInteger(pid) && pid > 0) : null,
            editor: data.editor === "code" || data.editor === "cursor" ? data.editor : null };

          const existingSession = ctx.sessions.get(sessionId);
          if (existingSession && existingSession.headless) {
            ctx.permLog(`SKIPPED: headless session=${sessionId}`);
            sendNativeFallback(res);
            return;
          }

          if (ctx.PASSTHROUGH_TOOLS.has(toolName)) {
            ctx.permLog(`PASSTHROUGH: tool=${toolName} session=${sessionId}`);
            sendNativeFallback(res);
            return;
          }

          if (shouldBypassCCBubble(ctx, toolName, permAgentId)) {
            ctx.permLog(`${permAgentId} bubbles disabled → destroy connection, chat fallback (tool=${toolName})`);
            sendNativeFallback(res);
            return;
          }
          if (ctx.hideBubbles) {
            sendNativeFallback(res);
            return;
          }

          // Elicitation (AskUserQuestion) — show notification bubble, not permission bubble.
          // User clicks "Go to Terminal" → deny → Claude Code falls back to terminal.
          if (toolName === "AskUserQuestion") {
            const elicitationInput = normalizeElicitationToolInput(toolInput);
            ctx.permLog(`ELICITATION: tool=${toolName} session=${sessionId}`);
            ctx.updateSession(sessionId, "notification", "Elicitation", { agentId: permAgentId, ...eventIdentity });

            const permEntry = { res, abortHandler: null, suggestions: [], sessionId, bubble: null, hideTimer: null, toolName, toolInput: elicitationInput, resolvedSuggestion: null, createdAt: Date.now(), isElicitation: true, agentId: permAgentId, ...eventIdentity };
            const abortHandler = () => {
              if (res.writableFinished) return;
              ctx.permLog("abortHandler fired (elicitation)");
              deferPermissionEntry(permEntry, "Client disconnected");
            };
            permEntry.abortHandler = abortHandler;
            res.on("close", abortHandler);
            ctx.pendingPermissions.push(permEntry);
            if (!ctx.hideBubbles) ctx.showPermissionBubble(permEntry);
            return;
          }

          const permEntry = { res, abortHandler: null, suggestions, sessionId, bubble: null, hideTimer: null, toolName, toolInput, resolvedSuggestion: null, createdAt: Date.now(), agentId: permAgentId, ...eventIdentity };
          const abortHandler = () => {
            if (res.writableFinished) return;
            ctx.permLog("abortHandler fired");
            deferPermissionEntry(permEntry, "Client disconnected");
          };
          permEntry.abortHandler = abortHandler;
          res.on("close", abortHandler);

          ctx.pendingPermissions.push(permEntry);

          // Play notification animation on the pet body so the bubble doesn't
          // appear "silently". Mirrors the Codex path (main.js showCodexNotifyBubble)
          // and the Elicitation branch above. state.js:581 has a special
          // PermissionRequest branch that setStates notification without
          // mutating session state — so working/thinking is preserved for resolve.
          ctx.updateSession(sessionId, "notification", "PermissionRequest", { agentId: permAgentId, ...eventIdentity });

          if (ctx.hideBubbles) {
            ctx.permLog(`bubble hidden: tool=${toolName} session=${sessionId} — terminal only`);
          } else {
            ctx.permLog(`showing bubble: tool=${toolName} session=${sessionId} suggestions=${suggestions.length} stack=${ctx.pendingPermissions.length}`);
            ctx.showPermissionBubble(permEntry);
          }
        } catch (err) {
          ctx.permLog(`/permission handler error: ${err && err.message}`);
          // Response may already be sent (opencode branch 200-ACKs before
          // processing), so guard against a second writeHead.
          if (!res.headersSent) {
            res.writeHead(500);
            res.end("internal error");
          }
        }
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  } catch (err) {
    rejectStart(err); rejectStart = null;
    return startPromise;
  }

  const listenPorts = getPortCandidatesFn();
  let listenIndex = 0;
  httpServer.on("error", (err) => {
    if (stopped) return;
    if (!activeServerPort && err.code === "EADDRINUSE" && listenIndex < listenPorts.length - 1) {
      listenIndex++;
      httpServer.listen(listenPorts[listenIndex], "127.0.0.1");
      return;
    }
    if (!activeServerPort && err.code === "EADDRINUSE") {
      const firstPort = listenPorts[0];
      const lastPort = listenPorts[listenPorts.length - 1];
      console.warn(`Ports ${firstPort}-${lastPort} are occupied — state sync and permission bubbles are disabled`);
    } else {
      console.error("HTTP server error:", err.message);
    }
    if (!activeServerPort && rejectStart) { rejectStart(err); rejectStart = null; }
    if (typeof ctx.onServerError === "function") ctx.onServerError(err);
  });

  httpServer.on("listening", () => {
    if (stopped) { httpServer.close(); return; }
    activeServerPort = listenPorts[listenIndex] || httpServer.address().port;
    refreshRuntimeRegistration();
    registryHeartbeat = setIntervalFn(refreshRuntimeRegistration, 30000);
    if (registryHeartbeat && typeof registryHeartbeat.unref === "function") registryHeartbeat.unref();
    resolveStart(activeServerPort);
    rejectStart = null;
    console.log(`Clawd state server listening on 127.0.0.1:${activeServerPort}`);
    // Defer hook/plugin registration off the startup path. Each sync call
    // reads+parses+writes a config JSON (50-150ms cumulative on slow disks),
    // and all five operate on independent files for independent agents, so
    // none of them need to block the HTTP server from accepting traffic.
    setImmediateFn(() => {
      if (stopped) return;
      if (shouldManageClaudeHooks()) {
        syncClawdHooks();
        startClaudeSettingsWatcher();
      }
      syncGeminiHooks();
      syncCursorHooks();
      syncCodeBuddyHooks();
      syncKiroHooks();
      syncOpencodePlugin();
    });
  });

  try {
    if (!listenPorts.length) throw new Error("No Clawd server ports configured");
    httpServer.listen(listenPorts[listenIndex], "127.0.0.1");
  } catch (err) { rejectStart(err); rejectStart = null; }
  return startPromise;
}

function cleanup() {
  stopped = true;
  if (rejectStart) { rejectStart(new Error("Clawd server stopped before listening")); rejectStart = null; }
  if (registryHeartbeat) { clearIntervalFn(registryHeartbeat); registryHeartbeat = null; }
  clearRuntimeConfigFn(registryOptions);
  stopClaudeSettingsWatcher();
  if (httpServer) httpServer.close();
  activeServerPort = null;
}

return {
  startHttpServer,
  getHookServerPort,
  refreshRuntimeRegistration,
  getInstanceId: () => instanceId,
  syncClawdHooks,
  syncGeminiHooks,
  syncCursorHooks,
  syncCodeBuddyHooks,
  syncKiroHooks,
  syncOpencodePlugin,
  startClaudeSettingsWatcher,
  stopClaudeSettingsWatcher,
  cleanup,
};

};

module.exports.__test = {
  shouldBypassCCBubble,
  shouldBypassOpencodeBubble,
  normalizePermissionSuggestions,
  normalizeElicitationToolInput,
  permissionMatchesEvent,
};
