// Install Codex's documented command-hook schema without changing its feature,
// approval or trust settings. Exact definitions must be reviewed in Codex /hooks.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { eventMap } = require("../agents/codex");
const { writeJsonAtomic, asarUnpackedPath } = require("./json-utils");
const { resolveNodeBin } = require("./server-config");
const MARKER = "codex-hook.js";
const HOOK_LABELS = {
  SessionStart: "Clawd: show session start", SessionEnd: "Clawd: show session end",
  UserPromptSubmit: "Clawd: show thinking", PreToolUse: "Clawd: show tool activity",
  PostToolUse: "Clawd: show tool completion", PermissionRequest: "Clawd: show approval request",
  SubagentStart: "Clawd: show helper started", SubagentStop: "Clawd: show helper finished",
  PreCompact: "Clawd: show context cleanup", PostCompact: "Clawd: show context ready",
  Stop: "Clawd: show task completed", Interrupt: "Clawd: show task interrupted",
};

function codexHome(options = {}) {
  return options.codexHome || process.env.CODEX_HOME || path.join(options.homeDir || os.homedir(), ".codex");
}

function hooksPath(options) { return options.hooksPath || path.join(codexHome(options), "hooks.json"); }

function readConfig(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected a JSON object");
    if (value.hooks && (typeof value.hooks !== "object" || Array.isArray(value.hooks))) throw new Error("hooks must be an object");
    return value;
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw new Error(`Cannot read Codex hooks at ${file}: ${err.message}`);
  }
}

function owned(hook) {
  return hook && hook.type === "command" && typeof hook.command === "string"
    && /(?:^|[\\/])codex-hook\.js(?:["'\s]|$)/.test(hook.command);
}

function existingNodeBin(config) {
  for (const groups of Object.values(config.hooks || {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      for (const hook of group && Array.isArray(group.hooks) ? group.hooks : [group]) {
        if (!owned(hook)) continue;
        const token = hook.command.match(/^(?:CLAWD_REMOTE=1\s+)?(["'])(.*?)\1(?:\s|$)/);
        if (token && path.isAbsolute(token[2]) && !token[2].includes(MARKER)) return token[2];
      }
    }
  }
  return null;
}

function stripOwned(entries) {
  const result = [];
  let removed = 0;
  for (const group of entries) {
    if (owned(group)) { removed++; continue; }
    if (!group || !Array.isArray(group.hooks)) { result.push(group); continue; }
    const kept = group.hooks.filter((hook) => { if (!owned(hook)) return true; removed++; return false; });
    if (kept.length === group.hooks.length) result.push(group);
    else if (kept.length) result.push({ ...group, hooks: kept });
  }
  return { entries: result, removed };
}

function quoteShell(value, platform = process.platform) {
  if (platform === "win32") {
    if (/["\r\n%]/.test(value)) throw new Error("Unsupported command path characters");
    return `"${value}"`;
  }
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function registerCodexHooks(options = {}) {
  const file = hooksPath(options);
  const config = readConfig(file);
  const before = JSON.stringify(config);
  const resolved = options.nodeBin !== undefined ? options.nodeBin : resolveNodeBin();
  const nodeBin = resolved || existingNodeBin(config) || "node";
  const script = asarUnpackedPath(path.resolve(__dirname, MARKER));
  const platform = options.platform || process.platform;
  const command = `${quoteShell(nodeBin, platform)} ${quoteShell(script, platform)}`;
  if (!config.hooks) config.hooks = {};
  let added = 0;
  let updated = 0;
  let skipped = 0;
  for (const event of Object.keys(eventMap)) {
    const existing = config.hooks[event];
    if (existing !== undefined && !Array.isArray(existing)) throw new Error(`Codex hooks.${event} must be an array`);
    const groups = existing || [];
    const desired = { hooks: [{ type: "command", command: `${command} ${event}${options.remote ? " --remote" : ""}`, timeout: event === "PermissionRequest" ? 600 : 3, statusMessage: HOOK_LABELS[event] }] };
    if (groups.some((group) => JSON.stringify(group) === JSON.stringify(desired)) && groups.reduce((n, group) => n + (group && Array.isArray(group.hooks) ? group.hooks : [group]).filter(owned).length, 0) === 1) {
      skipped++;
      continue;
    }
    const cleaned = stripOwned(groups);
    config.hooks[event] = [...cleaned.entries, desired];
    if (cleaned.removed) updated++; else added++;
  }
  const changed = JSON.stringify(config) !== before;
  if (changed) writeJsonAtomic(file, config);
  return { added, updated, skipped, changed, ...getCodexHookStatus({ ...options, detectVersion: false }), trustRequired: true };
}

function unregisterCodexHooks(options = {}) {
  const file = hooksPath(options);
  const config = readConfig(file);
  let removed = 0;
  for (const [event, groups] of Object.entries(config.hooks || {})) {
    if (!Array.isArray(groups)) continue;
    const cleaned = stripOwned(groups);
    removed += cleaned.removed;
    if (!cleaned.removed) continue;
    if (cleaned.entries.length) config.hooks[event] = cleaned.entries;
    else delete config.hooks[event];
  }
  if (removed) writeJsonAtomic(file, config);
  return { removed, changed: removed > 0 };
}

function getCodexVersion(options = {}) {
  try {
    const exec = options.execFileSync || require("child_process").execFileSync;
    const out = exec(options.codexBin || "codex", ["--version"], { encoding: "utf8", timeout: 3000, windowsHide: true });
    return (out.match(/\b\d+\.\d+\.\d+\b/) || [null])[0];
  } catch { return null; }
}

function getCodexHookStatus(options = {}) {
  const file = hooksPath(options);
  let config;
  try { config = readConfig(file); }
  catch (err) { return { installed: false, path: file, trustRequired: false, error: err.message }; }
  const events = Object.entries(config.hooks || {}).filter(([, groups]) => Array.isArray(groups) && groups.some((group) => owned(group) || (group && Array.isArray(group.hooks) && group.hooks.some(owned)))).map(([event]) => event);
  let disabledInUserConfig = false;
  try {
    const toml = fs.readFileSync(path.join(codexHome(options), "config.toml"), "utf8");
    let section = "";
    const flags = {};
    for (const line of toml.split(/\r?\n/)) {
      const header = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
      if (header) section = header[1].trim();
      const flag = section === "features" ? line.match(/^\s*(hooks|codex_hooks)\s*=\s*(true|false)\s*(?:#.*)?$/)
        : section === "" ? line.match(/^\s*features\.(hooks|codex_hooks)\s*=\s*(true|false)\s*(?:#.*)?$/) : null;
      if (flag) flags[flag[1]] = flag[2] === "true";
    }
    disabledInUserConfig = (flags.hooks !== undefined ? flags.hooks : flags.codex_hooks) === false;
  } catch {}
  const installed = events.length > 0;
  return {
    installed, complete: Object.keys(eventMap).every((event) => events.includes(event)), path: file, events,
    version: options.version || (options.detectVersion === false ? null : getCodexVersion(options)),
    disabledInUserConfig,
    // No supported offline trust database contract exists. Do not guess or edit it.
    trustStatus: installed ? "unverified" : "not-installed",
    trustRequired: installed,
    message: disabledInUserConfig ? "Hooks are disabled in the user configuration; transcript polling remains available."
      : installed ? "Review and trust these definitions in Codex /hooks. Hook execution confirms availability."
        : "Codex is using transcript polling. Install hooks for exact lifecycle and approval events.",
  };
}

module.exports = { registerCodexHooks, unregisterCodexHooks, getCodexHookStatus, getCodexVersion, codexHome, quoteShell };
