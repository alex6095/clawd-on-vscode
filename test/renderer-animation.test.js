"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { parseDocument } = require("htmlparser2");

// A small DOM harness exercises the actual webview script and deferred fetch
// ordering. Actual SVG/CSP rendering is additionally checked in VS Code.
class Element {
  constructor(tag, document) {
    this.tagName = tag;
    this.ownerDocument = document;
    this.children = [];
    this.parentNode = null;
    this.attrs = new Map();
    this.dataset = {};
    this.events = {};
    this.styles = new Map();
    this.style = { setProperty: (key, value) => this.styles.set(key, value) };
    this.classList = {
      contains: (name) => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(" "); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter((name) => !names.includes(name)).join(" "); },
      toggle: (name, value) => {
        const enabled = value === undefined ? !this.classList.contains(name) : value;
        if (enabled) this.classList.add(name); else this.classList.remove(name);
        return enabled;
      },
    };
  }
  get id() { return this.attrs.get("id") || ""; }
  set id(value) { this.attrs.set("id", value); }
  set src(uri) {
    this.attrs.set("src", uri);
    if (this.tagName !== "img" || typeof this.onload !== "function") return;
    this.ownerDocument.images.push({ uri, element: this, resolve: () => {
      this.complete = true; this.naturalWidth = 266; this.naturalHeight = 200; this.onload();
    } });
  }
  get className() { return this.attrs.get("class") || ""; }
  set className(value) { this.attrs.set("class", value); }
  get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); }
  get childElementCount() { return this.children.length; }
  get isConnected() { return !!this.root || !!(this.parentNode && this.parentNode.isConnected); }
  get textContent() { return this.text || this.children.map((child) => child.textContent).join(""); }
  set textContent(text) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.text = String(text);
  }
  set innerHTML(text) {
    this.textContent = "";
    const build = (parsed) => {
      const node = new Element(parsed.name || "#text", this.ownerDocument);
      for (const [name, value] of Object.entries(parsed.attribs || {})) node.setAttribute(name, value);
      if (parsed.type === "text") node.text = parsed.data;
      for (const child of parsed.children || []) node.appendChild(build(child));
      return node;
    };
    for (const parsed of parseDocument(text, { xmlMode: true }).children) this.appendChild(build(parsed));
  }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  getAttribute(name) { return this.attrs.get(name) || null; }
  removeAttribute(name) { this.attrs.delete(name); }
  append(...nodes) { for (const node of nodes) this.appendChild(node); }
  appendChild(node) { node.remove(); node.parentNode = this; this.children.push(node); return node; }
  insertBefore(node, sibling) {
    node.remove(); node.parentNode = this;
    this.children.splice(this.children.indexOf(sibling), 0, node);
  }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((node) => node !== this);
    this.parentNode = null;
  }
  replaceWith(node) { const parent = this.parentNode; parent.insertBefore(node, this); this.remove(); }
  addEventListener(name, callback) { this.events[name] = callback; }
  closest(selector) { return this.matches(selector) ? this : this.parentNode && this.parentNode.closest(selector); }
  getElementById(id) { return this.querySelectorAll("*").find((node) => node.id === id) || null; }
  matches(selector) {
    if (selector === "*") return true;
    if (selector === "[id]") return !!this.id;
    if (selector.startsWith(".")) return selector.slice(1).split(".").every((name) => this.classList.contains(name));
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }
  querySelectorAll(selector) {
    return this.children.flatMap((node) => [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getBoundingClientRect() {
    if (this.id === "petStage") return { left: 0, top: 0, right: 260, bottom: 200, width: 260, height: 200 };
    const width = parseFloat(this.styles.get("--pet-width")) || 180;
    const height = parseFloat(this.styles.get("--pet-height")) || 180;
    const left = parseFloat(this.styles.get("--pet-left")) || 0;
    const top = 200 - height - (parseFloat(this.styles.get("--pet-bottom")) || 0);
    return { left, top, width, height, right: left + width, bottom: top + height };
  }
  getContext() { return { drawImage: (img) => this.ownerDocument.drawings.push(img) }; }
  setPointerCapture() {}
  releasePointerCapture() {}
  hasPointerCapture() { return false; }
}

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240"><defs><style>#pupil{animation:blink 5s infinite}</style><linearGradient id="blue"><stop stop-color="#3ac"/></linearGradient></defs><path fill="url(#blue)" d="M0 0H2V2Z"/><g id="pupil"/></svg>`;

function webviewHtml() {
  const module = { exports: {} };
  const mockedVscode = { Uri: { joinPath: (...parts) => parts.join("/") } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "src", "view-provider.js"), "utf8"), {
    module,
    require: (id) => id === "vscode" ? mockedVscode : require(id),
  });
  return module.exports.ClawdViewProvider.prototype.getHtml.call({ context: { extensionUri: "extension" } }, {
    cspSource: "test-resource:", asWebviewUri: (uri) => uri,
  });
}

function harness(options = {}) {
  const document = { hidden: false, events: {}, images: [], drawings: [], currentScript: { nonce: "svg-regression-nonce" } };
  document.createElement = (tag) => new Element(tag, document);
  document.createElementNS = (_, tag) => new Element(tag, document);
  document.createTextNode = (text) => { const node = new Element("#text", document); node.text = text; return node; };
  document.addEventListener = (type, callback) => { document.events[type] = callback; };
  document.body = new Element("body", document);
  document.body.root = true;
  document.body.innerHTML = webviewHtml().match(/<body>([\s\S]*?)<script/)[1];
  const elements = Object.fromEntries(document.body.querySelectorAll("[id]").map((node) => [node.id, node]));
  document.getElementById = (id) => elements[id];
  const messages = [], fetches = [], timers = new Map(), frames = new Map();
  let sequence = 0, now = 0;
  const randomValues = [...(options.randomValues || [])];
  const deterministicMath = Object.create(Math);
  deterministicMath.random = () => randomValues.length ? randomValues.shift() : 0;
  const motion = { matches: !!options.systemReduced, events: {}, addEventListener(type, callback) { this.events[type] = callback; } };
  const context = vm.createContext({
    document, window: { addEventListener() {}, CSS: { escape: (value) => value }, matchMedia: () => motion },
    acquireVsCodeApi: () => ({ postMessage: (message) => messages.push(message) }),
    ResizeObserver: class { observe() {} },
    setTimeout: (callback, delay) => { const id = ++sequence; timers.set(id, { callback, delay, due: now + delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    requestAnimationFrame: (callback) => { const id = ++sequence; frames.set(id, callback); return id; },
    cancelAnimationFrame: (id) => frames.delete(id),
    fetch: (uri) => new Promise((resolve, reject) => fetches.push({ uri, resolve: () => resolve({ ok: true, text: async () => SVG }), reject })),
    console, URL, Math: deterministicMath,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "media", "clawd.js"), "utf8"), context);
  const config = { assetMap: { "idle.svg": "asset:idle", "working.svg": "asset:working", "happy.svg": "asset:happy" }, idleFollowSvg: "idle.svg", eyeTrackingStates: [], viewBox: { x: 0, y: 0, width: 240, height: 240 } };
  return {
    context, elements, messages, fetches, timers, frames, config, motion,
    init: (extra = {}) => context.applyInit({ config, themeId: "neobjuk", themes: [{ id: "clawd" }, { id: "calico" }, { id: "neobjuk" }], state: "idle", svg: "idle.svg", serverPort: 3123, ...extra }),
    send: (type, payload) => context.handleMessage({ data: { type, payload } }),
    current: () => elements.petContainer.children.find((node) => node.classList.contains("pet-asset") && !node.classList.contains("is-retiring")),
    runTimer: (delay) => {
      for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.callback(); }
    },
    advance: async (elapsed) => {
      const target = now + elapsed;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.due <= target).sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
        if (!next) break;
        now = next[1].due;
        timers.delete(next[0]);
        next[1].callback();
        await flush();
      }
      now = target;
      await flush();
    },
    randomValues,
  };
}

async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
async function ready(h) { h.init(); h.fetches[0].resolve(); await flush(); }

test("same pending animation is fetched once and never invalidates its own render", async () => {
  const h = harness();
  h.init();
  const duplicate = h.context.renderPet("idle.svg", "idle");
  assert.equal(h.fetches.length, 1);
  h.fetches[0].resolve();
  await duplicate; await flush();
  assert.equal(h.current().dataset.file, "idle.svg");
  assert.ok(h.current().querySelector("svg"));
});

test("replacement keeps current pet visible and only the most recent load is published", async () => {
  const h = harness(); await ready(h);
  const slow = h.context.renderPet("working.svg", "working");
  assert.equal(h.current().dataset.file, "idle.svg");
  const fast = h.context.renderPet("happy.svg", "attention");
  h.fetches[2].resolve(); await fast;
  assert.equal(h.current().dataset.file, "happy.svg");
  h.fetches[1].resolve(); await slow;
  assert.equal(h.current().dataset.file, "happy.svg");
});

test("SVG style gets the webview nonce and crossfade definitions have unique IDs", async () => {
  const h = harness(); await ready(h);
  const old = h.current();
  assert.equal(old.querySelector("style").getAttribute("nonce"), "svg-regression-nonce");
  const next = h.context.renderPet("working.svg", "working");
  h.fetches[1].resolve(); await next;
  const oldId = old.querySelector("linearGradient").id;
  const newId = h.current().querySelector("linearGradient").id;
  assert.notEqual(oldId, newId);
  assert.equal(h.current().querySelector("path").getAttribute("fill"), `url(#${newId})`);
  assert.match(h.current().querySelector("style").textContent, /#pet-\d+-pupil/);
});

test("failed replacement preserves the rendered pet", async () => {
  const h = harness(); await ready(h);
  const next = h.context.renderPet("working.svg", "working");
  h.fetches[1].reject(new Error("Resource unavailable")); await next;
  assert.equal(h.current().dataset.file, "idle.svg");
});

test("preview restores the latest runtime state while session updates remain live", async () => {
  const h = harness(); await ready(h);
  h.send("preview-animation", { svg: "happy.svg", state: "pose-shy", duration: 6000 });
  h.fetches[1].resolve(); await flush();
  h.send("state-change", { state: "working", svg: "working.svg", sessions: [{ id: "session-42", state: "working", agentId: "codex" }] });
  assert.equal(h.current().dataset.file, "happy.svg");
  assert.equal(h.elements.sessions.querySelector(".session-row").dataset.sessionId, "session-42");
  h.runTimer(6000); h.fetches[2].resolve(); await flush();
  assert.equal(h.current().dataset.file, "working.svg");
  assert.equal(h.elements.activityLabel.textContent, "At work");
});

test("hidden views defer new assets and resume the latest runtime animation", async () => {
  const h = harness(); await ready(h);
  h.send("visibility-change", { visible: false });
  h.send("state-change", { state: "working", svg: "working.svg" });
  assert.equal(h.fetches.length, 1);
  assert.ok(h.context.document.body.classList.contains("is-view-hidden"));
  h.send("visibility-change", { visible: true });
  h.fetches[1].resolve(); await flush();
  assert.equal(h.current().dataset.file, "working.svg");
  assert.ok(!h.context.document.body.classList.contains("is-view-hidden"));
});

test("explicit motion preferences override the system and settle pupil tracking", async () => {
  const h = harness();
  h.config.reducedMotion = "off";
  await ready(h);
  assert.ok(h.current().querySelector("svg").attributes.some((attr) => attr.name === "data-force-motion"));
  h.config.reducedMotion = "on";
  h.context.updateMotionPreference();
  assert.ok(h.context.document.body.classList.contains("is-reduced-motion"));
  assert.equal(h.current().querySelector("svg").getAttribute("data-force-motion"), null);
  assert.equal(h.frames.size, 0);
});

test("session click and keyboard focus use the selected session ID", () => {
  const h = harness();
  const row = h.context.makeSessionRow({ id: "session-42", state: "working", agentId: "codex", title: "Specific terminal" });
  row.events.click({});
  assert.equal(h.messages.at(-1).sessionId, "session-42");
  row.events.keydown({ key: "Enter", preventDefault() {} });
  assert.equal(h.messages.at(-1).type, "focus-terminal");
  assert.equal(h.messages.at(-1).sessionId, "session-42");
});

test("theme changes render the chosen character without a duplicate character control", async () => {
  const h = harness();
  await ready(h);
  h.send("theme-config", { themeId: "calico", config: { ...h.config, assetMap: { "idle.svg": "asset:calico" } }, svg: "idle.svg" });
  h.fetches[1].resolve(); await flush();
  assert.equal(h.context.document.body.dataset.theme, "calico");
  assert.equal(h.fetches[1].uri, "asset:calico");
  assert.equal(h.elements.themeBtn, undefined);
});

test("the webview contains only the pet, activity, approvals and sessions", () => {
  const h = harness();
  assert.equal(h.context.document.body.querySelector(".toolbar"), null);
  assert.equal(h.context.document.body.querySelectorAll("button").length, 0);
  assert.equal(h.context.document.body.querySelector(".pet-shadow"), null);
  assert.equal(h.elements.serverLabel, undefined);
  assert.equal(h.elements.stateLabel, undefined);
  assert.equal(h.elements.activityLabel.textContent, "Waking up…");
  assert.equal(h.elements.toastLog.textContent, "");
});

test("the title bar offers one character chooser and one meaningful pause or resume action", () => {
  const manifest = require("../package.json");
  const menu = manifest.contributes.menus["view/title"];
  const activeItems = (paused, enabled, dnd = false) => menu.filter((item) => vm.runInNewContext(item.when.replace(/\bclawd\.petView\b/g, '"clawd.petView"'), {
    view: "clawd.petView", clawd: { runtime: { paused }, integrations: { enabled }, dnd },
  }));
  for (const [paused, enabled, action] of [[false, true, "clawd.pauseRuntime"], [true, true, "clawd.resumeRuntime"], [false, false, "clawd.resumeRuntime"], [true, false, "clawd.resumeRuntime"]]) {
    const primary = activeItems(paused, enabled).filter((item) => item.group.startsWith("navigation"));
    assert.deepEqual(primary.map((item) => item.command), ["clawd.setTheme", action]);
  }
  for (const [quiet, command] of [[false, "clawd.muteNotifications"], [true, "clawd.unmuteNotifications"]]) {
    const notificationActions = activeItems(false, true, quiet).filter((item) => item.group.startsWith("1_activity"));
    assert.deepEqual(notificationActions.map((item) => item.command), [command]);
  }
  const ids = new Set(manifest.contributes.commands.map((command) => command.command));
  for (const item of menu) assert.ok(ids.has(item.command), `${item.command} is contributed`);
  for (const command of ["clawd.disableIntegrations", "clawd.enableIntegrations", "clawd.toggleDnd"]) {
    assert.ok(!menu.some((item) => item.command === command));
    assert.equal(manifest.contributes.menus.commandPalette.find((item) => item.command === command).when, "false");
  }
});

test("activity distinguishes starting, interrupted, resumed, paused and quiet notifications", () => {
  const h = harness();
  h.init({ connectionState: "starting", serverPort: null });
  assert.equal(h.elements.activityLabel.textContent, "Waking up…");
  h.send("runtime-status", { connectionState: "disconnected" });
  assert.equal(h.elements.activityLabel.textContent, "Connection interrupted");
  assert.match(h.elements.activityNote.textContent, /Agent Connection Status/);
  h.send("state-change", { state: "working" });
  assert.equal(h.elements.activityLabel.textContent, "At work");
  assert.equal(h.elements.activityNote.hidden, true);
  h.send("dnd-change", { enabled: true });
  assert.match(h.elements.activityNote.textContent, /Quiet notifications/);
  h.init({ paused: true, dnd: true });
  assert.equal(h.elements.activityLabel.textContent, "Paused");
  assert.match(h.elements.activityNote.textContent, /Resume Clawd/);
  h.init({ integrationsEnabled: false });
  assert.equal(h.elements.activityLabel.textContent, "Paused");
  h.init({ connectionState: "connected" });
  assert.equal(h.elements.activityLabel.textContent, "Ready when you are");
  assert.equal(h.elements.activityNote.hidden, true);
  assert.ok(!h.context.document.body.textContent.includes(":3123"));
});

test("approvals remain actionable and update the humane activity label", () => {
  const h = harness();
  h.init();
  h.send("permission-show", { id: "approval-1", agentId: "claude-code", toolName: "Bash", toolInput: { command: "npm test" }, suggestions: [] });
  const card = h.elements.permissions.querySelector(".permission-card");
  assert.equal(h.elements.activityLabel.textContent, "Needs your approval");
  assert.ok(card.textContent.includes("npm test"));
  const allow = card.querySelectorAll("button").find((button) => button.textContent === "Allow");
  assert.ok(allow);
  allow.events.click({ currentTarget: allow });
  assert.equal(h.messages.at(-1).type, "permission-decide");
  assert.equal(h.messages.at(-1).id, "approval-1");
  assert.equal(h.messages.at(-1).behavior, "allow");
  const terminal = card.querySelectorAll("button").find((button) => button.textContent === "Terminal");
  assert.ok(terminal);
  terminal.events.click({ currentTarget: terminal });
  assert.equal(h.messages.at(-1).behavior, "deny-and-focus");
  h.send("permission-hide", { id: "approval-1" });
  assert.equal(h.elements.permissions.children.length, 0);
  assert.equal(h.elements.activityLabel.textContent, "Ready when you are");
});

test("shell approvals show the description once and retain meaningful execution flags", () => {
  const h = harness();
  h.init();
  for (const toolName of ["Bash", "PowerShell"]) {
    h.send("permission-show", { id: "shell-approval", agentId: "claude-code", toolName, toolInput: {
      command: "npm test", description: "Run the extension tests", timeout: 120000, run_in_background: true,
      dangerouslyDisableSandbox: true, cwd: "/workspace/extension",
    }, suggestions: [] });
    const card = h.elements.permissions.querySelector(".permission-card");
    assert.equal(card.querySelector(".permission-subtitle").textContent, "Run the extension tests");
    const body = card.querySelector(".permission-body");
    const promoted = body.children.filter((child) => !child.classList.contains("permission-raw")).map((child) => child.textContent).join(" ");
    assert.ok(!promoted.includes("Run the extension tests"));
    assert.ok(!body.querySelectorAll(".meta-label").some((label) => ["Shell", "Description"].includes(label.textContent)));
    assert.match(promoted, /npm test/);
    assert.match(promoted, /120000 ms/);
    assert.match(promoted, /BackgroundYes/);
    assert.match(promoted, /Directoryextension/);
    assert.match(promoted, /outside the sandbox/);
    assert.ok(card.querySelector(".permission-raw").textContent.includes("Run the extension tests"));
    h.send("permission-hide", { id: "shell-approval" });
  }
  h.send("permission-show", { id: "simple-shell", toolName: "Bash", toolInput: { command: "npm test", description: "Run the extension tests" }, suggestions: [] });
  assert.equal(h.elements.permissions.querySelector(".permission-meta"), null);
});

test("unavailable pets are truthful and cannot click, focus or drag", async () => {
  const h = harness();
  const stage = h.elements.petStage;
  assert.equal(stage.tabIndex, -1);
  assert.equal(stage.getAttribute("aria-disabled"), "true");
  assert.match(stage.getAttribute("aria-label"), /Waking up/);
  await ready(h);
  for (const [snapshot, label] of [
    [{ paused: true }, "Paused"],
    [{ integrationsEnabled: false }, "Paused"],
    [{ connectionState: "disconnected" }, "Connection interrupted"],
    [{ connectionState: "starting" }, "Waking up"],
  ]) {
    h.init(snapshot); await flush();
    assert.equal(stage.tabIndex, -1);
    assert.equal(stage.getAttribute("aria-disabled"), "true");
    assert.ok(stage.getAttribute("aria-label").includes(label));
    assert.ok(!/Click|Press Enter|terminal/.test(stage.getAttribute("aria-label")));
    const before = h.messages.length;
    const fetches = h.fetches.length;
    const event = { clientX: 130, clientY: 90, pointerId: 1, pointerType: "mouse", button: 0, detail: 1, preventDefault() {} };
    stage.events.click(event);
    for (const key of ["Enter", " "]) stage.events.keydown({ key, preventDefault() {} });
    stage.events.pointerdown(event);
    stage.events.pointermove({ ...event, clientX: 160 });
    stage.events.pointerup({ ...event, clientX: 160 });
    assert.equal(h.messages.length, before);
    assert.equal(h.fetches.length, fetches);
    assert.equal(stage.classList.contains("is-dragging"), false);
  }
  h.send("preview-animation", { state: "pose-shy", svg: "happy.svg", duration: 6000 });
  h.fetches[1].resolve(); await flush();
  assert.equal(h.current().dataset.file, "happy.svg");
  assert.match(stage.getAttribute("aria-label"), /Previewing shy/);
  assert.equal(stage.getAttribute("aria-disabled"), "true");
});

test("cached assets restore accessible pet click and keyboard behavior on reconnect", async () => {
  const h = harness(); await ready(h);
  const stage = h.elements.petStage;
  const wrapper = h.current();
  const event = { clientX: 130, clientY: 90, pointerId: 1, pointerType: "mouse", button: 0, detail: 1, preventDefault() {} };
  stage.events.pointerdown(event);
  stage.events.pointermove({ ...event, clientX: 160 });
  assert.equal(stage.classList.contains("is-dragging"), true);
  h.send("runtime-status", { connectionState: "disconnected" });
  assert.equal(stage.classList.contains("is-dragging"), false);
  assert.equal(stage.tabIndex, -1);
  await h.context.renderPet("idle.svg", "idle");
  assert.match(stage.getAttribute("aria-label"), /Connection interrupted/);
  h.send("state-change", { state: "idle", svg: "idle.svg" });
  await flush();
  assert.equal(h.current(), wrapper);
  assert.equal(h.fetches.length, 1);
  assert.equal(stage.tabIndex, 0);
  assert.equal(stage.getAttribute("aria-disabled"), "false");
  assert.match(stage.getAttribute("aria-label"), /Click for a reaction/);
  assert.match(stage.getAttribute("aria-label"), /Press Enter or Space/);
  stage.events.click(event);
  assert.equal(h.messages.at(-1).type, "focus-terminal");
  const beforeKeyboard = h.messages.length;
  for (const key of ["Enter", " "]) stage.events.keydown({ key, preventDefault() {} });
  assert.equal(h.messages.length, beforeKeyboard + 2);
  assert.equal(h.messages.at(-1).type, "focus-terminal");
});

test("an enabled idle pet click plays its configured reaction without a status helper exception", async () => {
  const h = harness();
  h.config.reactions = { clickLeft: { file: "happy.svg", duration: 2500 } };
  await ready(h);
  const before = h.messages.length;
  h.elements.petStage.events.click({ clientX: 100, clientY: 90, detail: 1, preventDefault() {} });
  h.fetches[1].resolve(); await flush();
  assert.equal(h.current().dataset.file, "happy.svg");
  assert.equal(h.messages.length, before);
  h.runTimer(2500); await flush();
  assert.equal(h.current().dataset.file, "idle.svg");
});

function withIdlePool(options) {
  const h = harness(options);
  Object.assign(h.config.assetMap, { "glance.svg": "asset:glance", "stretch.svg": "asset:stretch" });
  h.config.idleAnimations = [{ file: "glance.svg", duration: 3000 }, { file: "stretch.svg", duration: 4000 }];
  return h;
}

async function startIdleReaction(h) {
  await ready(h);
  await h.advance(14000);
  h.fetches[1].resolve();
  await flush();
  assert.equal(h.current().dataset.file, "glance.svg");
}

test("idle reactions wait randomly, keep truthful state, dwell after loading and never repeat immediately", async () => {
  const h = withIdlePool({ randomValues: [0.5, 0, 0, 0] });
  await ready(h);
  await h.advance(20999);
  assert.equal(h.fetches.length, 1);
  await h.advance(1);
  assert.equal(h.fetches[1].uri, "asset:glance");
  await h.advance(6000); // Time fetching is not part of the visible reaction.
  assert.equal(h.current().dataset.file, "idle.svg");
  h.fetches[1].resolve(); await flush();
  assert.equal(h.current().dataset.file, "glance.svg");
  assert.equal(h.elements.activityLabel.textContent, "Ready when you are");
  assert.match(h.elements.petStage.getAttribute("aria-label"), /Ready when you are/);
  assert.equal(vm.runInContext("currentState", h.context), "idle");
  assert.equal(vm.runInContext("currentSvg", h.context), "idle.svg");
  assert.deepEqual(h.messages.map((message) => message.type), ["ready"]);
  await h.advance(2999);
  assert.equal(h.current().dataset.file, "glance.svg");
  await h.advance(1);
  assert.equal(h.current().dataset.file, "idle.svg");
  await h.advance(13999);
  assert.equal(h.fetches.length, 2);
  await h.advance(1);
  assert.equal(h.fetches[2].uri, "asset:stretch");
  h.fetches[2].resolve(); await flush();
  assert.equal(h.current().dataset.file, "stretch.svg");
  await h.advance(4000);
  assert.equal(h.current().dataset.file, "idle.svg");
  await h.advance(14000);
  assert.equal(h.current().dataset.file, "glance.svg");
});

test("a single leisure asset recurs with neutral gaps and idle delay stays within 14 to 28 seconds", async () => {
  const h = withIdlePool({ randomValues: [1 - Number.EPSILON, 0, 0, 0] });
  h.config.idleAnimations = h.config.idleAnimations.slice(0, 1);
  await ready(h);
  await h.advance(27999);
  assert.equal(h.fetches.length, 1);
  await h.advance(1);
  h.fetches[1].resolve(); await flush();
  await h.advance(3000);
  assert.equal(h.current().dataset.file, "idle.svg");
  await h.advance(13999);
  assert.equal(h.current().dataset.file, "idle.svg");
  await h.advance(1);
  assert.equal(h.current().dataset.file, "glance.svg");
});

test("idle rotation rejects missing, duplicate and neutral assets", async () => {
  const h = withIdlePool();
  h.config.idleAnimations = [null, { file: "missing.svg" }, { file: "idle.svg" },
    { file: "glance.svg", duration: 3000 }, { file: "glance.svg", duration: 3000 }];
  await startIdleReaction(h);
  await h.advance(3000);
  await h.advance(14000);
  assert.equal(h.current().dataset.file, "glance.svg");
  assert.equal(h.fetches.length, 2);
});

test("idle rotation never starts in unavailable, busy, approval, sleep or reduced motion states", async () => {
  for (const snapshot of [
    { paused: true }, { integrationsEnabled: false }, { connectionState: "disconnected" },
    { connectionState: "starting" }, { state: "working" }, { state: "thinking" },
    { state: "attention" }, { state: "notification" }, { state: "error" },
    { state: "yawning" }, { state: "dozing" }, { state: "collapsing" }, { state: "sleeping" }, { state: "waking" },
    { sessions: [{ id: "busy", state: "working" }] },
    { permissions: [{ id: "approval", toolName: "Bash", toolInput: { command: "test" }, suggestions: [] }] },
  ]) {
    const h = withIdlePool();
    h.init(snapshot); h.fetches[0].resolve(); await flush();
    await h.advance(100000);
    assert.equal(h.fetches.length, 1, JSON.stringify(snapshot));
    assert.equal(h.current().dataset.file, "idle.svg");
  }
  const h = withIdlePool();
  h.config.reducedMotion = "on";
  await ready(h);
  await h.advance(100000);
  assert.equal(h.fetches.length, 1);
});

test("work interrupts a rendered or pending ambient pose without stale assets or return timers", async () => {
  for (const loaded of [false, true]) {
    const h = withIdlePool();
    await ready(h); await h.advance(14000);
    if (loaded) { h.fetches[1].resolve(); await flush(); }
    const old = h.current();
    h.send("state-change", { state: "working", svg: "working.svg", sessions: [{ id: "agent", state: "working" }] });
    if (loaded) assert.equal(old.styles.get("animation-play-state"), "paused");
    h.fetches[2].resolve(); await flush();
    assert.equal(h.current().dataset.file, "working.svg");
    if (!loaded) { h.fetches[1].resolve(); await flush(); }
    await h.advance(100000);
    assert.equal(h.current().dataset.file, "working.svg");
    assert.equal(h.elements.activityLabel.textContent, "At work");
    assert.equal(h.fetches.length, 3);
    h.send("state-change", { state: "idle", svg: "idle.svg", sessions: [] });
    await flush();
    await h.advance(13999);
    assert.equal(h.current().dataset.file, "idle.svg");
    await h.advance(1);
    assert.equal(h.fetches.at(-1).uri, "asset:stretch");
  }
});

test("new events cancel idle reactions and resume with a full neutral wait", async () => {
  const scenarios = [
    {
      stop: (h) => h.send("runtime-status", { connectionState: "disconnected" }),
      resume: (h) => h.send("runtime-status", { connectionState: "connected" }),
    },
    {
      stop: (h) => h.send("runtime-status", { paused: true }),
      resume: (h) => h.send("runtime-status", { paused: false }),
    },
    {
      stop: (h) => h.send("runtime-status", { integrationsEnabled: false }),
      resume: (h) => h.send("runtime-status", { integrationsEnabled: true }),
    },
    {
      stop: (h) => h.send("permission-show", { id: "approval", toolName: "Bash", toolInput: { command: "test" }, suggestions: [] }),
      resume: (h) => h.send("permission-hide", { id: "approval" }),
    },
    {
      stop: (h) => h.send("visibility-change", { visible: false }),
      resume: (h) => h.send("visibility-change", { visible: true }),
    },
    {
      stop: (h) => { h.context.document.hidden = true; h.context.document.events.visibilitychange(); },
      resume: (h) => { h.context.document.hidden = false; h.context.document.events.visibilitychange(); },
    },
    {
      stop: (h) => { h.config.reducedMotion = "on"; h.context.updateMotionPreference(); },
      resume: (h) => { h.config.reducedMotion = "off"; h.context.updateMotionPreference(); },
    },
    {
      stop: (h) => h.send("state-change", { state: "sleeping", svg: "idle.svg" }),
      resume: (h) => h.send("state-change", { state: "idle", svg: "idle.svg" }),
    },
  ];
  for (const scenario of scenarios) {
    const h = withIdlePool();
    await startIdleReaction(h);
    scenario.stop(h); await flush();
    await h.advance(100000);
    assert.equal(h.fetches.length, 2);
    scenario.resume(h); await flush();
    assert.equal(h.current().dataset.file, "idle.svg");
    await h.advance(13999);
    assert.equal(h.fetches.length, 2);
    await h.advance(1);
    assert.equal(h.fetches.at(-1).uri, "asset:stretch");
  }
});

test("previews, clicks and drags take priority over idle reactions", async () => {
  const preview = withIdlePool();
  await startIdleReaction(preview);
  preview.send("preview-animation", { state: "pose-shy", svg: "happy.svg", duration: 6000 });
  preview.fetches[2].resolve(); await flush();
  await preview.advance(5999);
  assert.equal(preview.current().dataset.file, "happy.svg");
  await preview.advance(1);
  assert.equal(preview.current().dataset.file, "idle.svg");
  await preview.advance(13999);
  assert.equal(preview.fetches.length, 3);
  await preview.advance(1);
  assert.equal(preview.fetches[3].uri, "asset:stretch");

  const click = withIdlePool();
  click.config.reactions = { clickLeft: { file: "happy.svg", duration: 2500 } };
  await startIdleReaction(click);
  click.elements.petStage.events.click({ clientX: 100, clientY: 90, detail: 1, preventDefault() {} });
  click.fetches[2].resolve(); await flush();
  await click.advance(2499);
  assert.equal(click.current().dataset.file, "happy.svg");
  await click.advance(1);
  assert.equal(click.current().dataset.file, "idle.svg");
  await click.advance(14000);
  assert.equal(click.fetches[3].uri, "asset:stretch");

  const drag = withIdlePool();
  drag.config.reactions = { drag: { file: "happy.svg" } };
  await startIdleReaction(drag);
  const event = { clientX: 130, clientY: 90, pointerId: 1, button: 0, preventDefault() {} };
  drag.elements.petStage.events.pointerdown(event);
  drag.elements.petStage.events.pointermove({ ...event, clientX: 160 });
  drag.fetches[2].resolve(); await flush();
  await drag.advance(100000);
  assert.equal(drag.current().dataset.file, "happy.svg");
  assert.equal(drag.fetches.length, 3);
  drag.elements.petStage.events.pointerup({ ...event, clientX: 160 }); await flush();
  assert.equal(drag.current().dataset.file, "idle.svg");
  await drag.advance(14000);
  assert.equal(drag.fetches[3].uri, "asset:stretch");
});

test("theme replacement cancels old idle loads and uses only the new pool", async () => {
  const h = withIdlePool();
  await ready(h); await h.advance(14000);
  h.send("theme-config", { themeId: "calico", config: { ...h.config, assetMap: { "idle.svg": "asset:new-idle", "stretch.svg": "asset:new-stretch" }, idleAnimations: [{ file: "stretch.svg", duration: 4000 }] }, svg: "idle.svg" });
  h.fetches[2].resolve(); await flush();
  h.fetches[1].resolve(); await flush();
  assert.equal(h.current().dataset.file, "idle.svg");
  await h.advance(14000);
  assert.equal(h.fetches[3].uri, "asset:new-stretch");
});

test("system motion changes cancel idle reactions and explicit off restores them", async () => {
  const h = withIdlePool({ systemReduced: true });
  await ready(h); await h.advance(100000);
  assert.equal(h.fetches.length, 1);
  h.motion.matches = false; h.motion.events.change();
  await h.advance(14000);
  h.fetches[1].resolve(); await flush();
  assert.equal(h.current().dataset.file, "glance.svg");
  h.motion.matches = true; h.motion.events.change(); await flush();
  assert.equal(h.current().dataset.file, "idle.svg");
  await h.advance(100000);
  assert.equal(h.fetches.length, 2);
  h.config.reducedMotion = "off"; h.context.updateMotionPreference();
  await h.advance(14000);
  assert.equal(h.fetches.at(-1).uri, "asset:stretch");
});

test("hidden initialization waits until the pet becomes visible", async () => {
  const h = withIdlePool();
  h.context.document.hidden = true;
  h.init(); await h.advance(100000);
  assert.equal(h.fetches.length, 0);
  h.context.document.hidden = false; h.context.document.events.visibilitychange();
  h.fetches[0].resolve(); await flush();
  await h.advance(13999);
  assert.equal(h.fetches.length, 1);
  await h.advance(1);
  assert.equal(h.fetches[1].uri, "asset:glance");
});

test("initial asset loading does not count toward the neutral idle gap", async () => {
  const h = withIdlePool();
  h.init(); await h.advance(100000);
  assert.equal(h.fetches.length, 1);
  h.fetches[0].resolve(); await flush();
  await h.advance(13999);
  assert.equal(h.fetches.length, 1);
  await h.advance(1);
  assert.equal(h.fetches[1].uri, "asset:glance");
});

test("Calico raster idle reactions freeze on interruption and recur after neutral", async () => {
  const h = harness();
  h.config.assetMap["calico-idle.apng"] = "asset:cat";
  h.config.idleAnimations = [{ file: "calico-idle.apng", duration: 5200 }];
  await ready(h); await h.advance(14000);
  h.context.document.images[0].resolve(); await flush();
  assert.equal(h.current().dataset.file, "calico-idle.apng");
  const ambient = h.current();
  h.send("state-change", { state: "working", svg: "working.svg" });
  assert.ok(ambient.querySelector("canvas"));
  assert.equal(ambient.querySelector("img"), null);
  assert.equal(h.context.document.drawings.length, 1);
  h.fetches[1].resolve(); await flush();
  await h.advance(100000);
  assert.equal(h.current().dataset.file, "working.svg");
  h.send("state-change", { state: "idle", svg: "idle.svg" }); await flush();
  await h.advance(14000);
  assert.equal(h.context.document.images.length, 2);
  h.context.document.images[1].resolve(); await flush();
  assert.equal(h.current().dataset.file, "calico-idle.apng");
  await h.advance(5200);
  assert.equal(h.current().dataset.file, "idle.svg");
});
