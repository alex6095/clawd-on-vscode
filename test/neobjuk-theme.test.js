"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { parseDocument } = require("htmlparser2");
const { assets, makeTheme, ANATOMY, ARM_MOTIONS, headPath, tPosePath } = require("../scripts/generate-neobjuk");
const { collectThemeFiles } = require("../src/asset-map");
const loader = require("../vendor/clawd/src/theme-loader");

const root = path.join(__dirname, "..", "vendor", "clawd", "themes", "neobjuk");

function descendants(node) {
  return (node.children || []).flatMap((child) => [child, ...descendants(child)]);
}

function nodesFor(id) {
  return descendants(parseDocument(assets.find((asset) => asset.id === id).svg, { xmlMode: true }));
}

// Sample the actual cubic outlines so attachment checks exercise the geometry,
// rather than relying only on labels in the generated SVG.
function contour(d) {
  const tokens = d.match(/[MLHVQCZ]|[-+]?(?:\d*\.)?\d+/g);
  const points = [];
  let index = 0, command, current = [0, 0], start;
  const number = () => Number(tokens[index++]);
  const point = () => [number(), number()];
  while (index < tokens.length) {
    if (/^[A-Z]$/.test(tokens[index])) command = tokens[index++];
    if (command === "Z") {
      points.push(start); current = start; command = null; continue;
    }
    if (command === "M" || command === "L") {
      current = point(); points.push(current);
      if (command === "M") { start = current; command = "L"; }
    } else if (command === "H") {
      current = [number(), current[1]]; points.push(current);
    } else if (command === "V") {
      current = [current[0], number()]; points.push(current);
    } else if (command === "C" || command === "Q") {
      const origin = current, first = point(), second = command === "C" ? point() : null, end = point();
      for (let sample = 1; sample <= 24; sample++) {
        const t = sample / 24, u = 1 - t;
        points.push(command === "C"
          ? [0, 1].map((axis) => u ** 3 * origin[axis] + 3 * u ** 2 * t * first[axis] + 3 * u * t ** 2 * second[axis] + t ** 3 * end[axis])
          : [0, 1].map((axis) => u ** 2 * origin[axis] + 2 * u * t * first[axis] + t ** 2 * end[axis]));
      }
      current = end;
    } else throw new Error(`Unsupported contour command: ${command}`);
  }
  return points;
}

function bounds(points) {
  return {
    left: Math.min(...points.map(([x]) => x)), right: Math.max(...points.map(([x]) => x)),
    top: Math.min(...points.map(([, y]) => y)), bottom: Math.max(...points.map(([, y]) => y)),
  };
}

function contains(points, [x, y]) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i], [xj, yj] = points[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function ancestor(node, part) {
  while (node && node.attribs?.["data-part"] !== part) node = node.parent;
  return node;
}

function rotate([x, y], degrees, [cx, cy]) {
  const angle = degrees * Math.PI / 180;
  return [cx + (x - cx) * Math.cos(angle) - (y - cy) * Math.sin(angle), cy + (x - cx) * Math.sin(angle) + (y - cy) * Math.cos(angle)];
}

test("Neobjuk is discovered as the third built-in theme and loads every runtime state", () => {
  loader.init(path.join(__dirname, "..", "vendor", "clawd", "src"));
  assert.deepEqual(loader.discoverThemes().filter((theme) => theme.builtin).map((theme) => theme.id).sort(), ["calico", "clawd", "neobjuk"]);
  const theme = loader.loadTheme("neobjuk", { strict: true });
  assert.equal(theme._id, "neobjuk");
  assert.equal(theme.sleepSequence.mode, "full");
  for (const state of ["idle", "thinking", "working", "juggling", "attention", "notification", "error", "sweeping", "carrying", "yawning", "dozing", "collapsing", "sleeping", "waking"]) {
    assert.ok(theme.states[state].length, `${state} has an animation`);
  }
  const files = collectThemeFiles(theme);
  assert.equal(files.size, 21);
  for (const file of files) assert.ok(fs.existsSync(loader.getAssetPath(file)), file);
});

test("all 17 reference expressions are accessible from preview states and variant metadata", () => {
  const theme = makeTheme();
  const expressions = assets.filter((asset) => asset.canonical);
  assert.equal(expressions.length, 17);
  assert.equal(Object.keys(theme.variants).length, 17);
  for (const asset of expressions) {
    assert.deepEqual(theme.states[`pose-${asset.id}`], [asset.file]);
    const variant = theme.variants[asset.id === "neutral" ? "default" : asset.id];
    assert.equal(variant.preview, asset.file);
    assert.ok(variant.name.startsWith("넙죽이"));
  }
});

test("generated SVGs share a stable canvas and retain outlines without inline styles", () => {
  for (const asset of assets) {
    const file = fs.readFileSync(path.join(root, "assets", asset.file), "utf8").replace(/\r\n/g, "\n");
    assert.equal(file, asset.svg, `${asset.file} matches editable generator source`);
    const nodes = descendants(parseDocument(file, { xmlMode: true }));
    const svg = nodes.find((node) => node.name === "svg");
    assert.equal(svg.attribs.viewBox, "0 0 240 240");
    assert.equal(svg.attribs.width, "240");
    assert.equal(svg.attribs.height, "240");
    for (const node of nodes.filter((node) => node.name === "path" && node.attribs.class === "nb-ink")) {
      assert.equal(node.attribs.stroke, node.attribs.fill === "#050607" ? "#536273" : "#151b22", `${asset.file} keeps structural outlines black and the black heart visible on dark backgrounds`);
      assert.equal(node.attribs["stroke-width"], "1.8");
    }
    assert.ok(nodes.some((node) => node.name === "style"), "animation CSS is present");
    assert.ok(!nodes.some((node) => ["script", "foreignObject", "image"].includes(node.name)), "no external assets or scripts");
    assert.ok(!nodes.some((node) => node.attribs && node.attribs.style), "no inline style attributes blocked by webview CSP");
    assert.ok(file.includes("KAIST"));
  }
});

test("every expression retains the reference head and canonical high shoulder anatomy", () => {
  const neutral = nodesFor("neutral");
  const body = neutral.find((node) => node.attribs?.["data-part"] === "continuous-t-pose");
  assert.equal(body.attribs.d, tPosePath);
  assert.ok(!neutral.some((node) => node.attribs?.["data-arm-root"]), "neutral arms and body are one uninterrupted contour");
  const bodyPoints = contour(body.attribs.d), headPoints = contour(headPath);
  for (const joint of [ANATOMY.leftShoulder, ANATOMY.rightShoulder, [120, 139]]) {
    assert.ok(contains(bodyPoints, joint), `canonical shoulder/neck ${joint} lies inside the body`);
  }
  assert.ok(contains(headPoints, [120, 139]), "head and body overlap at the neck without a visible stalk");
  const headSize = bounds(headPoints);
  assert.ok((headSize.right - headSize.left) / (headSize.bottom - headSize.top) > 1.85, "head remains broad and relatively shallow");
  assert.ok(ANATOMY.leftShoulder[1] - headSize.bottom <= 3, "arms begin directly underneath the head");
  const whiteEyes = neutral.filter((node) => node.name === "circle" && node.parent?.attribs?.fill === "white");
  assert.deepEqual(whiteEyes.map((node) => [Number(node.attribs.cx), Number(node.attribs.cy), Number(node.attribs.r)]), [[88, 97, 13], [149, 97, 13]]);
  for (const asset of assets) {
    const outlines = nodesFor(asset.id).filter((node) => node.attribs?.["data-part"] === "head-outline");
    assert.equal(outlines.length, 1, `${asset.file} has one consistent head`);
    assert.equal(outlines[0].attribs.d, headPath, `${asset.file} transforms the canonical head instead of reshaping it`);
  }
});

test("all arm roots remain inside a connected torso throughout their animated arcs", () => {
  for (const asset of assets) {
    const nodes = nodesFor(asset.id);
    for (const arm of nodes.filter((node) => node.attribs?.["data-arm-root"])) {
      const rootPoint = arm.attribs["data-arm-root"].split(" ").map(Number);
      const rig = ancestor(arm, "character-rig");
      const torso = descendants(rig).find((node) => ["torso", "seated-torso", "lying-torso"].includes(node.attribs?.["data-part"]));
      assert.ok(contains(contour(torso.attribs.d), rootPoint), `${asset.file} arm joint is inside its torso`);
      const cap = arm.children.find((node) => node.name === "circle");
      assert.deepEqual([Number(cap.attribs.cx), Number(cap.attribs.cy)], rootPoint);
      assert.ok(Number(cap.attribs.r) >= 8, `${asset.file} has a broad overlapping root cap`);
      const edge = arm.children.find((node) => node.name === "path" && node.attribs.fill === "none");
      assert.ok(!edge.attribs.d.endsWith("Z"), "arm seam has no closing outline across its joint");
      const motionName = arm.attribs["data-arm-motion"];
      if (!motionName) continue;
      const motion = ARM_MOTIONS[motionName];
      const css = new RegExp(`\\.${motionName}\\{([^}]+)\\}`).exec(asset.svg)[1];
      const origin = /transform-origin:(\d+)px (\d+)px/.exec(css).slice(1).map(Number);
      assert.deepEqual(origin, rootPoint, `${asset.file} CSS pivots at the actual shoulder`);
      assert.ok(css.includes(`animation:${motionName}-move `));
      const frames = new RegExp(`@keyframes ${motionName}-move\\{(.+?)\\}\\}`).exec(asset.svg)[1];
      assert.ok(!frames.includes("translate") && !frames.includes("scale"), "limb motion cannot move its root off the body");
      for (const degrees of [0, motion.degrees]) {
        const transformed = rotate(rootPoint, degrees, origin);
        assert.ok(Math.hypot(transformed[0] - rootPoint[0], transformed[1] - rootPoint[1]) < .001);
      }
    }
  }
});

test("lying poses attach their compact arms and neck at transformed canonical joints", () => {
  const lyingPoint = (point) => rotate(point, -46, [120, 97]).map((value, axis) => value + [-27, 54][axis]);
  for (const id of ["sleeping", "loving-sleep", "tilted-heart"]) {
    const nodes = nodesFor(id);
    const body = nodes.find((node) => node.attribs?.["data-part"] === "lying-torso");
    const neck = body.attribs["data-neck"].split(" ").map(Number);
    const expectedNeck = lyingPoint(ANATOMY.neck);
    assert.ok(Math.hypot(neck[0] - expectedNeck[0], neck[1] - expectedNeck[1]) < .3);
    const arm = nodes.find((node) => node.attribs?.["data-arm-root"]);
    const rootPoint = arm.attribs["data-arm-root"].split(" ").map(Number);
    const expectedShoulder = lyingPoint(ANATOMY.rightShoulder);
    assert.ok(Math.hypot(rootPoint[0] - expectedShoulder[0], rootPoint[1] - expectedShoulder[1]) < .3, "lying arm begins beside the head at shoulder height");
    const armShape = arm.children.find((node) => node.name === "path" && node.attribs.fill !== "none");
    const armBounds = bounds(contour(armShape.attribs.d));
    assert.ok(armBounds.right - armBounds.left < 38, "lying arm is a compact paddle");
    const head = nodes.find((node) => node.attribs?.["data-part"] === "head");
    assert.equal(head.parent.attribs.transform, "translate(-27 54) rotate(-46 120 97)");
    assert.ok(!head.parent.attribs.class, "static lying transform cannot be replaced by a CSS head animation");
  }
});

test("reference seated and accessory silhouettes retain their distinctive rounded proportions", () => {
  for (const id of ["sad", "seated-heart", "crying"]) {
    const nodes = nodesFor(id);
    const near = nodes.find((node) => node.attribs?.["data-part"] === "foreground-folded-leg");
    const far = nodes.find((node) => node.attribs?.["data-part"] === "far-folded-knee");
    const nearBounds = bounds(contour(near.attribs.d)), farBounds = bounds(contour(far.attribs.d));
    assert.ok(nearBounds.bottom - nearBounds.top >= 23, `${id} foreground leg stays rounded rather than a flat bow`);
    assert.ok(farBounds.bottom - farBounds.top >= 25, `${id} far knee is visibly bent`);
    const translation = /translate\([-\d]+ (\d+)\)/.exec(ancestor(near, "character-rig").attribs.transform);
    assert.ok(Math.abs(nearBounds.bottom + Number(translation[1]) - ANATOMY.floorY) < 3, `${id} keeps the common floor`);
  }
  const cool = nodesFor("cool");
  const crossed = cool.filter((node) => node.attribs?.["data-arm-root"]).flatMap((node) => contour(node.children.find((child) => child.name === "path" && child.attribs.fill !== "none").attribs.d));
  const crossedBounds = bounds(crossed);
  assert.ok(crossedBounds.right - crossedBounds.left >= 80, "crossed forearms are broad rounded paddles");
  const coffeeCup = nodesFor("coffee").find((node) => node.attribs?.["data-part"] === "coffee-cup");
  const cupBounds = bounds(contour(coffeeCup.attribs.d));
  assert.ok(cupBounds.bottom - cupBounds.top >= 55, "coffee cup reaches chest height");
  const star = nodesFor("rainbow").find((node) => node.attribs?.["data-part"] === "rim-star");
  assert.ok(ancestor(star, "head"), "celebratory star follows the head rim through the pose animation");
});

test("character artwork attribution retains KAIST rights and points to asset license", () => {
  const theme = JSON.parse(fs.readFileSync(path.join(root, "theme.json"), "utf8"));
  assert.equal(theme.attribution.rightsHolder, "KAIST");
  assert.match(theme.license, /ASSETS-LICENSE/);
  assert.match(theme.license, /excluded/);
});
