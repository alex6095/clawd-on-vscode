// Command-hook permission bridge. A missing UI, timeout or malformed response
// produces no hook decision, so the agent's own approval flow stays available.
const http = require("http");
const { discoverClawdPort, CLAWD_SERVER_HEADER, CLAWD_SERVER_ID, PERMISSION_PATH } = require("./server-config");

function sanitizePermissionResponse(value, agentId) {
  const output = value && value.hookSpecificOutput;
  if (!output || output.hookEventName !== "PermissionRequest") return null;
  const decision = output.decision;
  if (!decision || !["allow", "deny"].includes(decision.behavior)) return null;
  const cleaned = { behavior: decision.behavior };
  if (decision.behavior === "deny" && typeof decision.message === "string") cleaned.message = decision.message;
  // Codex deliberately rejects Claude-specific permission extensions.
  if (agentId === "claude-code") {
    if (decision.behavior === "allow" && decision.updatedInput && typeof decision.updatedInput === "object") {
      cleaned.updatedInput = decision.updatedInput;
    }
    if (decision.behavior === "allow" && Array.isArray(decision.updatedPermissions)) {
      cleaned.updatedPermissions = decision.updatedPermissions;
    }
    if (decision.behavior === "deny" && typeof decision.interrupt === "boolean") cleaned.interrupt = decision.interrupt;
  }
  return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: cleaned } };
}

function requestPermission(payload, options = {}) {
  return new Promise((resolve) => {
    const discover = options.discoverClawdPort || discoverClawdPort;
    discover({ cwd: payload.cwd, timeoutMs: 100, ...options.discovery }, (port) => {
      if (!port) return resolve(null);
      const body = JSON.stringify(payload);
      const request = options.httpRequest || http.request;
      const req = request({
        hostname: "127.0.0.1", port, path: PERMISSION_PATH, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        timeout: options.timeoutMs || 590000,
      }, (res) => {
        if (res.statusCode !== 200 || res.headers[CLAWD_SERVER_HEADER] !== CLAWD_SERVER_ID) {
          res.resume();
          resolve(null);
          return;
        }
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
          if (data.length > 1024 * 1024) { req.destroy(); resolve(null); }
        });
        res.on("error", () => resolve(null));
        res.on("end", () => {
          try { resolve(sanitizePermissionResponse(JSON.parse(data), payload.agent_id)); }
          catch { resolve(null); }
        });
      });
      req.on("error", () => resolve(null));
      req.on("timeout", () => { req.destroy(); resolve(null); });
      req.end(body);
    });
  });
}

module.exports = { requestPermission, sanitizePermissionResponse };
