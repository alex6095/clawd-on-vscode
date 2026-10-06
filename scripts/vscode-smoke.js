"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const version = require("../package.json").version;
const base = path.join(root, ".debug", "smoke");
const vscode = process.env.VSCODE_EXECUTABLE || (process.platform === "darwin"
  ? "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" : "code");
const dirs = Object.fromEntries(["user-data", "extensions", "runtime", "claude", "codex", "results"].map((name) => [name, path.join(base, name)]));
for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
fs.mkdirSync(path.join(dirs["user-data"], "User"), { recursive: true });
fs.writeFileSync(path.join(dirs["user-data"], "User", "settings.json"), JSON.stringify({
  "window.title": "Clawd automated validation — empty window", "workbench.startupEditor": "none",
  "clawd.codex.logFallback": false, "clawd.sound.enabled": false, "telemetry.telemetryLevel": "off",
}));
const resultPath = path.join(dirs.results, "vscode-smoke.json");
fs.rmSync(resultPath, { force: true });
const env = { ...process.env, CLAWD_RUNTIME_DIR: dirs.runtime, CLAUDE_CONFIG_DIR: dirs.claude,
  CODEX_HOME: dirs.codex, CLAWD_SMOKE_RESULTS: dirs.results };
const common = ["--user-data-dir", dirs["user-data"], "--extensions-dir", dirs.extensions];
const install = spawnSync(vscode, [...common, "--install-extension", path.join(root, `clawd-on-vscode-${version}.vsix`), "--force"], { env, encoding: "utf8", timeout: 60000 });
if (install.error || install.status !== 0) throw install.error || new Error(install.stderr || install.stdout);
const log = fs.openSync(path.join(dirs.results, "vscode.log"), "w");
try {
  const run = spawnSync(vscode, [...common,
    "--extensionDevelopmentPath", path.join(dirs.extensions, `alex6095.clawd-on-vscode-${version}`),
    "--extensionTestsPath", path.join(root, "test", "vscode-smoke.js"), "--new-window", "--verbose",
  ], { env, stdio: ["ignore", log, log], timeout: 60000 });
  if (run.error) throw run.error;
  if (!fs.existsSync(resultPath)) throw new Error(`VS Code smoke failed; inspect ${path.join(dirs.results, "vscode.log")}`);
  const results = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  console.log(JSON.stringify(results, null, 2));
} finally { fs.closeSync(log); }
