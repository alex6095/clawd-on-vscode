#!/usr/bin/env node
// Codex command hooks receive JSON on stdin. Never print observational output:
// lifecycle-hook stdout can become model context or a control decision.
const { eventMap } = require("../agents/codex");
const { createPidResolver, readStdinJson, getPlatformConfig } = require("./shared-process");
const { postStateToRunningServer, readHostPrefix } = require("./server-config");
const { requestPermission } = require("./permission-client");

function buildStateBody(event, payload = {}, resolve = () => ({})) {
  const state = eventMap[event];
  if (!state || !payload.session_id) return null;
  const rawId = String(payload.session_id);
  const body = {
    state,
    session_id: rawId.startsWith("codex:") ? rawId : `codex:${rawId}`,
    event,
    agent_id: "codex",
    source: "hook",
    cwd: payload.cwd || "",
  };
  if (event === "SessionStart" && payload.source === "compact") body.state = "thinking";
  if (payload.agent_id) body.child_agent_id = payload.agent_id;
  if (payload.agent_type) body.agent_type = payload.agent_type;
  if (payload.turn_id) body.turn_id = payload.turn_id;
  if (payload.tool_use_id) body.tool_call_id = payload.tool_use_id;
  if (payload.model) body.model = payload.model;
  if (payload.tool_name) body.tool_name = payload.tool_name;
  if (process.env.CLAWD_REMOTE) body.host = readHostPrefix();
  else {
    const { stablePid, agentPid, detectedEditor, pidChain } = resolve();
    if (stablePid) body.source_pid = stablePid;
    if (agentPid) body.agent_pid = body.codex_pid = agentPid;
    if (detectedEditor) body.editor = detectedEditor;
    if (pidChain && pidChain.length) body.pid_chain = pidChain;
  }
  return body;
}

async function main() {
  if (process.argv.includes("--remote")) process.env.CLAWD_REMOTE = "1";
  const payload = await readStdinJson() || {};
  const event = process.argv[2] || payload.hook_event_name;
  const resolve = createPidResolver({
    platformConfig: getPlatformConfig(),
    agentNames: { win: new Set(["codex.exe"]), mac: new Set(["codex"]) },
    agentCmdlineCheck: (cmd) => /(?:@openai[\\/]codex|\bcodex\b)/.test(cmd),
  });
  const body = buildStateBody(event, payload, resolve);
  if (!body) return;
  if (event === "PermissionRequest") {
    const response = await requestPermission({ ...payload, ...body, hook_event_name: event });
    if (response) process.stdout.write(JSON.stringify(response));
    return;
  }
  await new Promise((done) => postStateToRunningServer(body, { timeoutMs: 100, cwd: body.cwd }, done));
}

if (require.main === module) main().catch(() => {}).then(() => process.exit(0));
module.exports = { buildStateBody };
