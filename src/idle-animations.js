"use strict";

const path = require("node:path");

const ACTIVITY_STATES = new Set([
  "thinking", "working", "juggling", "carrying", "sweeping",
  "attention", "happy", "notification", "error",
  "yawning", "dozing", "collapsing", "sleeping", "waking", "paused",
]);

function idleAnimationPool(theme, assetMap) {
  if (!theme || !Array.isArray(theme.idleAnimations)) return [];
  const reserved = new Set();
  const reserve = (file) => {
    if (typeof file === "string") reserved.add(path.basename(file));
  };
  for (const [state, files] of Object.entries(theme.states || {})) {
    if (ACTIVITY_STATES.has(state)) for (const file of Array.isArray(files) ? files : [files]) reserve(file);
  }
  for (const tier of [...(theme.workingTiers || []), ...(theme.jugglingTiers || [])]) reserve(tier && tier.file);
  for (const file of theme.sleepingHitboxFiles || []) reserve(file);
  // Display hints select tool activity assets even when their legacy source
  // name contains "idle" (for example the reading hint).
  for (const file of Object.values(theme.displayHintMap || {})) reserve(file);

  const seen = new Set();
  return theme.idleAnimations.flatMap((entry) => {
    if (!entry || typeof entry.file !== "string" || !entry.file) return [];
    const file = path.basename(entry.file);
    if (!assetMap[file] || reserved.has(file) || seen.has(file)) return [];
    // Idle metadata is an explicit leisure allowlist. Still reject recognizable
    // activity assets, even when a theme omitted its state/tier mapping.
    if (/(?:working|thinking|reading|debugger|notification|error|happy|sleep|yawn|doz|collaps|wak)/i.test(file)) return [];
    seen.add(file);
    return [{ file, duration: Number.isFinite(entry.duration) ? Math.min(8000, Math.max(1000, entry.duration)) : 4500 }];
  });
}

module.exports = { idleAnimationPool };
