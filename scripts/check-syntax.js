"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(file) : /\.[cm]?js$/.test(entry.name) ? [file] : [];
  });
}
const files = ["src", "media", "vendor/clawd", "test", "scripts"].flatMap((dir) => walk(path.join(root, dir)));
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || String(result.error));
    process.exit(1);
  }
}
console.log(`Syntax checked ${files.length} JavaScript files.`);
