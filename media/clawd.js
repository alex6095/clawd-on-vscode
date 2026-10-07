"use strict";

const vscode = acquireVsCodeApi();
const svgStyleNonce = document.currentScript && (document.currentScript.nonce || document.currentScript.getAttribute("nonce"));

const petStage = document.getElementById("petStage");
const petContainer = document.getElementById("petContainer");
const permissionsEl = document.getElementById("permissions");
const sessionsEl = document.getElementById("sessions");
const activityLabel = document.getElementById("activityLabel");
const activityNote = document.getElementById("activityNote");
const toastLog = document.getElementById("toastLog");

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
let connectionState = "starting";
let notificationsQuiet = false;
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
let suppressClickTimer = null;
let currentAssetKey = null;
let pendingAssetKey = null;
let hostVisible = true;
let reducedMotion = false;
let preview = null;
let previewTimer = null;
let idleAnimation = null;
let idleWaitTimer = null;
let idleEndTimer = null;
let lastIdleFile = null;
const svgCache = new Map();
const motionQuery = typeof window.matchMedia === "function"
  ? window.matchMedia("(prefers-reduced-motion: reduce)")
  : null;

const DRAG_THRESHOLD = 4;
const IDLE_WAIT_MIN = 14000;
const IDLE_WAIT_MAX = 28000;

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

function activityText(state) {
  const labels = {
    idle: "Ready when you are",
    thinking: "Thinking…",
    working: "At work",
    juggling: "At work",
    carrying: "At work",
    attention: "All done",
    sweeping: "Organizing context…",
    notification: "Needs your attention",
    happy: "All done",
    error: "Something needs attention",
    sleeping: "Resting",
    yawning: "Getting sleepy",
    dozing: "Resting",
    collapsing: "Resting",
    waking: "Waking up…",
    paused: "Paused",
  };
  return labels[state] || "Ready when you are";
}

function animationLabel(state) {
  return String(state || "animation").replace(/^pose-/, "").replace(/[-_]/g, " ");
}

function updateActivity() {
  let label;
  let note = "";
  if (preview) {
    label = "Previewing animation";
    note = animationLabel(preview.state);
  } else if (runtimePaused || !integrationsEnabled || connectionState === "paused") {
    label = "Paused";
    note = "Resume Clawd from the title bar.";
  } else if (connectionState === "starting") {
    label = "Waking up…";
  } else if (connectionState === "disconnected") {
    label = "Connection interrupted";
    note = "Open Agent Connection Status in the menu.";
  } else if (permissions.size) {
    label = permissions.size === 1 ? "Needs your approval" : `${permissions.size} approvals waiting`;
  } else {
    label = activityText(currentState);
  }
  if (notificationsQuiet && !note) note = "Quiet notifications · Approvals stay in your agent.";
  activityLabel.textContent = label;
  activityNote.textContent = note;
  activityNote.hidden = !note;
  activityLabel.dataset.status = preview ? "preview" : (runtimePaused || !integrationsEnabled ? "paused" : connectionState);
  updatePetInteraction();
}

function petIsInteractive() {
  return !runtimePaused && integrationsEnabled && connectionState === "connected" && animationsVisible();
}

function updatePetInteraction() {
  const enabled = petIsInteractive();
  const themeName = (themes.find((theme) => theme.id === themeId) || {}).name || themeId;
  const unavailable = runtimePaused || !integrationsEnabled || connectionState === "paused"
    ? "Paused"
    : connectionState === "starting" ? "Waking up…" : connectionState === "disconnected" ? "Connection interrupted" : activityText(currentState);
  const description = preview ? `Previewing ${animationLabel(preview.state)}` : enabled ? activityText(currentState) : unavailable;
  const action = enabled ? ` ${currentState === "idle" ? "Click for a reaction. " : ""}Press Enter or Space to show the agent terminal.` : "";
  petStage.setAttribute("aria-label", `${themeName}: ${description}.${action}`);
  petStage.setAttribute("aria-disabled", String(!enabled));
  petStage.tabIndex = enabled ? 0 : -1;
  petStage.classList.toggle("is-pet-disabled", !enabled);
  if (!enabled) {
    cancelPetDrag();
    applyEyeMove(0, 0);
    stopLayerTrackingLoop();
  }
}

function showToast(message) {
  toastLog.textContent = message || "";
  if (message) setTimeout(() => {
    if (toastLog.textContent === message) toastLog.textContent = "";
  }, 5000);
}

function needsInlineSvg(state, file) {
  // Inline every SVG so hidden-view and motion preferences can pause its
  // internal CSS/SMIL animations, including non-tracking working states.
  return !!file && file.toLowerCase().endsWith(".svg");
}

function animationsVisible() {
  return hostVisible && !document.hidden;
}

function updateMotionPreference() {
  const preference = config.reducedMotion || "system";
  const wasReduced = reducedMotion;
  reducedMotion = preference === "on" || (preference !== "off" && !!(motionQuery && motionQuery.matches));
  document.body.classList.toggle("is-reduced-motion", reducedMotion);
  document.body.dataset.motion = preference;
  const svg = currentWrapper && currentWrapper.querySelector("svg");
  if (svg) {
    if (preference === "off") svg.setAttribute("data-force-motion", "");
    else svg.removeAttribute("data-force-motion");
    if (reducedMotion && typeof svg.pauseAnimations === "function") svg.pauseAnimations();
    else if (animationsVisible() && typeof svg.unpauseAnimations === "function") svg.unpauseAnimations();
  }
  if (reducedMotion) {
    applyEyeMove(0, 0);
    stopLayerTrackingLoop();
    freezeRaster(currentWrapper);
  } else if (wasReduced && currentWrapper && currentWrapper.querySelector("canvas")) {
    renderDisplayedPet({ force: true });
  }
  syncIdleAnimation();
}

function setAnimationVisibility(visible) {
  hostVisible = visible !== false;
  updatePetInteraction();
  const shown = animationsVisible();
  document.body.classList.toggle("is-view-hidden", !shown);
  const svg = currentWrapper && currentWrapper.querySelector("svg");
  if (!shown) {
    ++renderSerial; // A hidden view must not publish a stale in-flight asset.
    pendingAssetKey = null;
    applyEyeMove(0, 0);
    stopLayerTrackingLoop();
    if (svg && typeof svg.pauseAnimations === "function") svg.pauseAnimations();
    freezeRaster(currentWrapper);
    if (dragState) finishDrag({ pointerId: dragState.pointerId });
  } else {
    if (svg && !reducedMotion && typeof svg.unpauseAnimations === "function") svg.unpauseAnimations();
    renderDisplayedPet({ force: !!(currentWrapper && currentWrapper.querySelector("canvas")) });
  }
  syncIdleAnimation();
}

function freezeRaster(wrapper) {
  if (!wrapper) return;
  const img = wrapper.querySelector("img");
  if (!img || !img.complete || !img.naturalWidth) return;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.setAttribute("aria-hidden", "true");
    canvas.getContext("2d").drawImage(img, 0, 0);
    img.replaceWith(canvas);
    img.removeAttribute("src"); // Stop decoding the off-screen APNG.
  } catch { /* A still image can remain visible if a canvas is unavailable. */ }
}

function renderDisplayedPet(options = {}) {
  if (preview) return renderPet(preview.svg, preview.state, options);
  if (idleAnimation) return renderPet(idleAnimation.file, "idle-reaction", options);
  return renderPet(currentSvg || config.idleFollowSvg, currentState, options);
}

function idleAnimationChoices() {
  const seen = new Set();
  return (Array.isArray(config.idleAnimations) ? config.idleAnimations : []).filter((entry) => {
    if (!entry || typeof entry.file !== "string" || !fileUri(entry.file)) return false;
    const file = baseName(entry.file);
    if (file === baseName(config.idleFollowSvg) || seen.has(file)) return false;
    seen.add(file);
    return true;
  });
}

function canPlayIdleAnimation() {
  return currentState === "idle" && petIsInteractive() && !reducedMotion
    && !preview && !reactionTimer && !dragState && !permissions.size
    && !sessions.some((session) => ACTIVE_SESSION_STATES.has(session.state));
}

function cancelIdleAnimation(restore = false) {
  if (idleWaitTimer) clearTimeout(idleWaitTimer);
  if (idleEndTimer) clearTimeout(idleEndTimer);
  idleWaitTimer = null;
  idleEndTimer = null;
  const interrupted = idleAnimation;
  idleAnimation = null;
  if (!interrupted) return false;
  // Cancel pending SVG loads even when the neutral asset is already on screen.
  ++renderSerial;
  pendingAssetKey = null;
  if (currentWrapper && currentAssetName === baseName(interrupted.file)) {
    for (const node of [currentWrapper, ...currentWrapper.querySelectorAll("*")]) {
      node.style.setProperty("animation-play-state", "paused", "important");
    }
    const svg = currentWrapper.querySelector("svg");
    if (svg && typeof svg.pauseAnimations === "function") svg.pauseAnimations();
    freezeRaster(currentWrapper);
  }
  if (restore) renderDisplayedPet({ force: true });
  return true;
}

function syncIdleAnimation() {
  if (!canPlayIdleAnimation()) {
    cancelIdleAnimation(true);
    return;
  }
  if (idleAnimation || idleWaitTimer) return;
  // Measure the quiet gap from a visible neutral pet, including after an
  // initial asset load or a manual reaction that took time to return.
  if (!currentWrapper || currentAssetName !== baseName(currentSvg || config.idleFollowSvg)) return;
  if (!idleAnimationChoices().length) return;
  const delay = IDLE_WAIT_MIN + Math.floor(Math.random() * (IDLE_WAIT_MAX - IDLE_WAIT_MIN + 1));
  idleWaitTimer = setTimeout(async () => {
    idleWaitTimer = null;
    if (!canPlayIdleAnimation()) return;
    const choices = idleAnimationChoices();
    const next = choices.length > 1 ? choices.filter((entry) => baseName(entry.file) !== lastIdleFile) : choices;
    if (!next.length) return;
    const pose = next[Math.floor(Math.random() * next.length)];
    idleAnimation = pose;
    lastIdleFile = baseName(pose.file);
    await renderDisplayedPet({ force: true });
    if (idleAnimation !== pose) return;
    if (!canPlayIdleAnimation() || currentAssetName !== baseName(pose.file)) {
      cancelIdleAnimation(true);
      syncIdleAnimation();
      return;
    }
    const duration = Number.isFinite(pose.duration) ? Math.min(8000, Math.max(1000, pose.duration)) : 4500;
    idleEndTimer = setTimeout(() => {
      idleEndTimer = null;
      idleAnimation = null;
      renderDisplayedPet({ force: true });
      syncIdleAnimation();
    }, duration);
  }, delay);
}

function cancelPreview() {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = null;
  preview = null;
}

function previewAnimation(payload) {
  if (!payload.svg || !fileUri(payload.svg)) return;
  cancelIdleAnimation();
  cancelPreview();
  if (reactionTimer) clearTimeout(reactionTimer);
  reactionTimer = null;
  preview = { svg: payload.svg, state: payload.state || "preview" };
  const duration = Number.isFinite(payload.duration) ? Math.min(30000, Math.max(500, payload.duration)) : 6000;
  updateActivity();
  renderDisplayedPet({ force: true });
  previewTimer = setTimeout(() => {
    cancelPreview();
    updateActivity();
    renderDisplayedPet({ force: true });
    syncIdleAnimation();
  }, duration);
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
  petStage.style.setProperty("--pet-floor-bottom", `${Math.max(10, rect.height * (layout.baselineBottomRatio || 0.05))}px`);
}

function relayoutPet() {
  if (currentWrapper && currentAssetName) applyPetLayout(currentWrapper, currentAssetName);
}

function updateTheme() {
  document.body.dataset.theme = themeId || "";
}

async function renderPet(file, state, options = {}) {
  // Connection changes must update accessibility even when this asset is cached.
  updatePetInteraction();
  const name = baseName(file);
  if (!name || !animationsVisible()) return;
  const uri = fileUri(name);
  if (!uri) {
    ++renderSerial;
    pendingAssetKey = null;
    clearTracking();
    petContainer.textContent = "";
    currentAssetName = null;
    currentAssetKey = null;
    currentWrapper = null;
    return;
  }
  const key = `${uri}\n${state}`;
  // Do this before incrementing renderSerial: repeated events while fetching
  // the same SVG used to invalidate its own load and leave an empty stage.
  if (!options.force && (currentAssetKey === key || pendingAssetKey === key)) return;
  const serial = ++renderSerial;
  pendingAssetKey = key;

  const wrapper = document.createElement("div");
  wrapper.className = "pet-asset";
  wrapper.dataset.file = name;
  applyPetLayout(wrapper, name);

  try {
    if (needsInlineSvg(state, name)) {
      let loading = svgCache.get(uri);
      if (!loading) {
        loading = fetch(uri).then((response) => {
          if (!response.ok) throw new Error("SVG resource unavailable");
          return response.text();
        });
        svgCache.set(uri, loading);
        loading.catch(() => svgCache.delete(uri));
        if (svgCache.size > 80) svgCache.delete(svgCache.keys().next().value);
      }
      const text = await loading;
      if (serial !== renderSerial || !animationsVisible()) return;
      wrapper.innerHTML = text;
      const svg = wrapper.querySelector("svg");
      if (!svg) throw new Error("SVG resource has no SVG root");
      svg.removeAttribute("width");
      svg.removeAttribute("height");
      // The webview uses a nonce-based CSP. Chromium ignores unsafe-inline
      // when a nonce is present, so trusted SVG styles need the script nonce.
      for (const style of svg.querySelectorAll("style")) {
        if (svgStyleNonce) style.setAttribute("nonce", svgStyleNonce);
      }
      if (config.reducedMotion === "off") svg.setAttribute("data-force-motion", "");
    } else {
      const img = document.createElement("img");
      img.alt = "";
      img.draggable = false;
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error("Pet image unavailable"));
        img.src = uri;
      });
      if (serial !== renderSerial || !animationsVisible()) return;
      wrapper.appendChild(img);
    }
  } catch {
    if (serial !== renderSerial) return;
    pendingAssetKey = null;
    // Keep the already rendered pet if a replacement is unavailable.
    showToast(`Could not load ${name}.`);
    return;
  }

  if (serial !== renderSerial || !animationsVisible()) return;
  clearTracking();
  const previous = currentWrapper;
  for (const stale of petContainer.querySelectorAll(".pet-asset.is-retiring")) stale.remove();
  currentWrapper = wrapper;
  currentAssetName = name;
  currentAssetKey = key;
  pendingAssetKey = null;
  applyPetLayout(wrapper, name); // Sidebar size may have changed during fetch.
  if (dragState && dragState.dragging) setDragOffset(dragState.dx, dragState.dy, wrapper);
  const svg = wrapper.querySelector("svg");
  if (svg) {
    const trackingStates = Array.isArray(config.eyeTrackingStates) ? config.eyeTrackingStates : [];
    if (trackingStates.includes(state)) attachTracking(svg);
    namespaceSvg(svg, serial);
    if (reducedMotion && typeof svg.pauseAnimations === "function") svg.pauseAnimations();
  }
  petContainer.appendChild(wrapper);
  if (reducedMotion) freezeRaster(wrapper);
  updatePetInteraction();
  const transition = config.transitions && config.transitions[name];
  const fadeDuration = reducedMotion || (dragState && dragState.dragging) ? 0 : Math.min(240, Math.max(100, (transition && transition.in) || 140));
  wrapper.style.setProperty("--pet-fade-duration", `${fadeDuration}ms`);
  if (fadeDuration) wrapper.classList.add("fade-in");
  if (previous) {
    if (!fadeDuration) previous.remove();
    else {
      previous.style.setProperty("--pet-fade-duration", `${fadeDuration}ms`);
      previous.classList.remove("fade-in");
      previous.classList.add("is-retiring");
      setTimeout(() => previous.remove(), fadeDuration);
    }
  }
  syncIdleAnimation();
}

function namespaceSvg(svg, serial) {
  // Old/new assets briefly share the DOM during a crossfade. Unique IDs keep
  // a new gradient/clip-path from resolving to a retiring asset's definition.
  const ids = new Map();
  for (const node of svg.querySelectorAll("[id]")) {
    ids.set(node.id, `pet-${serial}-${node.id}`);
    node.id = ids.get(node.id);
  }
  const replaceId = (value) => value.replace(/#([A-Za-z_][\w:.-]*)/g, (match, id) => ids.has(id) ? `#${ids.get(id)}` : match);
  for (const node of [svg, ...svg.querySelectorAll("*")]) {
    for (const attr of Array.from(node.attributes || [])) {
      if (attr.name === "id") continue;
      if (attr.name === "aria-labelledby" || attr.name === "aria-describedby") {
        node.setAttribute(attr.name, attr.value.split(/\s+/).map((id) => ids.get(id) || id).join(" "));
      } else if (attr.value.includes("#")) node.setAttribute(attr.name, replaceId(attr.value));
    }
    if (node.tagName.toLowerCase() === "style") node.textContent = replaceId(node.textContent);
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
  stopLayerTrackingLoop();
  tracking = null;
  layerTracking = null;
  layerTargetDx = 0;
  layerTargetDy = 0;
}

function stopLayerTrackingLoop() {
  if (layerAnimFrame) cancelAnimationFrame(layerAnimFrame);
  layerAnimFrame = null;
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
  if (layerAnimFrame || reducedMotion || !animationsVisible()) return;

  const tick = () => {
    if (!layerTracking || reducedMotion || !animationsVisible()) {
      layerAnimFrame = null;
      return;
    }

    const themeMax = (config.eyeTracking && config.eyeTracking.maxOffset) || 20;
    let moving = false;
    for (const layer of Object.values(layerTracking)) {
      const scale = layer.maxOffset / themeMax;
      const tx = layerTargetDx * scale;
      const ty = layerTargetDy * scale;
      layer.x += (tx - layer.x) * layer.ease;
      layer.y += (ty - layer.y) * layer.ease;
      if (Math.abs(tx - layer.x) < 0.03 && Math.abs(ty - layer.y) < 0.03) {
        layer.x = tx;
        layer.y = ty;
      } else {
        moving = true;
      }
      const x = Math.round(layer.x * 4) / 4;
      const y = Math.round(layer.y * 4) / 4;
      for (const wrapper of layer.wrappers) wrapper.setAttribute("transform", `translate(${x}, ${y})`);
    }

    layerAnimFrame = moving ? requestAnimationFrame(tick) : null;
  };

  layerAnimFrame = requestAnimationFrame(tick);
}

function applyEyeMove(dx, dy) {
  if (reducedMotion || !animationsVisible()) { dx = 0; dy = 0; }
  if (layerTracking) {
    layerTargetDx = dx;
    layerTargetDy = dy;
    if (reducedMotion || !animationsVisible()) {
      for (const layer of Object.values(layerTracking)) {
        layer.x = layer.y = 0;
        for (const wrapper of layer.wrappers) wrapper.setAttribute("transform", "translate(0, 0)");
      }
      return;
    }
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
  if (!petIsInteractive() || reducedMotion || (dragState && dragState.dragging)) return;
  const maxOffset = (config.eyeTracking && config.eyeTracking.maxOffset) || 3;
  const rect = petStage.getBoundingClientRect();
  const petRect = currentWrapper ? currentWrapper.getBoundingClientRect() : rect;
  const eye = config.eyeTracking || {};
  const cx = petRect.left + petRect.width * (Number.isFinite(eye.eyeRatioX) ? eye.eyeRatioX : 0.5);
  const cy = petRect.top + petRect.height * (Number.isFinite(eye.eyeRatioY) ? eye.eyeRatioY : 0.56);
  const rawX = (event.clientX - cx) / Math.max(1, rect.width / 2);
  const rawY = (event.clientY - cy) / Math.max(1, rect.height / 2);
  const dx = Math.max(-maxOffset, Math.min(maxOffset, rawX * maxOffset));
  const dy = Math.max(-maxOffset, Math.min(maxOffset, rawY * maxOffset));
  applyEyeMove(Math.round(dx * 2) / 2, Math.round(dy * 2) / 2);
}

function isPointOverPet(event) {
  const rect = getPetHitRect();
  if (!rect) return false;
  const pad = event.pointerType === "touch" ? 12 : 4;
  return event.clientX >= rect.left - pad
    && event.clientX <= rect.right + pad
    && event.clientY >= rect.top - pad
    && event.clientY <= rect.bottom + pad;
}

function getPetHitRect() {
  if (!currentWrapper) return null;
  const rect = currentWrapper.getBoundingClientRect();
  const vb = getViewBox();
  const wide = Array.isArray(config.wideHitboxFiles) && config.wideHitboxFiles.includes(currentAssetName);
  const sleeping = Array.isArray(config.sleepingHitboxFiles) && config.sleepingHitboxFiles.includes(currentAssetName);
  const boxes = config.hitBoxes || {};
  const content = config.layout && config.layout.contentBox;
  const box = (sleeping ? boxes.sleeping : wide ? boxes.wide : boxes.default)
    || (content && { x: content.x, y: content.y, w: content.width, h: content.height });
  if (!box || !(box.w > 0) || !(box.h > 0)) return rect;
  const left = rect.left + (box.x - vb.x) * rect.width / vb.width;
  const top = rect.top + (box.y - vb.y) * rect.height / vb.height;
  return { left, top, right: left + box.w * rect.width / vb.width, bottom: top + box.h * rect.height / vb.height };
}

function setDragOffset(dx, dy, wrapper = currentWrapper) {
  if (!wrapper) return;
  wrapper.style.setProperty("--drag-x", `${Math.round(dx)}px`);
  wrapper.style.setProperty("--drag-y", `${Math.round(dy)}px`);
}

function startPotentialDrag(event) {
  if (!petIsInteractive()) return;
  if (event.button !== undefined && event.button !== 0) return;
  if (!isPointOverPet(event)) return;
  cancelIdleAnimation(true);
  if (suppressClickTimer) clearTimeout(suppressClickTimer);
  suppressNextClick = false;
  const stage = petStage.getBoundingClientRect();
  const hit = getPetHitRect();
  dragState = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    dx: 0,
    dy: 0,
    dragging: false,
    minDx: stage.left - hit.left + 4,
    maxDx: stage.right - hit.right - 4,
    minDy: stage.top - hit.top + 4,
    maxDy: stage.bottom - hit.bottom - 4,
  };
  try { petStage.setPointerCapture(event.pointerId); } catch {}
}

function updateDrag(event) {
  if (!petIsInteractive()) { cancelPetDrag(); return; }
  if (!dragState || dragState.pointerId !== event.pointerId) return;
  const dx = event.clientX - dragState.startX;
  const dy = event.clientY - dragState.startY;
  dragState.dx = Math.max(dragState.minDx, Math.min(dragState.maxDx, dx));
  dragState.dy = Math.max(dragState.minDy, Math.min(dragState.maxDy, dy));

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
    setDragOffset(dragState.dx, dragState.dy);
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
    setDragOffset(0, 0);
    // pointercancel may never produce click; do not swallow the next real one.
    suppressClickTimer = setTimeout(() => { suppressNextClick = false; }, 250);
    renderDisplayedPet({ force: true });
  }
  syncIdleAnimation();
}

function cancelPetDrag() {
  if (!dragState) return;
  const pointerId = dragState.pointerId;
  dragState = null;
  try {
    if (petStage.hasPointerCapture(pointerId)) petStage.releasePointerCapture(pointerId);
  } catch {}
  petStage.classList.remove("is-dragging");
  setDragOffset(0, 0);
  suppressNextClick = false;
  if (suppressClickTimer) clearTimeout(suppressClickTimer);
  suppressClickTimer = null;
}

petStage.addEventListener("pointerdown", startPotentialDrag);

petStage.addEventListener("pointermove", (event) => {
  updateEyeFromPointer(event);
  updateDrag(event);
});

petStage.addEventListener("pointerleave", () => applyEyeMove(0, 0));
petStage.addEventListener("pointerup", finishDrag);
petStage.addEventListener("pointercancel", finishDrag);
petStage.addEventListener("lostpointercapture", finishDrag);

petStage.addEventListener("click", (event) => {
  if (!petIsInteractive()) return;
  if (suppressNextClick) {
    suppressNextClick = false;
    event.preventDefault();
    return;
  }
  if (!isPointOverPet(event)) return;
  cancelIdleAnimation(true);
  cancelPreview();
  updateActivity();
  if (currentState !== "idle") {
    post("focus-terminal");
    return;
  }
  const reactions = config.reactions || {};
  const rect = petStage.getBoundingClientRect();
  const side = event.clientX < rect.left + rect.width / 2 ? "clickLeft" : "clickRight";
  const reaction = event.detail >= 4 ? reactions.annoyed : event.detail >= 2 ? reactions.double : reactions[side] || reactions.annoyed;
  const file = reaction && (reaction.file || (Array.isArray(reaction.files) && reaction.files[(event.detail || 0) % reaction.files.length]));
  if (!file) {
    post("focus-terminal");
    syncIdleAnimation();
    return;
  }
  if (reactionTimer) clearTimeout(reactionTimer);
  renderPet(file, "reaction", { force: true });
  reactionTimer = setTimeout(() => {
    reactionTimer = null;
    renderDisplayedPet({ force: true });
    syncIdleAnimation();
  }, reaction.duration || 2500);
});

petStage.setAttribute("role", "button");
updatePetInteraction();
petStage.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  if (!petIsInteractive()) return;
  event.preventDefault();
  cancelIdleAnimation(true);
  syncIdleAnimation();
  post("focus-terminal");
});

if (motionQuery) {
  if (typeof motionQuery.addEventListener === "function") motionQuery.addEventListener("change", updateMotionPreference);
  else if (typeof motionQuery.addListener === "function") motionQuery.addListener(updateMotionPreference);
}
document.addEventListener("visibilitychange", () => setAnimationVisibility(hostVisible));

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
      renderShellBody(body, input);
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

function renderShellBody(body, input) {
  const command = input.command || "";
  // The heading already identifies the shell and promotes its description.
  const meta = renderMeta([
    { label: "Directory", value: compactPath(input.cwd) },
    { label: "Timeout", value: input.timeout === undefined ? undefined : `${input.timeout} ms` },
    { label: "Background", value: input.run_in_background ? "Yes" : undefined },
  ]);
  if (meta.childElementCount) body.append(meta);
  if (input.dangerouslyDisableSandbox) appendNotice(body, "This command requests execution outside the sandbox.", "warning");
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
  row.dataset.sessionId = session.id || "";
  row.tabIndex = 0;
  row.setAttribute("role", "button");
  const focus = () => post("focus-terminal", { sessionId: session.id });
  row.addEventListener("click", focus);
  row.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    focus();
  });

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
  meta.textContent = `${agentLabel(session.agentId)} · ${activityText(session.state)}${hostPart}`;
  body.append(title, meta);
  row.append(mark, body);
  row.setAttribute("aria-label", `Open ${agentLabel(session.agentId)} terminal: ${title.textContent}. ${activityText(session.state)}.`);
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
    summary.textContent = `Resting (${idle.length})`;
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
  cancelIdleAnimation();
  cancelPreview();
  if (reactionTimer) clearTimeout(reactionTimer);
  reactionTimer = null;
  config = payload.config || {};
  themes = payload.themes || [];
  themeId = payload.themeId || themeId;
  soundMap = config.soundMap || {};
  runtimePaused = !!payload.paused;
  integrationsEnabled = payload.integrationsEnabled !== false;
  connectionState = payload.connectionState || (runtimePaused ? "paused" : (payload.serverPort ? "connected" : "disconnected"));
  notificationsQuiet = !!payload.dnd;
  currentState = runtimePaused ? "paused" : (payload.state || "idle");
  currentSvg = payload.svg || (config.idleFollowSvg || "");
  sessions = runtimePaused ? [] : (payload.sessions || []);
  permissions = new Map((runtimePaused ? [] : (payload.permissions || [])).map((permission) => [permission.id, permission]));
  for (const id of [...elicitationStates.keys()]) {
    if (!permissions.has(id)) elicitationStates.delete(id);
  }
  document.body.classList.toggle("is-dnd", notificationsQuiet);
  document.body.classList.toggle("is-runtime-paused", runtimePaused);
  document.body.classList.toggle("is-integrations-disabled", !integrationsEnabled);
  updateTheme();
  updateMotionPreference();
  updateActivity();
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
      cancelIdleAnimation();
      cancelPreview();
      if (reactionTimer) clearTimeout(reactionTimer);
      reactionTimer = null;
      config = payload.config || {};
      themeId = payload.themeId || themeId;
      themes = payload.themes || themes;
      soundMap = config.soundMap || {};
      currentSvg = payload.svg || (fileUri(currentSvg) ? currentSvg : config.idleFollowSvg);
      updateTheme();
      updateMotionPreference();
      renderDisplayedPet({ force: true });
      updateActivity();
      syncIdleAnimation();
      break;
    case "runtime-status":
      connectionState = payload.connectionState || connectionState;
      if (typeof payload.paused === "boolean") runtimePaused = payload.paused;
      if (typeof payload.integrationsEnabled === "boolean") integrationsEnabled = payload.integrationsEnabled;
      document.body.classList.toggle("is-runtime-paused", runtimePaused);
      document.body.classList.toggle("is-integrations-disabled", !integrationsEnabled);
      updateActivity();
      syncIdleAnimation();
      break;
    case "preview-animation":
      previewAnimation(payload);
      break;
    case "visibility-change":
      setAnimationVisibility(payload.visible);
      break;
    case "state-change":
      if (runtimePaused) break;
      cancelIdleAnimation();
      currentState = payload.state || "idle";
      currentSvg = payload.svg || currentSvg;
      sessions = payload.sessions || sessions;
      connectionState = payload.connectionState || "connected";
      updateActivity();
      if (!preview && !(dragState && dragState.dragging)) {
        if (reactionTimer) clearTimeout(reactionTimer);
        reactionTimer = null;
        renderDisplayedPet();
      }
      renderSessions();
      syncIdleAnimation();
      break;
    case "permission-show":
      permissions.set(payload.id, payload);
      renderPermissions();
      updateActivity();
      syncIdleAnimation();
      break;
    case "permission-hide":
      permissions.delete(payload.id);
      elicitationStates.delete(payload.id);
      renderPermissions();
      updateActivity();
      syncIdleAnimation();
      break;
    case "dnd-change":
      notificationsQuiet = !!payload.enabled;
      document.body.classList.toggle("is-dnd", notificationsQuiet);
      updateActivity();
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

window.addEventListener("message", handleMessage);
post("ready");
