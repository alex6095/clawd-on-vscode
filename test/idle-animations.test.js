"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { idleAnimationPool } = require("../src/idle-animations");
const { toAssetMap } = require("../src/asset-map");

test("idle pool allows only available explicit leisure assets and excludes activity, hints, tiers and sleep", () => {
  const theme = {
    states: { idle: ["neutral.svg"], working: ["typing.svg"], thinking: ["glasses.svg"], notification: ["rainbow.svg"], error: ["red.svg"], attention: ["excited.svg"], sleeping: ["blanket.svg"], "pose-shy": ["shy.svg"] },
    workingTiers: [{ file: "building.svg" }], jugglingTiers: [{ file: "conducting.svg" }],
    sleepingHitboxFiles: ["lying.svg"], displayHintMap: { "clawd-working-debugger.svg": "cool.svg", "clawd-idle-reading.svg": "read-pose.svg" },
    idleAnimations: ["neutral.svg", "typing.svg", "glasses.svg", "rainbow.svg", "red.svg", "excited.svg", "blanket.svg", "building.svg", "conducting.svg", "lying.svg", "cool.svg", "read-pose.svg", "clawd-working-debugger.svg", "clawd-idle-reading.svg", "clawd-idle-yawn.svg", "shy.svg", "nested/look.svg", "missing.svg", "shy.svg"].map((file) => ({ file, duration: 6500 })),
  };
  const assets = toAssetMap(theme, (file) => file === "missing.svg" ? null : `asset:${file}`);
  assert.deepEqual(idleAnimationPool(theme, assets), [
    { file: "neutral.svg", duration: 6500 }, { file: "shy.svg", duration: 6500 }, { file: "look.svg", duration: 6500 },
  ]);
});

test("idle metadata sanitizes durations and tolerates absent or malformed entries", () => {
  assert.deepEqual(idleAnimationPool(null, {}), []);
  assert.deepEqual(idleAnimationPool({}, {}), []);
  const theme = { idleAnimations: [null, "look.svg", {}, { file: "" },
    { file: "look.svg", duration: 999999 }, { file: "stretch.svg", duration: -10 }, { file: "shy.svg", duration: "slow" }] };
  assert.deepEqual(idleAnimationPool(theme, { "look.svg": "a", "stretch.svg": "b", "shy.svg": "c" }), [
    { file: "look.svg", duration: 8000 }, { file: "stretch.svg", duration: 1000 }, { file: "shy.svg", duration: 4500 },
  ]);
});

test("every built-in theme has a mapped leisure pool without working or status assets", () => {
  for (const id of ["clawd", "calico", "neobjuk"]) {
    const theme = require(`../vendor/clawd/themes/${id}/theme.json`);
    const pool = idleAnimationPool(theme, toAssetMap(theme, (file) => `asset:${file}`));
    assert.ok(pool.length, `${id} has leisure reactions`);
    assert.equal(pool.length, theme.idleAnimations.length, `${id} metadata contains only leisure assets`);
  }
});
