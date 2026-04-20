"use strict";

const path = require("path");

function addFile(files, value) {
  if (typeof value !== "string" || !value) return;
  files.add(path.basename(value));
}

function addFiles(files, values) {
  if (!Array.isArray(values)) return;
  for (const value of values) addFile(files, value);
}

function collectThemeFiles(theme) {
  const files = new Set();
  if (!theme || typeof theme !== "object") return files;

  const states = theme.states && typeof theme.states === "object" ? theme.states : {};
  for (const value of Object.values(states)) addFiles(files, value);

  const miniStates = theme.miniMode && theme.miniMode.states && typeof theme.miniMode.states === "object"
    ? theme.miniMode.states
    : {};
  for (const value of Object.values(miniStates)) addFiles(files, value);

  for (const tier of Array.isArray(theme.workingTiers) ? theme.workingTiers : []) {
    addFile(files, tier && tier.file);
  }
  for (const tier of Array.isArray(theme.jugglingTiers) ? theme.jugglingTiers : []) {
    addFile(files, tier && tier.file);
  }
  for (const anim of Array.isArray(theme.idleAnimations) ? theme.idleAnimations : []) {
    addFile(files, anim && anim.file);
  }

  const reactions = theme.reactions && typeof theme.reactions === "object" ? theme.reactions : {};
  for (const reaction of Object.values(reactions)) {
    if (!reaction || typeof reaction !== "object") continue;
    addFile(files, reaction.file);
    addFiles(files, reaction.files);
  }

  const hints = theme.displayHintMap && typeof theme.displayHintMap === "object" ? theme.displayHintMap : {};
  for (const value of Object.values(hints)) addFile(files, value);

  return files;
}

function toAssetMap(theme, resolveUri) {
  const out = {};
  for (const filename of collectThemeFiles(theme)) {
    const uri = resolveUri(filename);
    if (uri) out[filename] = String(uri);
  }
  return out;
}

module.exports = {
  collectThemeFiles,
  toAssetMap,
};
