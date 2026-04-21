"use strict";

const vscode = acquireVsCodeApi();

const petStage = document.getElementById("petStage");
const petContainer = document.getElementById("petContainer");
const permissionsEl = document.getElementById("permissions");
const sessionsEl = document.getElementById("sessions");
const stateLabel = document.getElementById("stateLabel");
const serverLabel = document.getElementById("serverLabel");
const toastLog = document.getElementById("toastLog");
const installBtn = document.getElementById("installBtn");
const disableIntegrationsBtn = document.getElementById("disableIntegrationsBtn");
const runtimeBtn = document.getElementById("runtimeBtn");
const dndBtn = document.getElementById("dndBtn");
const themeBtn = document.getElementById("themeBtn");
const restartBtn = document.getElementById("restartBtn");

let config = {};
let themes = [];
let themeId = "clawd";
let currentState = "idle";
let currentSvg = null;
let currentAssetName = null;
let soundMap = {};
let permissions = new Map();
let elicitationStates = new Map();
let sessions = [];
let runtimePaused = false;
let integrationsEnabled = true;
let reactionTimer = null;
let tracking = null;
let layerTracking = null;
let currentWrapper = null;
let renderSerial = 0;
let layerAnimFrame = null;
let layerTargetDx = 0;
let layerTargetDy = 0;
let dragState = null;
let suppressNextClick = false;

const DRAG_THRESHOLD = 4;

function post(type, body = {}) {
  vscode.postMessage({ type, ...body });
}

function baseName(value) {
  if (!value) return "";
  const clean = String(value).split(/[?#]/)[0];
  const parts = clean.split(/[\\/]/);
  return parts[parts.length - 1] || clean;
}

function fileUri(file) {
  const name = baseName(file);
  return config.assetMap && config.assetMap[name] ? config.assetMap[name] : null;
}

function setStatus(state, port) {
  stateLabel.textContent = runtimePaused ? "Paused" : (state || "idle");
  if (port !== undefined) serverLabel.textContent = port ? `:${port}` : "off";
}

function updateRuntimeButton() {
  if (!runtimeBtn) return;
  const label = runtimePaused ? "Resume Clawd runtime" : "Pause Clawd runtime";
  runtimeBtn.title = label;
  runtimeBtn.setAttribute("aria-label", label);
}

function updateInstallButton() {
  if (!installBtn) return;
  const label = integrationsEnabled ? "Install/sync agent integrations" : "Enable agent integrations";
  installBtn.title = label;
  installBtn.setAttribute("aria-label", label);
  if (disableIntegrationsBtn) {
    disableIntegrationsBtn.hidden = !integrationsEnabled;
    disableIntegrationsBtn.title = "Disable agent integrations";
    disableIntegrationsBtn.setAttribute("aria-label", "Disable agent integrations");
  }
}

function showToast(message) {
  toastLog.textContent = message || "";
  if (message) setTimeout(() => {
    if (toastLog.textContent === message) toastLog.textContent = "";
  }, 5000);
}

function needsInlineSvg(state, file) {
  if (!file || !file.endsWith(".svg")) return false;
  const states = Array.isArray(config.eyeTrackingStates) ? config.eyeTrackingStates : [];
  return states.includes(state);
}

function getViewBox() {
  const vb = config.viewBox || {};
  if (!Number.isFinite(vb.x) || !Number.isFinite(vb.y) || !Number.isFinite(vb.width) || !Number.isFinite(vb.height)) {
    return { x: 0, y: 0, width: 45, height: 45 };
  }
  return vb;
}

function getFileScale(file) {
  const scales = config.objectScale && config.objectScale.fileScales;
  const value = scales && scales[baseName(file)];
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function getFileOffset(file) {
  const offsets = config.objectScale && config.objectScale.fileOffsets;
  const value = offsets && offsets[baseName(file)];
  if (!value || typeof value !== "object") return { x: 0, y: 0 };
  return {
    x: Number.isFinite(value.x) ? value.x : 0,
    y: Number.isFinite(value.y) ? value.y : 0,
  };
}

function applyPetLayout(wrapper, file) {
  if (!wrapper) return;
  const rect = petStage.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  const vb = getViewBox();
  const layout = config.layout || {};
  const contentBox = layout.contentBox;
  const offset = getFileOffset(file);
  const scale = getFileScale(file);

  let width;
  let height;
  let left;
  let bottom;

  if (contentBox && contentBox.width > 0 && contentBox.height > 0) {
    const centerX = Number.isFinite(layout.centerX)
      ? layout.centerX
      : contentBox.x + contentBox.width / 2;
    const baselineY = Number.isFinite(layout.baselineY)
      ? layout.baselineY
      : contentBox.y + contentBox.height;
    const visibleHeightRatio = Number.isFinite(layout.visibleHeightRatio) ? layout.visibleHeightRatio : 0.58;
    const baselineBottomRatio = Number.isFinite(layout.baselineBottomRatio) ? layout.baselineBottomRatio : 0.05;
    const centerXRatio = Number.isFinite(layout.centerXRatio) ? layout.centerXRatio : 0.5;
    let unitPx = (rect.height * visibleHeightRatio * scale) / contentBox.height;

    width = vb.width * unitPx;
    const maxWidth = rect.width * 0.96;
    if (width > maxWidth) {
      unitPx *= maxWidth / width;
      width = vb.width * unitPx;
    }

    height = vb.height * unitPx;
    left = (rect.width * centerXRatio) - ((centerX - vb.x) * unitPx) + offset.x;
    bottom = (rect.height * baselineBottomRatio) - ((vb.y + vb.height - baselineY) * unitPx) + offset.y;
  } else {
    const fallbackWidth = Math.min(180, rect.width * 0.86);
    width = fallbackWidth * scale;
    height = width * (vb.height / Math.max(1, vb.width));
    left = (rect.width - width) / 2 + offset.x;
    bottom = 22 + offset.y;
  }

  wrapper.style.setProperty("--pet-width", `${Math.max(24, width)}px`);
  wrapper.style.setProperty("--pet-height", `${Math.max(24, height)}px`);
  wrapper.style.setProperty("--pet-left", `${Math.round(left * 10) / 10}px`);
  wrapper.style.setProperty("--pet-bottom", `${Math.round(bottom * 10) / 10}px`);
}

function relayoutPet() {
  if (currentWrapper && currentAssetName) applyPetLayout(currentWrapper, currentAssetName);
}

function getNextTheme() {
  if (!themes.length) return null;
  const idx = Math.max(0, themes.findIndex((theme) => theme.id === themeId));
  return themes[(idx + 1) % themes.length] || null;
}

function updateThemeButton() {
  document.body.dataset.theme = themeId || "";
  const next = getNextTheme();
  if (next) {
    document.body.dataset.nextTheme = next.id;
    const label = `Switch to ${next.name || next.id}`;
    themeBtn.title = label;
    themeBtn.setAttribute("aria-label", label);
  } else {
    delete document.body.dataset.nextTheme;
    themeBtn.title = "Switch character";
    themeBtn.setAttribute("aria-label", "Switch character");
  }
}

async function renderPet(file, state, options = {}) {
  const serial = ++renderSerial;
  const name = baseName(file);
  if (!name) return;
  const uri = fileUri(name);
  if (!uri) {
    petContainer.textContent = "";
    currentAssetName = null;
    currentWrapper = null;
    return;
  }
  if (!options.force && currentAssetName === name && state === currentState) return;

  clearTracking();
  petContainer.textContent = "";
  currentAssetName = name;

  const wrapper = document.createElement("div");
  wrapper.className = "pet-asset fade-in";
  wrapper.dataset.file = name;
  currentWrapper = wrapper;
  applyPetLayout(wrapper, name);
  if (dragState && dragState.dragging) setDragOffset(dragState.dx, dragState.dy, wrapper);
  petContainer.appendChild(wrapper);

  if (needsInlineSvg(state, name)) {
    try {
      const response = await fetch(uri);
      const text = await response.text();
      if (serial !== renderSerial || !wrapper.isConnected) return;
      wrapper.innerHTML = text;
      const svg = wrapper.querySelector("svg");
      if (svg) {
        svg.removeAttribute("width");
        svg.removeAttribute("height");
        attachTracking(svg);
      }
    } catch {
      const img = document.createElement("img");
      img.alt = "";
      img.src = `${uri}${uri.includes("?") ? "&" : "?"}_t=${Date.now()}`;
      wrapper.appendChild(img);
    }
  } else {
    const img = document.createElement("img");
    img.alt = "";
    img.src = name.endsWith(".svg") ? `${uri}${uri.includes("?") ? "&" : "?"}_t=${Date.now()}` : uri;
    wrapper.appendChild(img);
  }
}

const resizeObserver = new ResizeObserver(() => relayoutPet());
resizeObserver.observe(petStage);

function attachTracking(svg) {
  const eyeConfig = config.eyeTracking || {};
  if (eyeConfig.trackingLayers) {
    layerTracking = {};
    for (const [name, layer] of Object.entries(eyeConfig.trackingLayers)) {
      const wrappers = [];
      for (const id of Array.isArray(layer.ids) ? layer.ids : []) {
        const node = svg.getElementById(id);
        const wrapper = wrapTrackingNode(svg, node);
        if (wrapper) wrappers.push(wrapper);
      }
      for (const cls of Array.isArray(layer.classes) ? layer.classes : []) {
        for (const node of svg.querySelectorAll(`.${escapeCssIdent(cls)}`)) {
          const wrapper = wrapTrackingNode(svg, node);
          if (wrapper) wrappers.push(wrapper);
        }
      }
      layerTracking[name] = {
        wrappers,
        maxOffset: layer.maxOffset || 8,
        ease: layer.ease || 0.15,
        x: 0,
        y: 0,
      };
    }
    startLayerTrackingLoop();
    return;
  }

  const ids = eyeConfig.ids || {};
  tracking = {
    eyes: svg.getElementById(ids.eyes || "eyes-js"),
    body: svg.getElementById(ids.body || "body-js"),
    shadow: svg.getElementById(ids.shadow || "shadow-js"),
    bodyScale: eyeConfig.bodyScale || 0.33,
    shadowStretch: eyeConfig.shadowStretch || 0.15,
    shadowShift: eyeConfig.shadowShift || 0.3,
  };
}

function clearTracking() {
  if (layerAnimFrame) {
    cancelAnimationFrame(layerAnimFrame);
    layerAnimFrame = null;
  }
  tracking = null;
  layerTracking = null;
  layerTargetDx = 0;
  layerTargetDy = 0;
}

function escapeCssIdent(value) {
  if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

function wrapTrackingNode(svg, node) {
  if (!svg || !node || !node.parentNode) return null;
  const wrapper = svg.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "g");
  wrapper.setAttribute("data-tracking-wrapper", "1");
  node.parentNode.insertBefore(wrapper, node);
  wrapper.appendChild(node);
  return wrapper;
}

function startLayerTrackingLoop() {
  if (layerAnimFrame) return;

  const tick = () => {
    if (!layerTracking) {
      layerAnimFrame = null;
      return;
    }

    const themeMax = (config.eyeTracking && config.eyeTracking.maxOffset) || 20;
    for (const layer of Object.values(layerTracking)) {
      const scale = layer.maxOffset / themeMax;
      const tx = layerTargetDx * scale;
      const ty = layerTargetDy * scale;
      layer.x += (tx - layer.x) * layer.ease;
      layer.y += (ty - layer.y) * layer.ease;
      if (tx === 0 && ty === 0 && Math.abs(layer.x) < 0.01 && Math.abs(layer.y) < 0.01) {
        layer.x = 0;
        layer.y = 0;
      }
      const x = Math.round(layer.x * 4) / 4;
      const y = Math.round(layer.y * 4) / 4;
      for (const wrapper of layer.wrappers) wrapper.setAttribute("transform", `translate(${x}, ${y})`);
    }

    layerAnimFrame = requestAnimationFrame(tick);
  };

  layerAnimFrame = requestAnimationFrame(tick);
}

function applyEyeMove(dx, dy) {
  if (layerTracking) {
    layerTargetDx = dx;
    layerTargetDy = dy;
    startLayerTrackingLoop();
    return;
  }
  if (!tracking) return;
  if (tracking.eyes) tracking.eyes.setAttribute("transform", `translate(${dx}, ${dy})`);
  const bdx = Math.round(dx * tracking.bodyScale * 2) / 2;
  const bdy = Math.round(dy * tracking.bodyScale * 2) / 2;
  if (tracking.body) tracking.body.setAttribute("transform", `translate(${bdx}, ${bdy})`);
  if (tracking.shadow) {
    const scaleX = 1 + Math.abs(bdx) * tracking.shadowStretch;
    const shiftX = Math.round(bdx * tracking.shadowShift * 2) / 2;
    tracking.shadow.setAttribute("transform", `translate(${shiftX}, 0) scale(${scaleX}, 1)`);
  }
}

function updateEyeFromPointer(event) {
  const maxOffset = (config.eyeTracking && config.eyeTracking.maxOffset) || 3;
  const rect = petStage.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height * 0.56;
  const rawX = (event.clientX - cx) / Math.max(1, rect.width / 2);
  const rawY = (event.clientY - cy) / Math.max(1, rect.height / 2);
  const dx = Math.max(-maxOffset, Math.min(maxOffset, rawX * maxOffset));
  const dy = Math.max(-maxOffset, Math.min(maxOffset, rawY * maxOffset));
  applyEyeMove(Math.round(dx * 2) / 2, Math.round(dy * 2) / 2);
}

function isPointOverPet(event) {
  if (!currentWrapper) return false;
  const rect = currentWrapper.getBoundingClientRect();
  const pad = 6;
  return event.clientX >= rect.left - pad
    && event.clientX <= rect.right + pad
    && event.clientY >= rect.top - pad
    && event.clientY <= rect.bottom + pad;
}

function setDragOffset(dx, dy, wrapper = currentWrapper) {
  if (!wrapper) return;
  wrapper.style.setProperty("--drag-x", `${Math.round(dx)}px`);
  wrapper.style.setProperty("--drag-y", `${Math.round(dy)}px`);
}

function startPotentialDrag(event) {
  if (event.button !== undefined && event.button !== 0) return;
  if (!isPointOverPet(event)) return;
  dragState = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    dx: 0,
    dy: 0,
    dragging: false,
  };
  try { petStage.setPointerCapture(event.pointerId); } catch {}
}

function updateDrag(event) {
  if (!dragState || dragState.pointerId !== event.pointerId) return;
  const dx = event.clientX - dragState.startX;
  const dy = event.clientY - dragState.startY;
  dragState.dx = dx;
  dragState.dy = dy;

  if (!dragState.dragging && Math.hypot(dx, dy) >= DRAG_THRESHOLD) {
    dragState.dragging = true;
    suppressNextClick = true;
    petStage.classList.add("is-dragging");
    if (reactionTimer) {
      clearTimeout(reactionTimer);
      reactionTimer = null;
    }
    const dragReaction = config.reactions && config.reactions.drag;
    if (dragReaction && dragReaction.file) renderPet(dragReaction.file, "drag", { force: true });
  }

  if (dragState.dragging) {
    event.preventDefault();
    setDragOffset(dx, dy);
  }
}

function finishDrag(event) {
  if (!dragState || dragState.pointerId !== event.pointerId) return;
  const wasDragging = dragState.dragging;
  try {
    if (petStage.hasPointerCapture(event.pointerId)) petStage.releasePointerCapture(event.pointerId);
  } catch {}
  dragState = null;
  petStage.classList.remove("is-dragging");
  if (wasDragging) {
    suppressNextClick = true;
    renderPet(currentSvg, currentState, { force: true });
  }
}

petStage.addEventListener("pointerdown", startPotentialDrag);

petStage.addEventListener("pointermove", (event) => {
  updateEyeFromPointer(event);
  updateDrag(event);
});

petStage.addEventListener("pointerleave", () => applyEyeMove(0, 0));
petStage.addEventListener("pointerup", finishDrag);
petStage.addEventListener("pointercancel", finishDrag);

petStage.addEventListener("click", (event) => {
  if (suppressNextClick) {
    suppressNextClick = false;
    event.preventDefault();
    return;
  }
  if (currentState !== "idle") {
    post("focus-terminal");
    return;
  }
  const reactions = config.reactions || {};
  const rect = petStage.getBoundingClientRect();
  const side = event.clientX < rect.left + rect.width / 2 ? "clickLeft" : "clickRight";
  const reaction = reactions[side] || reactions.annoyed;
  if (!reaction || !reaction.file) {
    post("focus-terminal");
    return;
  }
  if (reactionTimer) clearTimeout(reactionTimer);
  renderPet(reaction.file, "reaction", { force: true });
  reactionTimer = setTimeout(() => {
    reactionTimer = null;
    renderPet(currentSvg, currentState, { force: true });
  }, reaction.duration || 2500);
});

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function permissionInput(permission) {
  return plainObject(permission.toolInput) ? permission.toolInput : {};
}

function cleanText(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function compactPath(value) {
  const text = cleanText(value);
  if (!text) return "";
  const workspaceIdx = text.indexOf("/workspace/");
  if (workspaceIdx !== -1) return text.slice(workspaceIdx + "/workspace/".length);
  if (text.startsWith(processLikeHomePrefix())) return `~/${text.slice(processLikeHomePrefix().length)}`;
  return text;
}

function processLikeHomePrefix() {
  return "/home/";
}

function permissionKind(permission) {
  if (permission.isCodexNotify) return "codex-notify";
  if (permission.isElicitation || permission.toolName === "AskUserQuestion") return "question";
  switch (permission.toolName) {
    case "Write":
      return "file-write";
    case "Edit":
    case "MultiEdit":
      return "file-edit";
    case "NotebookEdit":
      return "notebook-edit";
    case "Bash":
      return "shell";
    case "PowerShell":
      return "powershell";
    case "WebFetch":
      return "web-fetch";
    case "Read":
    case "Glob":
    case "Grep":
      return "filesystem";
    case "Skill":
      return "skill";
    case "EnterPlanMode":
      return "enter-plan";
    case "ExitPlanMode":
      return "exit-plan";
    default:
      return "fallback";
  }
}

function describePermission(permission, kind, input) {
  const file = permission.preview && permission.preview.file;
  switch (kind) {
    case "codex-notify":
      return { title: "Codex approval requested", subtitle: input.command || "" };
    case "question":
      return { title: "Question from agent", subtitle: `${Array.isArray(permission.questions) ? permission.questions.length : 1} prompt` };
    case "file-write":
      return {
        title: file && file.exists === true ? "Overwrite file" : "Create file",
        subtitle: compactPath(input.file_path),
      };
    case "file-edit":
      return { title: "Edit file", subtitle: compactPath(input.file_path) };
    case "notebook-edit":
      return { title: "Edit notebook", subtitle: compactPath(input.notebook_path) };
    case "shell":
      return { title: "Bash command", subtitle: input.description || firstCommandWord(input.command) };
    case "powershell":
      return { title: "PowerShell command", subtitle: input.description || firstCommandWord(input.command) };
    case "web-fetch":
      return { title: "Fetch web content", subtitle: hostFromUrl(input.url) || input.url || "" };
    case "filesystem":
      return describeFilesystemPermission(permission.toolName, input);
    case "skill":
      return { title: "Use skill", subtitle: [input.skill, input.args].filter(Boolean).join(" ") };
    case "enter-plan":
      return { title: "Enter plan mode", subtitle: "Design before editing" };
    case "exit-plan":
      return { title: "Approve plan", subtitle: compactPath(input.planFilePath) };
    default:
      return { title: permission.toolName || "Tool request", subtitle: "" };
  }
}

function describeFilesystemPermission(toolName, input) {
  if (toolName === "Glob") {
    return { title: "Search files", subtitle: input.pattern || compactPath(input.path) };
  }
  if (toolName === "Grep") {
    return { title: "Search text", subtitle: input.pattern || compactPath(input.path) };
  }
  return { title: "Read file", subtitle: compactPath(input.file_path || input.path) };
}

function firstCommandWord(command) {
  const match = cleanText(command).trim().match(/^\S+/);
  return match ? match[0] : "";
}

function hostFromUrl(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return "";
  }
}

function makeDiv(className, text) {
  const node = document.createElement("div");
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function renderMeta(items) {
  const row = document.createElement("div");
  row.className = "permission-meta";
  for (const item of items) {
    if (!item || item.value === undefined || item.value === null || item.value === "") continue;
    const chip = document.createElement("div");
    chip.className = "meta-chip";
    const label = document.createElement("span");
    label.className = "meta-label";
    label.textContent = item.label;
    const value = document.createElement("span");
    value.className = "meta-value";
    value.textContent = cleanText(item.value);
    chip.append(label, value);
    row.append(chip);
  }
  return row;
}

function appendSectionTitle(parent, text) {
  parent.append(makeDiv("permission-section-title", text));
}

function appendNotice(parent, text, tone = "") {
  if (!text) return;
  const note = makeDiv(`permission-note${tone ? ` ${tone}` : ""}`, text);
  parent.append(note);
}

function appendNewlineMarker(target) {
  const marker = document.createElement("span");
  marker.className = "escape-newline";
  marker.title = "newline";
  marker.textContent = "↵";
  target.appendChild(marker);
}

function renderCodeBlock(value, options = {}) {
  const text = cleanText(value);
  const block = document.createElement("div");
  block.className = `permission-code${options.wrap === false ? " nowrap" : ""}`;
  if (!text) {
    block.classList.add("empty");
    block.textContent = "(empty)";
    return block;
  }

  const lines = text.split("\n");
  const visibleLineCount = text.endsWith("\n") ? Math.max(1, lines.length - 1) : lines.length;
  for (let i = 0; i < visibleLineCount; i++) {
    const row = document.createElement("div");
    row.className = `code-line${options.lineNumbers ? " numbered" : ""}`;
    if (options.lineNumbers) {
      const lineNo = document.createElement("span");
      lineNo.className = "line-no";
      lineNo.textContent = String(i + 1);
      row.append(lineNo);
    }
    const code = document.createElement("span");
    code.className = "line-text";
    appendVisualizedPreview(code, lines[i] || "");
    if (i < lines.length - 1) appendNewlineMarker(code);
    row.append(code);
    block.append(row);
  }
  return block;
}

function renderDiffBlock(edits) {
  const diff = document.createElement("div");
  diff.className = "permission-diff";
  edits.forEach((edit, index) => {
    if (edits.length > 1) {
      const title = makeDiv("diff-hunk-title", `Edit ${index + 1}${edit.replace_all ? " · replace all" : ""}`);
      diff.append(title);
    } else if (edit.replace_all) {
      diff.append(makeDiv("diff-hunk-title", "Replace all matches"));
    }
    appendDiffLines(diff, edit.old_string, "removed");
    appendDiffLines(diff, edit.new_string, "added");
  });
  return diff;
}

function appendDiffLines(parent, value, tone) {
  const prefix = tone === "removed" ? "-" : "+";
  const text = cleanText(value);
  const lines = text ? text.split("\n") : [""];
  const visibleLineCount = text.endsWith("\n") ? Math.max(1, lines.length - 1) : lines.length;
  for (let i = 0; i < visibleLineCount; i++) {
    const row = document.createElement("div");
    row.className = `diff-line ${tone}`;
    const sign = document.createElement("span");
    sign.className = "diff-prefix";
    sign.textContent = prefix;
    const line = document.createElement("span");
    line.className = "diff-text";
    appendVisualizedPreview(line, lines[i] || "");
    if (i < lines.length - 1) appendNewlineMarker(line);
    row.append(sign, line);
    parent.append(row);
  }
}

function renderRawInputDetails(permission) {
  const details = document.createElement("details");
  details.className = "permission-raw";
  const summary = document.createElement("summary");
  summary.textContent = "Raw input";
  const pre = document.createElement("pre");
  pre.className = "permission-input";
  const text = permission.inputPreview || JSON.stringify(permissionInput(permission), null, 2);
  appendVisualizedPreview(pre, text || "");
  details.append(summary, pre);
  return details;
}

function renderFileStatus(file) {
  if (!file) return "unknown";
  if (file.exists === false) return "new";
  if (file.exists === true && file.isFile === false) return "not a regular file";
  if (file.exists === true) return file.truncated ? `existing · ${file.size} bytes` : "existing";
  return "unknown";
}

function renderPermissionBody(permission, kind, input) {
  if (kind === "question" && Array.isArray(permission.questions) && permission.questions.length) {
    return renderElicitationForm(permission);
  }

  const body = document.createElement("div");
  body.className = "permission-body";
  switch (kind) {
    case "codex-notify":
      renderCodexNotifyBody(body, input);
      break;
    case "file-write":
      renderFileWriteBody(body, permission, input);
      break;
    case "file-edit":
      renderFileEditBody(body, permission, input);
      break;
    case "notebook-edit":
      renderNotebookBody(body, permission, input);
      break;
    case "shell":
    case "powershell":
      renderShellBody(body, input, kind);
      break;
    case "web-fetch":
      renderWebFetchBody(body, input);
      break;
    case "filesystem":
      renderFilesystemBody(body, permission.toolName, input);
      break;
    case "skill":
      renderSkillBody(body, input);
      break;
    case "enter-plan":
      renderEnterPlanBody(body);
      break;
    case "exit-plan":
      renderExitPlanBody(body, input);
      break;
    default:
      renderFallbackBody(body, permission, input);
      break;
  }
  if (kind !== "codex-notify") body.append(renderRawInputDetails(permission));
  return body;
}

function renderCodexNotifyBody(body, input) {
  appendSectionTitle(body, "Command");
  body.append(renderCodeBlock(input.command || "(unknown)", { wrap: false }));
}

function renderFileWriteBody(body, permission, input) {
  const file = permission.preview && permission.preview.file;
  body.append(renderMeta([
    { label: "Path", value: compactPath(input.file_path) },
    { label: "Mode", value: file && file.exists === true ? "overwrite" : "create" },
    { label: "File", value: renderFileStatus(file) },
  ]));
  if (file && file.error) appendNotice(body, file.error, "warning");
  if (file && file.exists === true && file.content) {
    appendSectionTitle(body, "Current file preview");
    body.append(renderCodeBlock(file.content, { lineNumbers: true }));
    if (file.truncated) appendNotice(body, "Current file preview is truncated.", "warning");
  }
  appendSectionTitle(body, file && file.exists === true ? "Proposed content" : "Content");
  body.append(renderCodeBlock(input.content || "", { lineNumbers: true }));
}

function renderFileEditBody(body, permission, input) {
  const file = permission.preview && permission.preview.file;
  const edits = Array.isArray(input.edits) && input.edits.length
    ? input.edits
    : [{ old_string: input.old_string, new_string: input.new_string, replace_all: input.replace_all }];
  body.append(renderMeta([
    { label: "Path", value: compactPath(input.file_path) },
    { label: "Edits", value: edits.length },
    { label: "File", value: renderFileStatus(file) },
  ]));
  if (file && file.exists === false) appendNotice(body, "Target file does not exist yet.", "warning");
  if (file && file.error) appendNotice(body, file.error, "warning");
  appendSectionTitle(body, "Change preview");
  body.append(renderDiffBlock(edits));
}

function renderNotebookBody(body, permission, input) {
  const file = permission.preview && permission.preview.file;
  const mode = input.edit_mode || "replace";
  body.append(renderMeta([
    { label: "Notebook", value: compactPath(input.notebook_path) },
    { label: "Mode", value: mode },
    { label: "Cell", value: input.cell_id || "first/new" },
    { label: "Type", value: input.cell_type || "current" },
    { label: "File", value: renderFileStatus(file) },
  ]));
  if (file && file.error) appendNotice(body, file.error, "warning");
  if (mode === "delete") {
    appendNotice(body, "This request deletes the selected notebook cell.", "warning");
    return;
  }
  appendSectionTitle(body, "Cell source");
  body.append(renderCodeBlock(input.new_source || "", { lineNumbers: true }));
}

function renderShellBody(body, input, kind) {
  const command = input.command || "";
  body.append(renderMeta([
    { label: "Shell", value: kind === "powershell" ? "PowerShell" : "Bash" },
    { label: "Description", value: input.description },
  ]));
  if (looksDestructive(command)) appendNotice(body, "This command may modify or delete data. Review it carefully.", "warning");
  if (looksLikeSedEdit(command)) appendNotice(body, "This looks like an in-place file edit command.", "info");
  appendSectionTitle(body, "Command");
  body.append(renderCodeBlock(command, { wrap: false }));
}

function renderWebFetchBody(body, input) {
  body.append(renderMeta([
    { label: "Domain", value: hostFromUrl(input.url) },
    { label: "URL", value: input.url },
  ]));
  if (input.prompt) {
    appendSectionTitle(body, "Prompt");
    body.append(renderCodeBlock(input.prompt));
  }
}

function renderFilesystemBody(body, toolName, input) {
  const items = [];
  if (toolName === "Read") {
    items.push({ label: "Path", value: compactPath(input.file_path || input.path) });
    items.push({ label: "Offset", value: input.offset });
    items.push({ label: "Limit", value: input.limit });
  } else if (toolName === "Glob") {
    items.push({ label: "Pattern", value: input.pattern });
    items.push({ label: "Path", value: compactPath(input.path) });
  } else {
    items.push({ label: "Pattern", value: input.pattern });
    items.push({ label: "Path", value: compactPath(input.path) });
    items.push({ label: "Glob", value: input.glob });
    items.push({ label: "Mode", value: input.output_mode });
  }
  body.append(renderMeta(items));
}

function renderSkillBody(body, input) {
  body.append(renderMeta([
    { label: "Skill", value: input.skill },
    { label: "Args", value: input.args },
  ]));
}

function renderEnterPlanBody(body) {
  body.append(renderMeta([
    { label: "Mode", value: "plan" },
    { label: "Writes", value: "blocked until approved" },
  ]));
  appendNotice(body, "Claude wants to switch into planning mode before making code changes.", "info");
}

function renderExitPlanBody(body, input) {
  body.append(renderMeta([
    { label: "Plan file", value: compactPath(input.planFilePath) },
    { label: "Requested rules", value: Array.isArray(input.allowedPrompts) ? input.allowedPrompts.length : 0 },
  ]));
  appendSectionTitle(body, "Plan");
  body.append(renderCodeBlock(input.plan || "No plan content was included in the permission payload.", { lineNumbers: false }));
  if (Array.isArray(input.allowedPrompts) && input.allowedPrompts.length) {
    appendSectionTitle(body, "Requested prompt permissions");
    const list = document.createElement("div");
    list.className = "permission-list";
    input.allowedPrompts.forEach((item) => {
      list.append(makeDiv("permission-list-item", `${item.tool || "Tool"}: ${item.prompt || ""}`));
    });
    body.append(list);
  }
}

function renderFallbackBody(body, permission, input) {
  const fields = Object.entries(input).slice(0, 4).map(([key, value]) => ({
    label: key,
    value: plainObject(value) || Array.isArray(value) ? JSON.stringify(value) : value,
  }));
  body.append(renderMeta([{ label: "Tool", value: permission.toolName }, ...fields]));
}

function looksLikeSedEdit(command) {
  return /\bsed\b[\s\S]*\s-i(?:\s|$|[.])/.test(cleanText(command));
}

function looksDestructive(command) {
  return /\b(rm\s+-[^\n;|&]*r|sudo\s+rm|mkfs|dd\s+if=|git\s+reset\s+--hard|git\s+clean\s+-|docker\s+system\s+prune|kubectl\s+delete|chmod\s+-R|chown\s+-R)\b/.test(cleanText(command));
}

function suggestionLabel(suggestion) {
  if (!suggestion || typeof suggestion !== "object") return "Apply Permission Update";
  if (suggestion.type === "setMode") {
    switch (suggestion.mode) {
      case "acceptEdits":
        return "Allow All Edits This Session";
      case "bypassPermissions":
        return "Bypass Permissions";
      case "plan":
        return "Enter Plan Mode";
      case "default":
        return "Use Default Permissions";
      case "dontAsk":
        return "Deny Unapproved Requests";
      default:
        return `Set Mode: ${suggestion.mode || "unknown"}`;
    }
  }
  if (suggestion.type === "addRules") return `Always Allow ${rulesSummary(suggestion)}`;
  if (suggestion.type === "replaceRules") return `Replace Rules ${rulesSummary(suggestion)}`;
  if (suggestion.type === "removeRules") return `Remove Rules ${rulesSummary(suggestion)}`;
  if (suggestion.type === "addDirectories") return `Allow ${directoriesSummary(suggestion)}`;
  if (suggestion.type === "removeDirectories") return `Remove ${directoriesSummary(suggestion)}`;
  return "Apply Permission Update";
}

function suggestionTone(suggestion) {
  if (suggestion && suggestion.type === "setMode" && suggestion.mode === "bypassPermissions") return "danger";
  if (suggestion && suggestion.type === "setMode" && suggestion.mode === "acceptEdits") return "suggested";
  return "secondary";
}

function rulesSummary(suggestion) {
  const rules = Array.isArray(suggestion.rules)
    ? suggestion.rules
    : [{ toolName: suggestion.toolName, ruleContent: suggestion.ruleContent }];
  const valid = rules.filter((rule) => rule && (rule.ruleContent || rule.toolName));
  if (!valid.length) return "Rule";
  if (valid.length > 1) return `${valid.length} Rules`;
  const rule = valid[0];
  return [rule.toolName, rule.ruleContent].filter(Boolean).join(" ");
}

function directoriesSummary(suggestion) {
  const directories = Array.isArray(suggestion.directories) ? suggestion.directories : [];
  if (directories.length > 1) return `${directories.length} Directories`;
  return compactPath(directories[0]) || "Directory";
}

function allowLabelForKind(kind) {
  if (kind === "exit-plan") return "Approve Plan";
  if (kind === "enter-plan") return "Enter Plan Mode";
  return "Allow";
}

function terminalLabelForKind(kind) {
  if (kind === "exit-plan") return "Revise in Terminal";
  if (kind === "question") return "Answer in Terminal";
  return "Terminal";
}

function questionKey(question, index) {
  return question && question.question ? question.question : `Question ${index + 1}`;
}

function questionHeader(question, index) {
  return question && question.header ? question.header : `Q${index + 1}`;
}

function hasSubmitQuestionStep(questions) {
  return !(questions.length === 1 && !questions[0]?.multiSelect);
}

function maxElicitationIndex(questions) {
  return hasSubmitQuestionStep(questions) ? questions.length : Math.max(0, questions.length - 1);
}

function getElicitationState(permission) {
  let state = elicitationStates.get(permission.id);
  if (!state) {
    state = {
      index: 0,
      answers: {},
      selections: {},
      otherText: {},
    };
    elicitationStates.set(permission.id, state);
  }
  const questions = Array.isArray(permission.questions) ? permission.questions : [];
  state.index = Math.max(0, Math.min(maxElicitationIndex(questions), state.index || 0));
  return state;
}

function setElicitationIndex(permission, index) {
  const state = getElicitationState(permission);
  const questions = Array.isArray(permission.questions) ? permission.questions : [];
  state.index = Math.max(0, Math.min(maxElicitationIndex(questions), index));
  renderPermissions();
}

function advanceElicitation(permission) {
  const state = getElicitationState(permission);
  const questions = Array.isArray(permission.questions) ? permission.questions : [];
  const maxIndex = maxElicitationIndex(questions);
  if (state.index < maxIndex) {
    state.index += 1;
    renderPermissions();
    return;
  }
  submitElicitation(permission);
}

function setElicitationAnswer(permission, question, qIdx, answer, shouldAdvance = true) {
  const state = getElicitationState(permission);
  const key = questionKey(question, qIdx);
  const normalized = cleanText(answer).trim();
  if (normalized) state.answers[key] = normalized;
  else delete state.answers[key];

  if (!shouldAdvance) {
    renderPermissions();
    return;
  }

  const questions = Array.isArray(permission.questions) ? permission.questions : [];
  if (!hasSubmitQuestionStep(questions) && questions.length === 1) {
    submitElicitation(permission);
    return;
  }
  advanceElicitation(permission);
}

function toggleElicitationSelection(permission, question, qIdx, optionLabel, checked) {
  const state = getElicitationState(permission);
  const key = questionKey(question, qIdx);
  const values = new Set(Array.isArray(state.selections[key]) ? state.selections[key] : []);
  if (checked) values.add(optionLabel);
  else values.delete(optionLabel);
  state.selections[key] = [...values];
  renderPermissions();
}

function setElicitationOtherText(permission, question, qIdx, value) {
  const state = getElicitationState(permission);
  state.otherText[questionKey(question, qIdx)] = value;
}

function confirmCurrentElicitationQuestion(permission) {
  const state = getElicitationState(permission);
  const questions = Array.isArray(permission.questions) ? permission.questions : [];
  const question = questions[state.index];
  if (!question) {
    submitElicitation(permission);
    return;
  }

  const key = questionKey(question, state.index);
  if (question.multiSelect) {
    const selected = Array.isArray(state.selections[key]) ? [...state.selections[key]] : [];
    const other = cleanText(state.otherText[key]).trim();
    if (other) selected.push(other);
    setElicitationAnswer(permission, question, state.index, selected.join(", "), true);
    return;
  }

  const other = cleanText(state.otherText[key]).trim();
  if (other) setElicitationAnswer(permission, question, state.index, other, true);
  else advanceElicitation(permission);
}

function submitElicitation(permission) {
  const state = getElicitationState(permission);
  elicitationStates.delete(permission.id);
  post("permission-decide", {
    id: permission.id,
    behavior: { type: "elicitation-submit", answers: state.answers },
  });
}

function cancelElicitation(permission) {
  elicitationStates.delete(permission.id);
  post("permission-decide", { id: permission.id, behavior: "deny" });
}

function renderQuestionNavigation(permission, questions, state) {
  const nav = document.createElement("div");
  nav.className = "question-nav";

  const previous = document.createElement("button");
  previous.className = "question-nav-arrow";
  previous.type = "button";
  previous.textContent = "←";
  previous.disabled = state.index === 0;
  previous.title = "Previous";
  previous.addEventListener("click", () => setElicitationIndex(permission, state.index - 1));
  nav.append(previous);

  const tabs = document.createElement("div");
  tabs.className = "question-tabs";
  questions.forEach((question, index) => {
    const key = questionKey(question, index);
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = `question-tab${index === state.index ? " active" : ""}`;
    tab.title = key;
    const check = state.answers[key] ? "✓" : "□";
    tab.textContent = `${check} ${questionHeader(question, index)}`;
    tab.addEventListener("click", () => setElicitationIndex(permission, index));
    tabs.append(tab);
  });
  if (hasSubmitQuestionStep(questions)) {
    const submit = document.createElement("button");
    submit.type = "button";
    submit.className = `question-tab submit${state.index === questions.length ? " active" : ""}`;
    submit.textContent = "✓ Submit";
    submit.addEventListener("click", () => setElicitationIndex(permission, questions.length));
    tabs.append(submit);
  }
  nav.append(tabs);

  const count = document.createElement("div");
  count.className = "question-count";
  count.textContent = state.index < questions.length
    ? `(${state.index + 1}/${questions.length})`
    : "(Submit)";
  nav.append(count);

  const next = document.createElement("button");
  next.className = "question-nav-arrow";
  next.type = "button";
  next.textContent = "→";
  next.disabled = state.index >= maxElicitationIndex(questions);
  next.title = "Next";
  next.addEventListener("click", () => setElicitationIndex(permission, state.index + 1));
  nav.append(next);

  return nav;
}

function renderPermissions() {
  permissionsEl.textContent = "";
  for (const permission of permissions.values()) {
    const agentId = permission.agentId || "claude-code";
    const input = permissionInput(permission);
    const kind = permissionKind(permission);
    const descriptor = describePermission(permission, kind, input);
    const card = document.createElement("article");
    card.className = "permission-card";
    card.dataset.id = permission.id;
    card.dataset.agent = agentId;
    card.dataset.kind = kind;

    const head = document.createElement("div");
    head.className = "permission-head";
    const mark = document.createElement("div");
    mark.className = "agent-mark";
    decorateAgentMark(mark, agentId);
    const titleWrap = document.createElement("div");
    titleWrap.className = "permission-title-wrap";
    const title = document.createElement("div");
    title.className = "permission-title";
    title.textContent = descriptor.title;
    titleWrap.append(title);
    if (descriptor.subtitle) {
      const subtitle = document.createElement("div");
      subtitle.className = "permission-subtitle";
      subtitle.textContent = descriptor.subtitle;
      titleWrap.append(subtitle);
    }
    head.append(mark, titleWrap);
    card.append(head);

    card.append(renderPermissionBody(permission, kind, input));

    const actions = document.createElement("div");
    actions.className = "permission-actions";
    if (permission.isCodexNotify) {
      actions.append(actionButton("Got it", "deny", true));
    } else if (permission.isElicitation) {
      // AskUserQuestion controls are rendered inside the question flow.
    } else {
      actions.append(actionButton(allowLabelForKind(kind), "allow", false));
      if (permission.canAlways) actions.append(actionButton("Always", "opencode-always", false));
      permission.suggestions.forEach((suggestion, idx) => {
        actions.append(actionButton(suggestionLabel(suggestion), `suggestion:${idx}`, true, suggestionTone(suggestion)));
      });
      actions.append(actionButton("Deny", "deny", true));
      actions.append(actionButton(terminalLabelForKind(kind), "deny-and-focus", true));
    }

    if (actions.childElementCount) card.append(actions);
    permissionsEl.appendChild(card);
  }
}

function renderElicitationForm(permission) {
  const questions = Array.isArray(permission.questions) ? permission.questions : [];
  const state = getElicitationState(permission);
  const form = document.createElement("div");
  form.className = "elicitation-form";
  form.tabIndex = -1;
  form.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelElicitation(permission);
    }
  });

  form.append(renderQuestionNavigation(permission, questions, state));
  if (state.index >= questions.length) {
    form.append(renderElicitationSubmitView(permission, questions, state));
  } else {
    form.append(renderElicitationQuestionView(permission, questions[state.index], state.index, state));
  }
  return form;
}

function renderElicitationQuestionView(permission, question, qIdx, state) {
  const card = document.createElement("div");
  card.className = "elicitation-question";
  const key = questionKey(question, qIdx);

  const qText = document.createElement("div");
  qText.className = "elicitation-text";
  qText.textContent = question.question || `Question ${qIdx + 1}`;
  card.append(qText);
  if (question.multiSelect) {
    const mode = document.createElement("div");
    mode.className = "elicitation-mode";
    mode.textContent = "Multiple choice · select one or more";
    card.append(mode);
  }

  const options = Array.isArray(question.options) ? question.options : [];
  if (options.length) {
    const list = document.createElement("div");
    list.className = "elicitation-options";
    const groupName = `${permission.id}-q${qIdx}`;
    const inputType = question.multiSelect ? "checkbox" : "radio";
    const selectedSet = new Set(Array.isArray(state.selections[key]) ? state.selections[key] : []);
    options.forEach((option, optionIdx) => {
      const label = document.createElement("label");
      label.className = "elicitation-option";
      const input = document.createElement("input");
      input.type = inputType;
      input.name = groupName;
      input.value = option.label || "";
      input.dataset.question = key;
      input.checked = question.multiSelect
        ? selectedSet.has(option.label)
        : state.answers[key] === option.label;
      if (input.checked) label.classList.add("selected");
      input.addEventListener("change", () => {
        if (question.multiSelect) {
          toggleElicitationSelection(permission, question, qIdx, option.label || "", input.checked);
          return;
        }
        setElicitationAnswer(permission, question, qIdx, option.label || "", false);
      });
      label.append(input, renderElicitationOptionBody(option, optionIdx));
      list.append(label);
    });
    card.append(list);
  }

  card.append(renderOtherAnswer(permission, question, qIdx, state));
  card.append(renderElicitationQuestionActions(permission, question, qIdx));
  return card;
}

function renderElicitationOptionBody(option, optionIdx) {
  const optionBody = document.createElement("span");
  optionBody.className = "elicitation-option-body";
  const optionLabel = document.createElement("span");
  optionLabel.className = "elicitation-option-label";
  const index = document.createElement("span");
  index.className = "elicitation-option-index";
  index.textContent = `${optionIdx + 1}.`;
  const text = document.createElement("span");
  text.className = "elicitation-option-title";
  text.textContent = option.label || "";
  optionLabel.append(index, text);
  optionBody.append(optionLabel);
  if (option.description) {
    const description = document.createElement("span");
    description.className = "elicitation-option-description";
    description.textContent = option.description;
    optionBody.append(description);
  }
  if (option.preview) {
    const preview = document.createElement("span");
    preview.className = "elicitation-option-preview";
    appendVisualizedPreview(preview, option.preview);
    optionBody.append(preview);
  }
  return optionBody;
}

function renderOtherAnswer(permission, question, qIdx, state) {
  const key = questionKey(question, qIdx);
  const row = document.createElement("div");
  row.className = "elicitation-other";
  const label = document.createElement("label");
  label.className = "elicitation-other-label";
  label.textContent = question.multiSelect ? "Other" : "Type something.";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "elicitation-text-input";
  input.value = state.otherText[key] || "";
  input.placeholder = question.multiSelect ? "Add another answer" : "Type an answer";
  input.dataset.question = key;
  input.addEventListener("input", () => setElicitationOtherText(permission, question, qIdx, input.value));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      setElicitationOtherText(permission, question, qIdx, input.value);
      confirmCurrentElicitationQuestion(permission);
    }
  });
  label.append(input);
  const use = document.createElement("button");
  use.type = "button";
  use.className = "action-button secondary compact";
  use.textContent = "Use";
  use.addEventListener("click", () => {
    setElicitationOtherText(permission, question, qIdx, input.value);
    confirmCurrentElicitationQuestion(permission);
  });
  row.append(label, use);
  return row;
}

function renderElicitationQuestionActions(permission, question, qIdx) {
  const actions = document.createElement("div");
  actions.className = "elicitation-flow-actions";
  const state = getElicitationState(permission);
  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.className = "action-button";
  confirm.textContent = question && question.multiSelect ? "Confirm Choice" : "Next";
  confirm.addEventListener("click", () => confirmCurrentElicitationQuestion(permission));
  actions.append(confirm);

  if (qIdx > 0) {
    const back = document.createElement("button");
    back.type = "button";
    back.className = "action-button secondary";
    back.textContent = "Back";
    back.addEventListener("click", () => setElicitationIndex(permission, state.index - 1));
    actions.append(back);
  }

  const chat = document.createElement("button");
  chat.type = "button";
  chat.className = "action-button secondary";
  chat.textContent = "Chat in Terminal";
  chat.addEventListener("click", () => cancelElicitation(permission));
  actions.append(chat);

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "action-button secondary";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => cancelElicitation(permission));
  actions.append(cancel);
  return actions;
}

function renderElicitationSubmitView(permission, questions, state) {
  const view = document.createElement("div");
  view.className = "elicitation-submit-view";
  const title = makeDiv("elicitation-text", "Review your answers");
  view.append(title);

  const unanswered = questions.filter((question, index) => !state.answers[questionKey(question, index)]);
  if (unanswered.length) appendNotice(view, `${unanswered.length} question${unanswered.length === 1 ? "" : "s"} unanswered.`, "warning");

  const list = document.createElement("div");
  list.className = "elicitation-answer-list";
  questions.forEach((question, index) => {
    const key = questionKey(question, index);
    const item = document.createElement("div");
    item.className = "elicitation-answer";
    const prompt = makeDiv("elicitation-answer-question", key);
    const answer = makeDiv("elicitation-answer-value", state.answers[key] || "(No answer provided)");
    item.append(prompt, answer);
    item.addEventListener("click", () => setElicitationIndex(permission, index));
    list.append(item);
  });
  view.append(list);

  const actions = document.createElement("div");
  actions.className = "elicitation-flow-actions";
  const submit = document.createElement("button");
  submit.type = "button";
  submit.className = "action-button";
  submit.textContent = "Submit Answers";
  submit.addEventListener("click", () => submitElicitation(permission));
  actions.append(submit);

  const back = document.createElement("button");
  back.type = "button";
  back.className = "action-button secondary";
  back.textContent = "Back";
  back.addEventListener("click", () => setElicitationIndex(permission, Math.max(0, questions.length - 1)));
  actions.append(back);

  const chat = document.createElement("button");
  chat.type = "button";
  chat.className = "action-button secondary";
  chat.textContent = "Chat in Terminal";
  chat.addEventListener("click", () => cancelElicitation(permission));
  actions.append(chat);

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "action-button secondary";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => cancelElicitation(permission));
  actions.append(cancel);
  view.append(actions);
  return view;
}

function actionButton(label, behavior, secondary, tone = "") {
  const button = document.createElement("button");
  button.className = `action-button${secondary ? " secondary" : ""}${tone ? ` ${tone}` : ""}`;
  button.textContent = label;
  button.addEventListener("click", (event) => {
    const card = event.currentTarget.closest(".permission-card");
    if (card) post("permission-decide", { id: card.dataset.id, behavior });
  });
  return button;
}

function appendVisualizedPreview(target, value) {
  target.textContent = "";
  const text = String(value || "");
  let chunkStart = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "\\") continue;

    let runEnd = i;
    while (text[runEnd] === "\\") runEnd++;
    const runLength = runEnd - i;
    const escaped = text[runEnd];
    if (runLength % 2 === 0 || (escaped !== "n" && escaped !== "r")) {
      i = runEnd - 1;
      continue;
    }

    const literalEnd = runEnd - 1;
    if (literalEnd > chunkStart) target.appendChild(document.createTextNode(text.slice(chunkStart, literalEnd)));

    const marker = document.createElement("span");
    marker.className = "escape-newline";
    marker.title = "newline";
    marker.textContent = "↵";
    target.appendChild(marker);
    target.appendChild(document.createTextNode("\n"));

    let consumeEnd = runEnd + 1;
    if (escaped === "r" && text.slice(runEnd + 1, runEnd + 3) === "\\n") consumeEnd = runEnd + 3;
    chunkStart = consumeEnd;
    i = consumeEnd - 1;
  }
  if (chunkStart < text.length) target.appendChild(document.createTextNode(text.slice(chunkStart)));
}

const ACTIVE_SESSION_STATES = new Set([
  "thinking", "working", "juggling", "carrying",
  "attention", "sweeping", "notification", "error",
]);

const AGENT_NAMES = {
  "claude-code": "Claude",
  "codex": "Codex",
  "gemini-cli": "Gemini",
  "cursor-agent": "Cursor",
  "copilot-cli": "Copilot",
  "opencode": "opencode",
  "codebuddy": "CodeBuddy",
  "kiro-cli": "Kiro",
};

function agentLabel(agentId) {
  return AGENT_NAMES[agentId] || agentId || "Agent";
}

function agentInitials(agentId) {
  return agentLabel(agentId).slice(0, 2);
}

function decorateAgentMark(mark, agentId) {
  const id = agentId || "";
  mark.textContent = "";
  mark.dataset.agent = id;
  mark.title = agentLabel(id);
  const iconUri = config.agentIconMap && config.agentIconMap[id];
  if (iconUri) {
    mark.classList.add("has-icon");
    const img = document.createElement("img");
    img.src = iconUri;
    img.alt = agentLabel(id);
    img.className = "agent-icon";
    mark.appendChild(img);
    return;
  }
  mark.classList.remove("has-icon");
  mark.textContent = agentInitials(id);
}

function makeSessionRow(session) {
  const row = document.createElement("div");
  row.className = "session-row";
  row.dataset.agent = session.agentId || "";
  row.title = session.cwd || session.id;
  row.addEventListener("click", () => post("focus-terminal"));

  const mark = document.createElement("div");
  mark.className = "agent-mark";
  decorateAgentMark(mark, session.agentId);

  const body = document.createElement("div");
  body.style.minWidth = "0";
  const title = document.createElement("div");
  title.className = "session-title";
  title.textContent = session.title || session.folder || session.id;
  const meta = document.createElement("div");
  meta.className = "session-meta";
  const hostPart = session.host ? ` @ ${session.host}` : "";
  meta.textContent = `${agentLabel(session.agentId)} · ${session.state}${hostPart}`;
  body.append(title, meta);
  row.append(mark, body);
  return row;
}

function renderSessions() {
  sessionsEl.textContent = "";
  const active = sessions.filter((s) => ACTIVE_SESSION_STATES.has(s.state));
  const idle = sessions.filter((s) => !ACTIVE_SESSION_STATES.has(s.state));

  for (const session of active) {
    sessionsEl.appendChild(makeSessionRow(session));
  }

  if (idle.length) {
    const details = document.createElement("details");
    details.className = "idle-group";
    if (active.length === 0) details.setAttribute("open", "");
    const summary = document.createElement("summary");
    summary.className = "idle-summary";
    summary.textContent = `Idle (${idle.length})`;
    details.appendChild(summary);
    for (const session of idle) {
      details.appendChild(makeSessionRow(session));
    }
    sessionsEl.appendChild(details);
  }
}

function playSound(uri) {
  if (!uri) return;
  try {
    const audio = new Audio(uri);
    audio.currentTime = 0;
    audio.play().catch(() => {});
  } catch {}
}

function applyInit(payload) {
  config = payload.config || {};
  themes = payload.themes || [];
  themeId = payload.themeId || themeId;
  soundMap = config.soundMap || {};
  runtimePaused = !!payload.paused;
  integrationsEnabled = payload.integrationsEnabled !== false;
  currentState = runtimePaused ? "paused" : (payload.state || "idle");
  currentSvg = payload.svg || (config.idleFollowSvg || "");
  sessions = runtimePaused ? [] : (payload.sessions || []);
  permissions = new Map((runtimePaused ? [] : (payload.permissions || [])).map((permission) => [permission.id, permission]));
  for (const id of [...elicitationStates.keys()]) {
    if (!permissions.has(id)) elicitationStates.delete(id);
  }
  document.body.classList.toggle("is-dnd", !!payload.dnd);
  document.body.classList.toggle("is-runtime-paused", runtimePaused);
  document.body.classList.toggle("is-integrations-disabled", !integrationsEnabled);
  updateThemeButton();
  updateRuntimeButton();
  updateInstallButton();
  setStatus(currentState, payload.serverPort);
  renderPet(currentSvg, currentState, { force: true });
  renderSessions();
  renderPermissions();
}

function handleMessage(event) {
  const message = event.data || {};
  const payload = message.payload || {};
  switch (message.type) {
    case "init":
      applyInit(payload);
      break;
    case "theme-config":
      config = payload.config || {};
      themeId = payload.themeId || themeId;
      soundMap = config.soundMap || {};
      updateThemeButton();
      renderPet(currentSvg || config.idleFollowSvg, currentState, { force: true });
      break;
    case "state-change":
      if (runtimePaused) break;
      currentState = payload.state || "idle";
      currentSvg = payload.svg || currentSvg;
      sessions = payload.sessions || sessions;
      setStatus(currentState);
      if (!(dragState && dragState.dragging)) renderPet(currentSvg, currentState);
      renderSessions();
      break;
    case "permission-show":
      permissions.set(payload.id, payload);
      renderPermissions();
      break;
    case "permission-hide":
      permissions.delete(payload.id);
      elicitationStates.delete(payload.id);
      renderPermissions();
      break;
    case "dnd-change":
      document.body.classList.toggle("is-dnd", !!payload.enabled);
      break;
    case "play-sound":
      playSound(payload.uri || soundMap.confirm);
      break;
    case "install-result":
      showToast(payload.message);
      break;
    default:
      break;
  }
}

installBtn.addEventListener("click", () => {
  post(integrationsEnabled ? "install-integrations" : "enable-integrations");
});
disableIntegrationsBtn.addEventListener("click", () => post("disable-integrations"));
dndBtn.addEventListener("click", () => post("toggle-dnd"));
restartBtn.addEventListener("click", () => post("restart-runtime"));
runtimeBtn.addEventListener("click", () => post(runtimePaused ? "resume-runtime" : "pause-runtime"));
themeBtn.addEventListener("click", () => {
  const next = getNextTheme();
  if (next) post("set-theme", { themeId: next.id });
});

window.addEventListener("message", handleMessage);
post("ready");
