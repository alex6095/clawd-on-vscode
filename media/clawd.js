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
let sessions = [];
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
  stateLabel.textContent = state || "idle";
  if (port !== undefined) serverLabel.textContent = port ? `:${port}` : "off";
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

function renderPermissions() {
  permissionsEl.textContent = "";
  for (const permission of permissions.values()) {
    const card = document.createElement("article");
    card.className = "permission-card";
    card.dataset.id = permission.id;

    const head = document.createElement("div");
    head.className = "permission-head";
    const mark = document.createElement("div");
    mark.className = "agent-mark";
    mark.textContent = (permission.agentId || "AI").slice(0, 2);
    const title = document.createElement("div");
    title.className = "permission-title";
    let titleText;
    if (permission.isCodexNotify) titleText = "Codex approval requested";
    else if (permission.isElicitation) titleText = "Question from agent";
    else titleText = permission.toolName;
    title.textContent = titleText;
    head.append(mark, title);
    card.append(head);

    if (permission.isElicitation && Array.isArray(permission.questions) && permission.questions.length) {
      const form = renderElicitationForm(permission);
      card.append(form);
    } else {
      const pre = document.createElement("pre");
      pre.className = "permission-input";
      pre.textContent = permission.inputPreview || "";
      card.append(pre);
    }

    const actions = document.createElement("div");
    actions.className = "permission-actions";
    if (permission.isCodexNotify) {
      actions.append(actionButton("Got it", "deny", true));
    } else if (permission.isElicitation) {
      const submit = document.createElement("button");
      submit.className = "action-button";
      submit.textContent = "Submit";
      submit.addEventListener("click", () => {
        const answers = collectElicitationAnswers(card, permission.questions);
        post("permission-decide", { id: permission.id, behavior: { type: "elicitation-submit", answers } });
      });
      actions.append(submit);
      actions.append(actionButton("Cancel", "deny", true));
    } else {
      actions.append(actionButton("Allow", "allow", false));
      if (permission.canAlways) actions.append(actionButton("Always", "opencode-always", false));
      actions.append(actionButton("Deny", "deny", true));
      actions.append(actionButton("Terminal", "deny-and-focus", true));
      permission.suggestions.forEach((suggestion, idx) => {
        const label = suggestion.type === "setMode" ? `Mode: ${suggestion.mode}` : "Add rule";
        actions.append(actionButton(label, `suggestion:${idx}`, true));
      });
    }

    card.append(actions);
    permissionsEl.appendChild(card);
  }
}

function renderElicitationForm(permission) {
  const form = document.createElement("div");
  form.className = "elicitation-form";
  permission.questions.forEach((question, qIdx) => {
    const card = document.createElement("div");
    card.className = "elicitation-question";
    const qText = document.createElement("div");
    qText.className = "elicitation-text";
    qText.textContent = question.question || `Question ${qIdx + 1}`;
    card.append(qText);
    const options = Array.isArray(question.options) ? question.options : [];
    if (options.length) {
      const list = document.createElement("div");
      list.className = "elicitation-options";
      const groupName = `${permission.id}-q${qIdx}`;
      const inputType = question.multiSelect ? "checkbox" : "radio";
      options.forEach((option) => {
        const label = document.createElement("label");
        label.className = "elicitation-option";
        const input = document.createElement("input");
        input.type = inputType;
        input.name = groupName;
        input.value = option.label || "";
        input.dataset.question = question.question || "";
        const span = document.createElement("span");
        span.textContent = option.label || "";
        label.append(input, span);
        list.append(label);
      });
      card.append(list);
    } else {
      const input = document.createElement("input");
      input.type = "text";
      input.className = "elicitation-text-input";
      input.dataset.question = question.question || "";
      card.append(input);
    }
    form.append(card);
  });
  return form;
}

function collectElicitationAnswers(card, questions) {
  const answers = {};
  const inputs = card.querySelectorAll("input[data-question]");
  for (const input of inputs) {
    const q = input.dataset.question;
    if (!q) continue;
    if (input.type === "radio") {
      if (input.checked) answers[q] = input.value;
    } else if (input.type === "checkbox") {
      if (input.checked) answers[q] = [...(answers[q] ? [answers[q]] : []), input.value].join(", ");
    } else if (input.type === "text") {
      if (input.value) answers[q] = input.value;
    }
  }
  return answers;
}

function actionButton(label, behavior, secondary) {
  const button = document.createElement("button");
  button.className = `action-button${secondary ? " secondary" : ""}`;
  button.textContent = label;
  button.addEventListener("click", (event) => {
    const card = event.currentTarget.closest(".permission-card");
    if (card) post("permission-decide", { id: card.dataset.id, behavior });
  });
  return button;
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

function makeSessionRow(session) {
  const row = document.createElement("div");
  row.className = "session-row";
  row.dataset.agent = session.agentId || "";
  row.title = session.cwd || session.id;
  row.addEventListener("click", () => post("focus-terminal"));

  const mark = document.createElement("div");
  mark.className = "agent-mark";
  const iconUri = config.agentIconMap && config.agentIconMap[session.agentId];
  if (iconUri) {
    const img = document.createElement("img");
    img.src = iconUri;
    img.alt = agentLabel(session.agentId);
    img.className = "agent-icon";
    mark.appendChild(img);
  } else {
    mark.textContent = agentInitials(session.agentId);
  }

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
  currentState = payload.state || "idle";
  currentSvg = payload.svg || (config.idleFollowSvg || "");
  sessions = payload.sessions || [];
  permissions = new Map((payload.permissions || []).map((permission) => [permission.id, permission]));
  document.body.classList.toggle("is-dnd", !!payload.dnd);
  updateThemeButton();
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

installBtn.addEventListener("click", () => post("install-integrations"));
dndBtn.addEventListener("click", () => post("toggle-dnd"));
restartBtn.addEventListener("click", () => post("restart-runtime"));
themeBtn.addEventListener("click", () => {
  const next = getNextTheme();
  if (next) post("set-theme", { themeId: next.id });
});

window.addEventListener("message", handleMessage);
post("ready");
