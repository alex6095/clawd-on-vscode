"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { collectThemeFiles, toAssetMap } = require("../src/asset-map");

test("collectThemeFiles includes states, tiers, hints, mini states, and reactions", () => {
  const files = collectThemeFiles({
    states: {
      idle: ["idle.svg"],
      working: ["typing.svg"],
    },
    miniMode: {
      states: {
        "mini-idle": ["mini-idle.svg"],
      },
    },
    workingTiers: [{ minSessions: 2, file: "building.svg" }],
    jugglingTiers: [{ minSessions: 1, file: "juggling.svg" }],
    idleAnimations: [{ file: "reading.svg", duration: 1000 }],
    reactions: {
      clickLeft: { file: "left.svg" },
      double: { files: ["double.svg", "jump.svg"] },
    },
    displayHintMap: {
      "clawd-working-typing.svg": "typing-themed.svg",
    },
  });

  assert.deepEqual([...files].sort(), [
    "building.svg",
    "double.svg",
    "idle.svg",
    "juggling.svg",
    "jump.svg",
    "left.svg",
    "mini-idle.svg",
    "reading.svg",
    "typing-themed.svg",
    "typing.svg",
  ]);
});

test("toAssetMap resolves every collected theme file by basename", () => {
  const map = toAssetMap({
    states: {
      idle: ["nested/idle.svg"],
      working: ["typing.svg"],
    },
  }, (filename) => `vscode-resource:${filename}`);

  assert.equal(map["idle.svg"], "vscode-resource:idle.svg");
  assert.equal(map["typing.svg"], "vscode-resource:typing.svg");
});
