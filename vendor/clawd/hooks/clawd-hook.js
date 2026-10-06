#!/usr/bin/env node
// Clawd Desktop Pet — Claude Code Hook Script
// Usage: node clawd-hook.js <event_name>
// Reads stdin JSON from Claude Code for session_id

const fs = require("fs");
const { postStateToRunningServer, readHostPrefix } = require("./server-config");
const { createPidResolver, readStdinJson, getPlatformConfig } = require("./shared-process");
const { requestPermission } = require("./permission-client");

const TRANSCRIPT_TAIL_BYTES = 262144; // 256 KB
const SESSION_TITLE_CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]+/g;
const SESSION_TITLE_MAX = 80;

function normalizeTitle(value) {
  if (typeof value !== "string") return null;
  const collapsed = value
    .replace(SESSION_TITLE_CONTROL_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!collapsed) return null;
  return collapsed.length > SESSION_TITLE_MAX
    ? `${collapsed.slice(0, SESSION_TITLE_MAX - 1)}\u2026`
    : collapsed;
}

// Read the tail of a Claude Code transcript JSONL and return the most recent
// user-set session title (custom-title / agent-name events). Returns null if
// the file is missing/unreadable or no title events are found.
function extractSessionTitleFromTranscript(transcriptPath) {
  if (typeof transcriptPath !== "string" || !transcriptPath) return null;

  let data;
  let truncated = false;
  let fd = null;
  try {
    const stat = fs.statSync(transcriptPath);
    fd = fs.openSync(transcriptPath, "r");
    const readLen = Math.min(stat.size, TRANSCRIPT_TAIL_BYTES);
    truncated = stat.size > readLen;
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, Math.max(0, stat.size - readLen));
    data = buf.toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }

  const lines = data.split("\n");
  // If we read a tail of a larger file, the first line is likely a truncated
  // JSON fragment — drop it so JSON.parse doesn't fail noisily on it.
  if (truncated && lines.length > 1) lines.shift();

  let latest = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || typeof obj !== "object") continue;
    const type = typeof obj.type === "string" ? obj.type : "";
    if (type !== "custom-title" && type !== "agent-name") continue;
    latest =
      normalizeTitle(obj.customTitle) ||
      normalizeTitle(obj.title) ||
      normalizeTitle(obj.custom_title) ||
      normalizeTitle(obj.agentName) ||
      normalizeTitle(obj.agent_name) ||
      latest;
  }
  return latest;
}

const EVENT_TO_STATE = require("../agents/claude-code").eventMap;

function buildStateBody(event, payload, resolve) {
  const state = EVENT_TO_STATE[event];
  if (!state) return null;

  const sessionId = payload.session_id || "default";
  const cwd = (event === "CwdChanged" && payload.new_cwd) || payload.cwd || "";
  const source = payload.source || payload.reason || "";

  // /clear triggers SessionEnd → SessionStart in quick succession;
  // show sweeping (clearing context) instead of sleeping
  const resolvedState = (event === "SessionEnd" && source === "clear") ? "sweeping" : state;

  const body = { state: resolvedState, session_id: sessionId, event };
  body.agent_id = "claude-code";
  body.source = "hook";
  if (payload.agent_id) body.child_agent_id = payload.agent_id;
  if (payload.agent_type) body.agent_type = payload.agent_type;
  if (payload.turn_id) body.turn_id = payload.turn_id;
  if (payload.tool_use_id) body.tool_call_id = payload.tool_use_id;
  if (payload.tool_name) body.tool_name = payload.tool_name;
  if (payload.task_id) body.task_id = payload.task_id;
  if (payload.teammate_name) body.teammate_name = payload.teammate_name;
  if (payload.team_name) body.team_name = payload.team_name;
  if (payload.model || payload.to_model) body.model = payload.to_model || payload.model;
  if (payload.notification_type) body.notification_type = payload.notification_type;
  if (event === "CwdChanged" || event === "PostModelSwitch") body.meta_only = true;
  if (cwd) body.cwd = cwd;
  // Session title: prefer payload field, fall back to scanning the transcript
  // tail for user-set custom-title / agent-name events
  const sessionTitle =
    normalizeTitle(payload.session_title) ||
    extractSessionTitleFromTranscript(payload.transcript_path);
  if (sessionTitle) body.session_title = sessionTitle;
  if (process.env.CLAWD_REMOTE) {
    body.host = readHostPrefix();
  } else {
    const { stablePid, agentPid, detectedEditor, pidChain } = resolve();
    body.source_pid = stablePid;
    if (detectedEditor) body.editor = detectedEditor;
    if (agentPid) {
      body.agent_pid = agentPid;
      body.claude_pid = agentPid; // backward compat with older Clawd versions
      // Check if claude process is running in non-interactive (-p/--print) mode
      try {
        const { execSync } = require("child_process");
        const isWin = process.platform === "win32";
        const cmdOut = isWin
          ? execSync(
              `wmic process where "ProcessId=${agentPid}" get CommandLine /format:csv`,
              { encoding: "utf8", timeout: 500, windowsHide: true }
            )
          : execSync(`ps -o command= -p ${agentPid}`, { encoding: "utf8", timeout: 500 });
        if (/\s(-p|--print)(\s|$)/.test(cmdOut)) body.headless = true;
      } catch {}
    }
    if (pidChain.length) body.pid_chain = pidChain;
  }

  return body;
}

function main() {
  if (process.argv.includes("--remote")) process.env.CLAWD_REMOTE = "1";
  const event = process.argv[2];
  if (!EVENT_TO_STATE[event]) process.exit(0);

  const config = getPlatformConfig();
  const resolve = createPidResolver({
    agentNames: { win: new Set(["claude.exe"]), mac: new Set(["claude"]) },
    agentCmdlineCheck: (cmd) => cmd.includes("claude-code") || cmd.includes("@anthropic-ai"),
    platformConfig: config,
  });

  // Pre-resolve on SessionStart (runs during stdin buffering, not after)
  // Remote mode: skip PID collection — remote PIDs are meaningless on the local machine
  if (event === "SessionStart" && !process.env.CLAWD_REMOTE) resolve();

  readStdinJson().then(async (payload) => {
    const body = buildStateBody(event, payload || {}, resolve);
    if (!body) process.exit(0);
    if (event === "PermissionRequest") {
      const response = await requestPermission({ ...payload, ...body, hook_event_name: event });
      if (response) process.stdout.write(JSON.stringify(response));
      return process.exit(0);
    }
    postStateToRunningServer(
      JSON.stringify(body),
      { timeoutMs: 100, cwd: body.cwd },
      () => process.exit(0)
    );
  }).catch(() => process.exit(0));
}

if (require.main === module) main();

module.exports = { buildStateBody, extractSessionTitleFromTranscript };
