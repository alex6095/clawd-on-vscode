const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const CLAWD_SERVER_ID = "clawd-on-vscode";
const CLAWD_SERVER_HEADER = "x-clawd-server";
const DEFAULT_SERVER_PORT = 23333;
const SERVER_PORT_COUNT = 5;
const SERVER_PORTS = Array.from({ length: SERVER_PORT_COUNT }, (_, i) => DEFAULT_SERVER_PORT + i);
const STATE_PATH = "/state";
const PERMISSION_PATH = "/permission";
const RUNTIME_CONFIG_PATH = path.join(os.homedir(), ".clawd-on-vscode", "runtime.json");
const RUNTIME_TTL_MS = 90000;

function normalizePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

function runtimePaths(options = {}) {
  const dir = options.runtimeDir || process.env.CLAWD_RUNTIME_DIR || path.dirname(options.runtimeConfigPath || RUNTIME_CONFIG_PATH);
  return { dir, registryDir: path.join(dir, "runtimes"), legacyPath: options.runtimeConfigPath || path.join(dir, "runtime.json") };
}

function safeInstanceId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value) ? value : null;
}

function processAlive(pid, options) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (typeof options.isProcessAlive === "function") return options.isProcessAlive(pid);
  try { (options.processKill || process.kill)(pid, 0); return true; }
  catch (err) { return err.code === "EPERM"; }
}

function normalizeRoots(roots) {
  return Array.isArray(roots) ? [...new Set(roots.filter(root => typeof root === "string" && path.isAbsolute(root)).map(root => path.resolve(root)))] : [];
}

function readRuntimeEntries(options = {}) {
  const { registryDir } = runtimePaths(options);
  const now = typeof options.now === "function" ? options.now() : Date.now();
  let files;
  try { files = fs.readdirSync(registryDir); } catch { return []; }
  return files.filter(file => file.endsWith(".json")).flatMap(file => {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(registryDir, file), "utf8"));
      const instanceId = safeInstanceId(raw.instanceId);
      const port = normalizePort(raw.port);
      if (raw.app !== CLAWD_SERVER_ID || !instanceId || !port || raw.expiresAt <= now || !processAlive(raw.pid, options)) return [];
      return [{ ...raw, instanceId, port, visible: raw.visible === true, workspaceRoots: normalizeRoots(raw.workspaceRoots) }];
    } catch { return []; }
  }).sort((a, b) => b.updatedAt - a.updatedAt);
}

function rootMatchLength(cwd, roots) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return -1;
  const target = path.resolve(cwd);
  let length = -1;
  for (const root of roots) {
    const relative = path.relative(root, target);
    if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) length = Math.max(length, root.length);
  }
  return length;
}

// A hook belongs to the most specific open workspace. An empty window can
// observe unmatched sessions; unrelated workspaces must never get its approvals.
function selectRuntimeEntries(options = {}, entries = readRuntimeEntries(options)) {
  // Heartbeats only prove liveness. Within an equally specific workspace,
  // an open approval UI owns the session ahead of a newer hidden window.
  const preferred = candidates => [...candidates].sort((a, b) => Number(b.visible === true) - Number(a.visible === true)
    || b.updatedAt - a.updatedAt || a.instanceId.localeCompare(b.instanceId)).slice(0, 1);
  const requestedId = options.instanceId || options.instance_id;
  if (requestedId) return entries.filter(entry => entry.instanceId === requestedId);
  if (typeof options.cwd === "string" && options.cwd) {
    const matches = entries.map(entry => ({ entry, length: rootMatchLength(options.cwd, entry.workspaceRoots) })).filter(match => match.length >= 0);
    if (matches.length) {
      const longest = Math.max(...matches.map(match => match.length));
      return preferred(matches.filter(match => match.length === longest).map(match => match.entry));
    }
    return preferred(entries.filter(entry => entry.workspaceRoots.length === 0));
  }
  const blank = entries.filter(entry => entry.workspaceRoots.length === 0);
  return preferred(blank.length ? blank : entries);
}

const HOST_PREFIX_PATH = path.join(os.homedir(), ".claude", "hooks", "clawd-host-prefix");

function readHostPrefix() {
  let prefix = null;
  try { prefix = fs.readFileSync(HOST_PREFIX_PATH, "utf8").trim(); } catch {}
  return prefix || os.hostname().split(".")[0];
}

function readRuntimeConfig(options = {}) {
  const entries = readRuntimeEntries(options);
  if (entries.length) return selectRuntimeEntries(options, entries)[0] || null;
  try {
    const raw = JSON.parse(fs.readFileSync(runtimePaths(options).legacyPath, "utf8"));
    if (!raw || typeof raw !== "object") return null;
    const port = normalizePort(raw.port);
    return port ? { port } : null;
  } catch {
    return null;
  }
}

function readRuntimePort(options = {}) {
  const config = readRuntimeConfig(options);
  return config ? config.port : null;
}

function writeRuntimeConfig(port, options = {}) {
  const safePort = normalizePort(port);
  if (!safePort) return false;
  const instanceId = safeInstanceId(options.instanceId) || `pid-${process.pid}`;
  const { registryDir } = runtimePaths(options);
  const now = typeof options.now === "function" ? options.now() : Date.now();
  const target = path.join(registryDir, `${instanceId}.json`);
  const tmpPath = path.join(registryDir, `.${instanceId}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  const body = JSON.stringify({ app: CLAWD_SERVER_ID, instanceId, port: safePort, pid: options.pid || process.pid,
    workspaceRoots: normalizeRoots(options.workspaceRoots), visible: options.visible === true, updatedAt: now, expiresAt: now + (options.ttlMs || RUNTIME_TTL_MS) }, null, 2);
  try {
    fs.mkdirSync(registryDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmpPath, body, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmpPath, target);
    return true;
  } catch {
    try { fs.unlinkSync(tmpPath); } catch {}
    return false;
  }
}

function clearRuntimeConfig(options = {}) {
  const filePath = typeof options === "string" ? options : path.join(runtimePaths(options).registryDir, `${safeInstanceId(options.instanceId) || `pid-${process.pid}`}.json`);
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function getPortCandidates(preferredPort, options = {}) {
  const ports = [];
  const seen = new Set();
  const runtimePort = normalizePort(
    Object.prototype.hasOwnProperty.call(options, "runtimePort")
      ? options.runtimePort
      : readRuntimePort(options)
  );
  const add = (value) => {
    const port = normalizePort(value);
    if (!port || seen.has(port)) return;
    seen.add(port);
    ports.push(port);
  };

  if (Array.isArray(preferredPort)) preferredPort.forEach(add);
  else add(preferredPort);
  add(runtimePort);
  SERVER_PORTS.forEach(add);
  return ports;
}

function splitPortCandidates(preferredPort, options = {}) {
  const runtimePort = normalizePort(
    Object.prototype.hasOwnProperty.call(options, "runtimePort")
      ? options.runtimePort
      : readRuntimePort(options)
  );
  const all = getPortCandidates(preferredPort, { ...options, runtimePort });
  const direct = [];
  const fallback = [];
  const directSeen = new Set();

  const addDirect = (port) => {
    if (!port || directSeen.has(port)) return;
    directSeen.add(port);
    direct.push(port);
  };

  if (Array.isArray(preferredPort)) preferredPort.forEach((port) => addDirect(normalizePort(port)));
  else addDirect(normalizePort(preferredPort));
  addDirect(runtimePort);

  for (const port of all) {
    if (directSeen.has(port)) continue;
    fallback.push(port);
  }

  return { direct, fallback, all };
}

function buildPermissionUrl(port) {
  const safePort = normalizePort(port) || DEFAULT_SERVER_PORT;
  return `http://127.0.0.1:${safePort}${PERMISSION_PATH}`;
}

function readHeader(res, headerName) {
  const value = res.headers && res.headers[headerName];
  return Array.isArray(value) ? value[0] : value;
}

function isClawdResponse(res, body) {
  if (readHeader(res, CLAWD_SERVER_HEADER) === CLAWD_SERVER_ID) return true;
  if (!body) return false;
  try {
    const data = JSON.parse(body);
    return data && data.app === CLAWD_SERVER_ID;
  } catch {
    return false;
  }
}

function probePort(port, timeoutMs, callback, options = {}) {
  let settled = false;
  const finish = (ok) => { if (!settled) { settled = true; callback(ok); } };
  const httpGet = options.httpGet || http.get;
  const req = httpGet(
    { hostname: "127.0.0.1", port, path: STATE_PATH, timeout: timeoutMs },
    (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        if (body.length < 256) body += chunk;
      });
      res.on("end", () => finish(res.statusCode === 200 && isClawdResponse(res, body)));
    }
  );

  req.on("error", () => finish(false));
  req.on("timeout", () => {
    req.destroy();
    finish(false);
  });
}

function postStateToPort(port, payload, timeoutMs, callback, options = {}) {
  let settled = false;
  const finish = (ok) => { if (!settled) { settled = true; callback(ok, port); } };
  const httpRequest = options.httpRequest || http.request;
  const req = httpRequest(
    {
      hostname: "127.0.0.1",
      port,
      path: STATE_PATH,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
      timeout: timeoutMs,
    },
    (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        finish(false);
        return;
      }
      if (readHeader(res, CLAWD_SERVER_HEADER) === CLAWD_SERVER_ID) {
        res.resume();
        finish(true);
        return;
      }

      let responseBody = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        if (responseBody.length < 256) responseBody += chunk;
      });
      res.on("end", () => finish(isClawdResponse(res, responseBody)));
    }
  );

  req.on("error", () => finish(false));
  req.on("timeout", () => {
    req.destroy();
    finish(false);
  });
  req.end(payload);
}

function discoverClawdPort(options, callback) {
  options = options || {};
  const timeoutMs = options && options.timeoutMs ? options.timeoutMs : 100;
  const entries = readRuntimeEntries(options);
  const ports = entries.length ? selectRuntimeEntries(options, entries).map(entry => entry.port) : getPortCandidates(options.preferredPort, options);
  const probe = options && options.probePort ? options.probePort : probePort;
  let index = 0;

  const tryNext = () => {
    if (index >= ports.length) {
      callback(null);
      return;
    }

    const port = ports[index++];
    probe(port, timeoutMs, (ok) => {
      if (ok) {
        callback(port);
        return;
      }
      tryNext();
    }, options);
  };

  tryNext();
}

function postStateToRunningServer(body, options, callback) {
  options = options || {};
  let parsedBody;
  try { parsedBody = typeof body === "string" ? JSON.parse(body) : body; } catch { parsedBody = {}; }
  const routingOptions = { ...options, cwd: options.cwd || parsedBody.cwd, instanceId: options.instanceId || parsedBody.instance_id };
  const timeoutMs = options && options.timeoutMs ? options.timeoutMs : 100;
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  const entries = readRuntimeEntries(routingOptions);
  const { direct, fallback } = entries.length
    ? { direct: selectRuntimeEntries(routingOptions, entries).map(entry => entry.port), fallback: [] }
    : splitPortCandidates(options.preferredPort, routingOptions);
  const probe = options && options.probePort ? options.probePort : probePort;
  const post = options && options.postStateToPort ? options.postStateToPort : postStateToPort;
  let directIndex = 0;
  let fallbackIndex = 0;

  const tryFallback = () => {
    if (fallbackIndex >= fallback.length) {
      callback(false, null);
      return;
    }

    const port = fallback[fallbackIndex++];
    probe(port, timeoutMs, (ok) => {
      if (!ok) {
        tryFallback();
        return;
      }
      post(port, payload, timeoutMs, (posted, confirmedPort) => {
        if (posted) {
          callback(true, confirmedPort);
          return;
        }
        tryFallback();
      }, options);
    }, options);
  };

  const tryDirect = () => {
    if (directIndex >= direct.length) {
      tryFallback();
      return;
    }

    const port = direct[directIndex++];
    post(port, payload, timeoutMs, (posted, confirmedPort) => {
      if (posted) {
        callback(true, confirmedPort);
        return;
      }
      tryDirect();
    }, options);
  };

  tryDirect();
}

/**
 * Resolve the absolute path to the Node.js binary for hook commands.
 * On macOS/Linux, Claude Code runs hooks with a minimal PATH (/usr/bin:/bin)
 * that excludes Homebrew, nvm, volta, fnm, etc.  We embed the full path in
 * hook commands so they work regardless of the hook runner's PATH.
 *
 * @param {object} [options] — for testing
 * @param {string} [options.platform]
 * @param {string} [options.homeDir]
 * @param {Function} [options.execFileSync]
 * @param {Function} [options.accessSync]
 * @param {string} [options.execPath]
 * @param {boolean} [options.isElectron]
 * @returns {string|null} absolute path, "node" (Windows), or null (detection failed)
 */
function resolveNodeBin(options = {}) {
  const platform = options.platform || process.platform;

  // Windows: bare `node` works fine (PATH is inherited properly)
  if (platform === "win32") return "node";

  const isElectron = options.isElectron !== undefined
    ? options.isElectron
    : !!process.versions.electron;

  // Non-Electron Node.js: process.execPath IS the node binary
  if (!isElectron) {
    return options.execPath || process.execPath;
  }

  // Electron on macOS/Linux: need to find system node
  const homeDir = options.homeDir || os.homedir();
  const access = options.accessSync || fs.accessSync;

  // Strategy 1: Check well-known paths (fast, no shell spawn)
  const candidates = [
    "/opt/homebrew/bin/node",                          // Homebrew ARM Mac
    "/usr/local/bin/node",                             // Homebrew Intel Mac / official .pkg
    path.join(homeDir, ".volta", "bin", "node"),       // Volta
    path.join(homeDir, ".local", "bin", "node"),       // pipx-style / manual
    "/usr/bin/node",                                   // system package manager
  ];

  for (const candidate of candidates) {
    try {
      access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }

  // Strategy 2: Login + interactive shell (sources both .zprofile AND .zshrc/.bashrc,
  // needed because nvm/fnm initialize in rc files, not profile files)
  const execFileSync = options.execFileSync || require("child_process").execFileSync;
  const shells = ["/bin/zsh", "/bin/bash"];
  for (const shell of shells) {
    try {
      const raw = execFileSync(shell, ["-lic", "which node"], {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
      });
      // Interactive shells may produce extra output (Oh My Zsh, Powerlevel10k, etc.)
      // before `which node`. Take the last line that looks like an absolute path.
      const lines = raw.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (line.startsWith("/")) return line;
      }
    } catch {}
  }

  // Detection failed — return null so callers can preserve existing config
  // instead of destructively overwriting an absolute path with bare "node"
  return null;
}

module.exports = {
  CLAWD_SERVER_HEADER,
  CLAWD_SERVER_ID,
  DEFAULT_SERVER_PORT,
  PERMISSION_PATH,
  RUNTIME_CONFIG_PATH,
  RUNTIME_TTL_MS,
  SERVER_PORTS,
  STATE_PATH,
  buildPermissionUrl,
  clearRuntimeConfig,
  discoverClawdPort,
  getPortCandidates,
  postStateToRunningServer,
  probePort,
  readHostPrefix,
  readRuntimePort,
  readRuntimeEntries,
  selectRuntimeEntries,
  resolveNodeBin,
  splitPortCandidates,
  postStateToPort,
  writeRuntimeConfig,
};
