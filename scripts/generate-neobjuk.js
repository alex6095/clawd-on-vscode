"use strict";

// Code-native artwork for the user's KAIST Neobjuk reference. Keep the same
// canvas and floor in every pose so a state change never changes pet scale.
const fs = require("node:fs");
const path = require("node:path");

const themeDir = path.join(__dirname, "..", "vendor", "clawd", "themes", "neobjuk");
const assetsDir = path.join(themeDir, "assets");
// These measurements follow the center neutral pose, rather than inventing
// independent proportions for each emotion. A limb pivots inside its torso.
const ANATOMY = Object.freeze({
  neck: [120, 140], leftShoulder: [99, 142], rightShoulder: [141, 142],
  floorY: 210, headBounds: { x: 39, y: 55, width: 162, height: 85 },
  torsoBounds: { x: 93, y: 132, width: 55, height: 78 },
  eyeY: 97, eyeRadius: 13, pupilRadius: 8.5, jointRadius: 8,
});
const headPath = "M39 98C39 81 78 55 119 55C159 54 198 79 201 98C205 118 164 140 120 140C78 140 35 117 39 98Z";
const bodyPath = "M94 132C107 137 135 137 147 132L148 171C150 179 147 185 146 188L146 198C147 206 141 211 133 210C126 210 122 208 122 199L122 190L119 190L119 199C119 208 113 211 105 210C97 210 94 207 95 198L95 186C92 181 92 176 93 170Z";
// A single outer contour gives the canonical open-arm pose continuous
// shoulders, torso and feet. It has no overlapping arm root outlines.
const tPosePath = "M94 132C108 137 135 137 147 132L148 136C158 134 171 136 177 141C186 148 180 162 169 159L148 153L148 172C150 180 147 185 146 188L146 198C147 206 141 211 133 210C126 210 122 208 122 199L122 190L119 190L119 199C119 208 113 211 105 210C97 210 94 207 95 198L95 186C92 181 92 176 93 171L93 153C82 157 72 162 65 159C56 155 59 145 65 141C74 135 86 133 94 136Z";

const ARM_MOTIONS = Object.freeze({
  "nb-clasp-left": { pivot: ANATOMY.leftShoulder, degrees: -4, duration: 2.8 },
  "nb-clasp-right": { pivot: ANATOMY.rightShoulder, degrees: 4, duration: 2.8 },
  "nb-kiss-arm": { pivot: ANATOMY.leftShoulder, degrees: -6, duration: 3.2 },
  "nb-back-arm": { pivot: ANATOMY.rightShoulder, degrees: 8, duration: 1.9 },
  "nb-think-arm": { pivot: ANATOMY.leftShoulder, degrees: -3, duration: 4.4 },
  "nb-type-left": { pivot: ANATOMY.leftShoulder, degrees: 3, duration: .65 },
  "nb-type-right": { pivot: ANATOMY.rightShoulder, degrees: -3, duration: .8 },
  "nb-tidy-left": { pivot: ANATOMY.leftShoulder, degrees: -11, duration: 2.8 },
  "nb-tidy-right": { pivot: ANATOMY.rightShoulder, degrees: 11, duration: 2.8 },
  "nb-lying-arm": { pivot: [140, 167], degrees: -5, duration: 3.4 },
});
const armStyles = Object.entries(ARM_MOTIONS).map(([name, motion]) =>
  `.${name}{transform-origin:${motion.pivot[0]}px ${motion.pivot[1]}px;animation:${name}-move ${motion.duration}s ease-in-out infinite}@keyframes ${name}-move{0%,100%{transform:rotate(0)}50%{transform:rotate(${motion.degrees}deg)}}`
).join("\n");

const styles = `
  .nb-ink{stroke-linecap:round;stroke-linejoin:round}
  .nb-breathe{transform-origin:120px 210px;animation:nb-breathe 4.2s ease-in-out infinite}
  .nb-head{transform-origin:120px 140px;animation:nb-head 5.6s ease-in-out infinite}
  .nb-blink{transform-origin:120px 97px;animation:nb-blink 5.4s infinite}
  .nb-bigblink{transform-origin:120px 96px;animation:nb-blink 4.7s infinite}
  .nb-shy{transform-origin:120px 203px;animation:nb-shy 3.6s ease-in-out infinite}
  .nb-heart{animation:nb-heart 3s ease-in-out infinite;transform-origin:center;transform-box:fill-box}
  .nb-heart-late{animation-delay:-1.5s}
  .nb-dance{transform-origin:120px 207px;animation:nb-dance 1.8s ease-in-out infinite}
  .nb-note{animation:nb-note 1.8s ease-in-out infinite}
  .nb-celebrate{transform-origin:120px 201px;animation:nb-celebrate 2.5s ease-in-out infinite}
  .nb-spark{transform-origin:center;transform-box:fill-box;animation:nb-spark 2.2s ease-in-out infinite}
  .nb-spark-late{animation-delay:-1.1s}
  .nb-glow{animation:nb-glow 2.6s ease-in-out infinite}
  .nb-grumpy{transform-origin:120px 137px;animation:nb-grumpy 4.5s ease-in-out infinite}
  .nb-cool{transform-origin:120px 142px;animation:nb-cool 3.5s ease-in-out infinite}
  .nb-tear{animation:nb-tear 2.5s ease-in infinite}
  .nb-tear-late{animation-delay:-1.3s}
  .nb-sad{transform-origin:120px 211px;animation:nb-sad 5.5s ease-in-out infinite}
  .nb-cup{transform-origin:173px 191px;animation:nb-cup 5.8s ease-in-out infinite}
  .nb-steam{animation:nb-steam 3s ease-in-out infinite}
  .nb-sleep{transform-origin:152px 207px;animation:nb-sleep 5.5s ease-in-out infinite}
  .nb-blanket{transform-origin:157px 214px;animation:nb-blanket 5.5s ease-in-out infinite}
  .nb-wake{transform-origin:120px 207px;animation:nb-wake 1.6s ease-out both}
  .nb-yawn{transform-origin:120px 142px;animation:nb-yawn 3.2s ease-in-out infinite}
  ${armStyles}
  @keyframes nb-breathe{0%,100%{transform:scale(1,1)}50%{transform:scale(1.008,1.015)}}
  @keyframes nb-head{0%,100%{transform:rotate(0)}50%{transform:rotate(1deg)}}
  @keyframes nb-blink{0%,42%,47%,100%{transform:scaleY(1)}44.5%{transform:scaleY(.065)}}
  @keyframes nb-shy{0%,100%{transform:rotate(-1.5deg)}50%{transform:rotate(1.5deg)}}
  @keyframes nb-heart{0%,8%{opacity:0;transform:translate(0,5px) scale(.7)}22%,62%{opacity:1}90%,100%{opacity:0;transform:translate(-6px,-24px) scale(1.08)}}
  @keyframes nb-dance{0%,100%{transform:rotate(-3deg)}50%{transform:rotate(3deg)}}
  @keyframes nb-note{0%,100%{opacity:.55;transform:translateY(3px)}50%{opacity:1;transform:translateY(-3px)}}
  @keyframes nb-celebrate{0%,100%{transform:rotate(-2deg)}50%{transform:rotate(2deg)}}
  @keyframes nb-spark{0%,100%{opacity:.55;transform:scale(.8) rotate(-8deg)}50%{opacity:1;transform:scale(1.06) rotate(8deg)}}
  @keyframes nb-glow{0%,100%{opacity:.28}50%{opacity:.55}}
  @keyframes nb-grumpy{0%,65%,100%{transform:rotate(0)}72%{transform:rotate(-2deg)}80%{transform:rotate(2deg)}88%{transform:rotate(0)}}
  @keyframes nb-cool{0%,100%{transform:rotate(-.8deg)}50%{transform:rotate(.8deg)}}
  @keyframes nb-tear{0%,12%{opacity:0;transform:translateY(-3px)}25%,65%{opacity:1}100%{opacity:0;transform:translateY(17px)}}
  @keyframes nb-sad{0%,100%{transform:scaleY(1)}50%{transform:scaleY(.985)}}
  @keyframes nb-cup{0%,28%,100%{transform:rotate(0)}40%,58%{transform:rotate(-5deg) translate(-2px,-3px)}}
  @keyframes nb-steam{0%,100%{opacity:.25;transform:translateY(1px)}50%{opacity:.65;transform:translateY(-4px)}}
  @keyframes nb-sleep{0%,100%{transform:scale(1,1)}50%{transform:scale(1.01,1.025)}}
  @keyframes nb-blanket{0%,100%{transform:scaleY(1)}50%{transform:scaleY(1.03)}}
  @keyframes nb-wake{0%{transform:scale(.99,.96)}45%{transform:scale(1.01,1.03)}100%{transform:scale(1,1)}}
  @keyframes nb-yawn{0%,100%{transform:scale(1,1)}45%,65%{transform:scale(.99,1.025)}}
  @media(prefers-reduced-motion:reduce){svg:not([data-force-motion]) *{animation:none!important}}
`;

const defs = `<defs>
  <linearGradient id="nb-blue" gradientUnits="userSpaceOnUse" x1="80" y1="55" x2="145" y2="210"><stop stop-color="#2faee4"/><stop offset="1" stop-color="#2daade"/></linearGradient>
  <linearGradient id="nb-red" x2=".3" y2="1"><stop stop-color="#bd1737"/><stop offset="1" stop-color="#a61931"/></linearGradient>
  <linearGradient id="nb-red-body" x2="0" y2="1"><stop offset=".35" stop-color="#bd1737"/><stop offset="1" stop-color="#29a7d7"/></linearGradient>
  <linearGradient id="nb-party-body" x2="0" y2="1"><stop offset=".35" stop-color="#2faee4"/><stop offset=".37" stop-color="#ec008c"/><stop offset="1" stop-color="#ec008c"/></linearGradient>
  <linearGradient id="nb-coffee-body" x2="0" y2="1"><stop offset=".57" stop-color="#2faee4"/><stop offset=".6" stop-color="#81501f"/><stop offset="1" stop-color="#81501f"/></linearGradient>
  <linearGradient id="nb-sad-blue" x2=".2" y2="1"><stop stop-color="#653b91"/><stop offset=".5" stop-color="#675da4"/><stop offset="1" stop-color="#30addb"/></linearGradient>
  <linearGradient id="nb-rainbow" x1="0" y1="1" x2="1" y2="0"><stop stop-color="#ec5fbc"/><stop offset=".2" stop-color="#ffe066"/><stop offset=".42" stop-color="#14c5a6"/><stop offset=".65" stop-color="#45c9ed"/><stop offset=".83" stop-color="#ea1394"/><stop offset="1" stop-color="#ff65ba"/></linearGradient>
  <radialGradient id="nb-cheek"><stop stop-color="#ee6cae" stop-opacity=".72"/><stop offset="1" stop-color="#ef7eb6" stop-opacity="0"/></radialGradient>
  <radialGradient id="nb-aura"><stop offset=".3" stop-color="#ff712e" stop-opacity=".65"/><stop offset="1" stop-color="#ffbd45" stop-opacity="0"/></radialGradient>
  <radialGradient id="nb-shine"><stop stop-color="#ffffff" stop-opacity=".85"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>
  <style>${styles}</style>
</defs>`;

function pathEl(d, fill = "url(#nb-blue)", extra = "", outline = "#151b22") {
  return `<path class="nb-ink" stroke="${outline}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="${d}" fill="${fill}" ${extra}/>`;
}
function chest(x = 120, y = 165, size = 14) {
  return `<text x="${x}" y="${y}" fill="white" font-family="Arial,Helvetica,sans-serif" font-size="${size}" font-weight="800" text-anchor="middle" letter-spacing="-.4">KAIST</text>`;
}
function torso(fill = "url(#nb-blue)", logoY = 165, d = bodyPath) {
  return pathEl(d, fill, 'data-part="torso" data-neck="120 140"') + chest(120, logoY);
}
function tPose(fill = "url(#nb-blue)") {
  return pathEl(tPosePath, fill, 'data-part="continuous-t-pose" data-neck="120 140" data-shoulders="99 142 141 142"') + chest();
}

// Arm root caps stay inside the torso and do not have a closing black stroke.
// Rotations pivot at the same root, so no frame can move the arm off its joint.
function limb(side, outline, { motion = "", fill = "url(#nb-blue)", pivot = null } = {}) {
  const joint = pivot || (side === "left" ? ANATOMY.leftShoulder : ANATOMY.rightShoulder);
  if (motion && ARM_MOTIONS[motion].pivot.join(" ") !== joint.join(" ")) throw new Error(`Wrong ${motion} arm pivot`);
  return `<g class="${motion}" data-part="arm-${side}" data-arm-root="${joint.join(" ")}" data-root-radius="8"${motion ? ` data-arm-motion="${motion}"` : ""}>
    <circle cx="${joint[0]}" cy="${joint[1]}" r="8" fill="${fill}"/>
    <path d="${outline}Z" fill="${fill}"/>
    ${pathEl(outline, "none")}
  </g>`;
}
const openLeft = "M99 134C90 132 76 134 66 139C56 145 61 160 71 159C82 158 92 152 101 151";
const openRight = "M141 134C151 132 168 135 177 141C187 148 179 163 168 158L139 151";
const claspLeft = "M99 134C102 129 108 120 116 116C123 112 129 120 126 128C119 143 113 153 102 156C92 160 86 153 91 144C95 140 97 137 99 134";
const claspRight = "M141 134C136 127 129 118 122 116C114 114 111 122 116 132C125 149 133 159 145 156C153 153 150 145 141 134";
function clasp() {
  return limb("left", claspLeft, { motion: "nb-clasp-left" }) + limb("right", claspRight, { motion: "nb-clasp-right" });
}
function eyes(kind = "normal", lidFill = "url(#nb-blue)") {
  if (kind === "dream") return `<g fill="none" stroke="#17212b" stroke-width="1.8" stroke-linecap="round"><path d="M81 97L95 97M143 97L157 97"/></g>`;
  if (kind === "sleep") return `<g fill="none" stroke-linecap="round"><path d="M81 97L95 97M143 97L157 97" stroke="white" stroke-width="4"/><path d="M85 97L92 97M147 97L153 97" stroke="#17212b" stroke-width="3"/></g>`;
  if (kind === "back" || kind === "rainbow") return "";
  if (kind === "annoyed" || kind === "tired") {
    const y = kind === "annoyed" ? 118 : 109;
    return `<g fill="white"><ellipse cx="88" cy="${y}" rx="13.5" ry="11.5"/><ellipse cx="149" cy="${y}" rx="13.5" ry="11.5"/><g fill="#020506"><circle cx="88" cy="${y}" r="8.4"/><circle cx="149" cy="${y}" r="8.4"/></g>${kind === "annoyed"
      ? `<path d="M69 88H108V121L72 105ZM130 88H169V105L132 121Z" fill="${lidFill}"/>`
      : `<path d="M73 95H104V106H73ZM134 95H165V106H134Z" fill="${lidFill}"/>`}</g>`;
  }
  const radius = kind === "big" ? 27 : ANATOMY.eyeRadius;
  const pupil = kind === "big" ? 17.5 : ANATOMY.pupilRadius;
  return `<g class="${kind === "big" ? "nb-bigblink" : "nb-blink"}"><g fill="white"><circle cx="88" cy="97" r="${radius}"/><circle cx="149" cy="97" r="${radius}"/></g><g id="nb-pupils" fill="#020506"><circle cx="88" cy="97" r="${pupil}"/><circle cx="149" cy="97" r="${pupil}"/></g></g>`;
}
function head(kind = "normal", { fill = "url(#nb-blue)", extras = "", tilt = 0 } = {}) {
  return `<g data-part="head" data-neck="120 140"${tilt ? ` transform="rotate(${tilt} 120 140)"` : ""}><g class="nb-head">${pathEl(headPath, fill, 'data-part="head-outline"')}${eyes(kind, fill)}${extras}</g></g>`;
}
function heart(x, y, scale = 1, classes = "", fill = "#ec008c", rotate = 0) {
  return `<g transform="translate(${x} ${y}) rotate(${rotate}) scale(${scale})"><g class="${classes}">${pathEl("M0 8C-3 1-10-3-15 2C-22 9-14 21 0 29C14 21 22 9 15 2C10-3 3 1 0 8Z", fill, "", fill === "#050607" ? "#536273" : "#151b22")}</g></g>`;
}
function rig(content, animation = "nb-breathe", transform = "") {
  // Keep the pose transform separate from CSS animation transforms.
  return `<g data-part="character-rig" data-anatomy-version="2"${transform ? ` transform="${transform}"` : ""}><g class="${animation}">${content}</g></g>`;
}
const seatedPath = "M94 132C108 137 134 137 147 132L149 163C154 175 141 186 126 185C108 188 92 179 95 163Z";
const seatedLeft = "M99 135C91 135 86 144 86 154C86 166 95 176 102 170C108 164 103 147 99 135";
const seatedRight = "M141 135C149 135 154 145 153 156C153 166 145 176 138 169C133 161 137 145 141 135";
function seated({ heartAtSide = false, crossed = false } = {}) {
  const outline = pathEl(seatedPath, "url(#nb-blue)", 'data-part="seated-torso" data-neck="120 140"')
    + pathEl("M136 166C147 163 159 172 161 182C164 193 153 197 145 193C134 188 130 175 136 166Z", "url(#nb-blue)", 'data-part="far-folded-knee"')
    + pathEl("M99 171C90 164 81 169 79 181C76 192 87 195 111 194C126 197 140 195 141 187C141 180 129 177 118 176C111 173 104 171 99 171Z", "url(#nb-blue)", 'data-part="foreground-folded-leg"')
    + chest(120, 156, 13);
  return outline
    + (crossed ? limb("left", "M99 134C102 136 115 144 132 146C142 149 141 159 130 159C113 157 94 151 99 134") + limb("right", "M141 134C131 132 121 145 115 159C111 169 117 174 126 166L142 145") : limb("left", seatedLeft) + limb("right", seatedRight))
    + (heartAtSide ? heart(79, 151, 1.15) : "");
}

// The lying head uses the same contour and neck point as the standing rig.
// Its transformed neck (124,181) sits well inside the folded torso.
const lyingPath = "M118 167C129 160 142 160 150 166C160 165 173 172 176 183C182 194 179 203 169 207C160 219 140 213 136 199C129 194 122 187 121 181Z";
function lying({ blanket = false, awake = false } = {}) {
  const upperArm = limb("right", "M134 165C135 157 144 151 150 155C161 163 153 178 145 185C136 192 130 184 132 176L140 167", { pivot: [140, 167] });
  const body = pathEl(lyingPath, "url(#nb-blue)", 'data-part="lying-torso" data-neck="124 181"')
    + pathEl("M145 188C155 183 169 190 171 200C175 211 163 216 154 209C149 203 145 196 145 188Z", "url(#nb-blue)", 'data-part="lying-folded-knee"')
    + `<g transform="rotate(52 158 193)">${chest(158, 193, 12)}</g>`;
  const covered = blanket ? `<g class="nb-blanket">${pathEl("M164 186C162 173 174 166 183 174C191 181 193 189 205 198C215 207 229 214 237 211C224 225 182 222 154 213C157 203 159 195 164 186Z", "#e795ba")}</g>` : "";
  const h = `<g transform="translate(-27 54) rotate(-46 120 97)">${head(awake ? "normal" : blanket ? "dream" : "sleep")}</g>`;
  const raised = awake ? limb("right", "M134 165C140 159 148 149 156 146C166 142 172 150 166 158C159 169 149 177 141 179L134 165", { pivot: [140, 167], motion: "nb-lying-arm" }) : upperArm;
  return rig(body + covered + h + raised, "nb-sleep")
    + (blanket ? heart(159, 99, 1, "nb-heart") + heart(173, 76, .8, "nb-heart nb-heart-late", "#f75aac") : "");
}

const assets = [];
function add(id, name, description, content, options = {}) {
  const file = `neobjuk-${id}.svg`;
  const shadow = options.shadow === false ? "" : `<ellipse cx="120" cy="213" rx="${options.wide ? 72 : 45}" ry="9" fill="#636873" opacity=".24"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240" role="img" aria-labelledby="nb-title nb-desc" data-anatomy-version="2">
<title id="nb-title">${name}</title><desc id="nb-desc">${description}</desc>
${defs}
${shadow}
${content}
</svg>\n`;
  assets.push({ id, name, description, file, svg, canonical: options.canonical !== false });
}

add("neutral", "넙죽이 · 기본", "The center reference pose: wide shallow head, small circular eyes, high continuous shoulders and short rounded feet.", rig(tPose() + head()));
add("excited", "넙죽이 · 신남", "Huge eyes and broad clasped hands connected to the same high shoulders.", rig(torso(undefined, 178) + head("big") + clasp()));
const shyPath = "M94 132C107 137 135 137 147 132L148 173C147 179 143 184 138 190L126 205C120 214 111 212 111 203C110 197 116 190 122 183C109 189 101 200 101 205C91 209 89 198 96 186L93 170Z";
add("shy", "넙죽이 · 수줍음", "Blushing clasped hands and crossed feet share the neutral pose's head, torso and shoulders.", heart(170, 140, 1.2) + rig(torso(undefined, 177, shyPath) + head("normal", { extras: `<ellipse cx="88" cy="115" rx="23" ry="10" fill="url(#nb-cheek)"/><ellipse cx="149" cy="115" rx="23" ry="10" fill="url(#nb-cheek)"/>` }) + clasp(), "nb-shy"));
const kissArm = "M99 134C96 128 89 117 82 111C75 105 69 109 72 117C76 130 88 145 99 150";
add("kiss", "넙죽이 · 하트 보내기", "One shoulder-connected arm brings a kiss to the cheek; the whole character leans together.", rig(torso() + limb("right", openRight) + head("normal", { tilt: 7 }) + limb("left", kissArm, { motion: "nb-kiss-arm" }), "nb-breathe", "rotate(8 120 210)") + heart(54, 104, 1.2, "nb-heart", "#ec008c", -18));
const backPath = "M104 134C113 121 138 126 147 135C154 143 151 156 145 162L146 180C151 187 145 198 137 202C128 207 124 200 127 190L124 179L119 181L116 198C115 210 103 210 100 201L96 182C90 173 96 163 98 154L96 144C96 139 99 136 104 134Z";
add("dancing", "넙죽이 · 뒷모습 춤", "A rounded back leans over one bent leg while both paddles remain rooted underneath the head.", heart(48, 49, 1.2, "nb-heart", "#ec008c", -25) + rig(limb("left", openLeft) + head("back") + pathEl(backPath, "url(#nb-blue)", 'data-part="torso" data-neck="120 140"') + limb("right", "M141 134C148 133 157 143 164 155C170 166 161 174 153 166C147 158 141 151 138 147", { motion: "nb-back-arm" }) + `<g transform="translate(83 171) rotate(-22)">${chest(0, 0, 12)}</g>`, "nb-dance") + `<g class="nb-note" fill="#ec008c"><path d="M193 152V175H189V156L206 160V181H202V165Z"/><ellipse cx="186" cy="176" rx="6" ry="4" transform="rotate(-20 186 176)"/><ellipse cx="199" cy="182" rx="6" ry="4" transform="rotate(-20 199 182)"/></g>`);
const partyPath = "M94 132C107 137 135 137 147 132L148 162L173 181C182 188 177 196 168 193L144 181L136 199C133 215 119 215 117 204L111 181C99 178 93 169 94 159Z";
add("rainbow", "넙죽이 · 반짝 축하", "The same shallow head and connected torso celebrate with rainbow glints, a large rim-attached star and pink kicked-up legs.", rig(torso("url(#nb-party-body)", 162, partyPath) + head("rainbow", { fill: "url(#nb-rainbow)", tilt: -10, extras: `<circle cx="104" cy="98" r="31" fill="url(#nb-shine)"/><g class="nb-spark" fill="white"><path d="M76 75L82 89L96 92L84 99L80 112L73 100L61 97L72 89Z"/></g><g class="nb-spark nb-spark-late" fill="white"><path d="M139 65L146 77L159 80L149 89L146 102L138 91L125 87L135 77Z"/></g><g class="nb-spark">${pathEl("M198 77L206 89L225 81L215 100L222 117L202 111L192 128L190 109L173 105L190 94Z", "#fff127", 'data-part="rim-star"')}</g>` }), "nb-celebrate", "rotate(-17 120 210)"));
add("annoyed", "넙죽이 · 삐침", "A continuous open-arm silhouette with low narrowed eyes and rosy cheeks.", `<ellipse cx="120" cy="213" rx="44" ry="9" fill="#ec008c"/>` + rig(tPose() + head("annoyed", { extras: `<ellipse cx="88" cy="128" rx="20" ry="6" fill="url(#nb-cheek)"/><ellipse cx="149" cy="128" rx="20" ry="6" fill="url(#nb-cheek)"/>` })));
add("furious", "넙죽이 · 화남", "A red shallow head and continuous high-shoulder body glow warmly while the narrowed eyes remain low on the face.", `<ellipse class="nb-glow" cx="120" cy="124" rx="108" ry="104" fill="url(#nb-aura)"/><ellipse cx="120" cy="213" rx="44" ry="9" fill="#0a0c12"/>` + rig(tPose("url(#nb-red-body)") + head("annoyed", { fill: "url(#nb-red)" })));
const sunglasses = `<g transform="translate(0 -6)" fill="#020506" stroke="#020506" stroke-width="2.4" stroke-linecap="round"><path d="M53 103Q48 105 43 100M185 104Q194 107 199 100M111 107Q119 103 128 107" fill="none"/><ellipse cx="84" cy="111" rx="29" ry="13" transform="rotate(7 84 111)"/><ellipse cx="155" cy="111" rx="29" ry="13" transform="rotate(-7 155 111)"/></g>`;
const crossedLeft = "M99 134C111 134 129 138 150 143C165 148 165 162 152 166C136 169 116 157 96 154C81 153 77 142 86 136C89 133 94 133 99 134";
const crossedRight = "M141 134C129 134 110 140 90 146C76 152 80 166 94 169C110 170 128 156 148 153C162 150 159 138 149 135C146 134 143 134 141 134";
add("cool", "넙죽이 · 집중", "Sunglasses move with the shallow head while crossed forearms remain joined to the high shoulders.", rig(torso(undefined, 178) + head("normal", { extras: sunglasses }) + limb("left", crossedLeft) + limb("right", crossedRight)));
const tears = `<g fill="white"><circle cx="82" cy="107" r="5"/><circle cx="88" cy="114" r="5"/><circle cx="94" cy="108" r="4"/><circle cx="143" cy="109" r="4"/><circle cx="150" cy="114" r="4"/><circle cx="157" cy="108" r="4"/><path class="nb-tear" d="M87 113C84 121 78 128 83 133C90 138 95 133 93 128Z"/><path class="nb-tear nb-tear-late" d="M147 114C144 123 140 131 144 135C152 139 157 132 152 126Z"/></g>`;
const curledBody = pathEl("M94 132C108 137 134 137 147 132L151 162C157 174 149 187 132 187C111 193 93 177 94 162Z", "url(#nb-blue)", 'data-part="seated-torso" data-neck="120 140"')
  + pathEl("M138 159C149 156 164 165 167 181C171 194 159 200 150 195C141 190 134 171 138 159Z", "url(#nb-blue)", 'data-part="far-folded-knee"')
  + pathEl("M101 170C91 163 81 171 81 181C80 191 99 194 115 196C128 200 145 198 146 189C146 179 127 178 116 175C109 173 105 171 101 170Z", "url(#nb-blue)", 'data-part="foreground-folded-leg"');
add("crying", "넙죽이 · 눈물", "Curled around one rounded knee, with a broad oval forearm across the chest and a tearful head tilted at the attached neck.", heart(55, 170, 1.15, "", "#ec008c", 180) + rig(curledBody + head("normal", { tilt: -12, extras: tears }) + limb("right", "M141 134C148 129 156 132 159 139C162 147 153 155 146 158L136 151C129 146 132 139 141 134") + limb("left", "M99 135C109 135 128 140 140 143C153 146 153 160 142 163C127 168 112 157 99 155C88 153 89 142 99 135"), "nb-sad", "translate(-5 13)") + `<g transform="translate(54 198) rotate(180)">${chest(0, 0, 12)}</g>`);
add("tilted-heart", "넙죽이 · 누워서 하트", "The shallow head joins a folded sideways body; a compact raised hand pivots at its transformed canonical shoulder.", lying({ awake: true }) + heart(194, 103, 1.2, "nb-heart", "#ec008c", -15), { wide: true });
const glasses = `<g stroke="#171d22" stroke-width="1.7" fill="none"><circle cx="107" cy="113" r="8.5"/><circle cx="139" cy="113" r="8.5"/><path d="M115 112Q123 107 131 112M98 114L92 124M147 114L152 120"/></g>`;
add("heart-glasses", "넙죽이 · 하트와 안경", "Small round glasses follow the head; one rounded cheek arm adjusts them while the other cups a heart at mid-chest.", rig(torso() + head("normal", { extras: glasses }) + heart(118, 153, 1) + limb("right", "M141 134C153 135 161 145 160 156C159 169 146 175 132 173C119 173 116 161 125 156C132 152 140 151 144 147L139 143") + limb("left", "M99 134C96 126 99 117 107 117C120 117 116 132 112 143C109 153 105 166 96 165C84 164 85 154 89 143L99 134", { motion: "nb-think-arm" })));
add("sad", "넙죽이 · 시무룩", "Seated with broad rounded folded knees, high shoulders and a purple-shaded shallow head.", heart(59, 175, 1.15, "", "#050607", -20) + rig(seated() + head("normal", { fill: "url(#nb-sad-blue)", tilt: 3 }), "nb-sad", "translate(0 15)"));
const coffee = `<g class="nb-cup">${pathEl("M176 150H198L194 210H180Z", "#fffef9", 'data-part="coffee-cup"')}${pathEl("M175 143H199V149H175Z", "#fffef9")}<path d="M176 155H198M177 162H197" stroke="#171d22" stroke-width="1.3"/><circle cx="187" cy="180" r="8.5" fill="#087748"/><path d="M182 179C185 174 190 186 193 180C194 176 189 177 187 180C185 184 180 183 182 179Z" stroke="white" stroke-width="1.3" fill="none"/></g><g class="nb-steam" stroke="#a6b4bd" stroke-width="1.6" stroke-linecap="round" fill="none"><path d="M181 137Q185 133 181 129Q177 125 181 121M192 136Q195 132 191 128"/></g>`;
const coffeeBody = "M94 132C107 137 135 137 147 132L148 158C150 166 147 172 146 176L146 186C147 194 141 199 133 198C126 198 122 196 122 187L122 178L119 178L119 187C119 196 113 199 105 198C97 198 94 195 95 186L95 174C92 169 92 164 93 158Z";
add("coffee", "넙죽이 · 커피와 졸림", "Low heavy eyelids, full hanging paddles and bent short brown feet sit beside a tall coffee cup.", rig(torso("url(#nb-coffee-body)", 161, coffeeBody) + head("tired", { extras: `<ellipse cx="88" cy="121" rx="16" ry="7" fill="url(#nb-cheek)"/><ellipse cx="149" cy="121" rx="16" ry="7" fill="url(#nb-cheek)"/>` }) + limb("left", "M99 134C88 132 81 143 80 156C79 169 83 180 92 176C101 172 104 148 99 134") + limb("right", "M141 134C152 132 159 143 160 157C161 171 154 180 145 176C135 171 135 146 141 134"), "nb-sad", "translate(0 12)") + coffee);
add("seated-heart", "넙죽이 · 앉아서 하트", "A broad foreground folded leg and a rounded far knee join a compact seated torso beneath the neutral shallow head.", rig(seated({ heartAtSide: true }) + head(), "nb-breathe", "translate(0 15)"));
add("sleeping", "넙죽이 · 잠", "The neutral shallow head lies diagonally, connected to a compact folded body, with slim sleepy glints.", lying(), { wide: true });
add("loving-sleep", "넙죽이 · 이불과 꿈", "The same folded body sleeps with black eye slits under a pink blanket and drifting hearts.", lying({ blanket: true }), { wide: true });

const typeLeft = "M99 134C105 139 109 151 112 163C119 173 112 180 104 176C95 170 92 157 92 146C92 139 94 136 99 134";
const typeRight = "M141 134C135 140 131 154 128 164C121 174 128 180 136 176C145 169 148 155 148 145C148 139 146 136 141 134";
add("typing", "넙죽이 · 작업", "Short connected forearms alternate taps from fixed shoulder pivots while the sunglasses follow the shallow head.", rig(torso() + head("normal", { extras: sunglasses }) + limb("left", typeLeft, { motion: "nb-type-left" }) + limb("right", typeRight, { motion: "nb-type-right" })) + pathEl("M82 174H158L166 190H74Z", "#e6f2f8") + `<path d="M83 180H157M79 186H161M92 177L88 187M106 177L104 187M120 177V187M134 177L137 187M148 177L153 187" fill="none" stroke="#315363" stroke-width="1.1"/>`, { canonical: false });
add("tidying", "넙죽이 · 정리", "The high shoulder roots stay fixed as the open arms alternately sweep small arcs.", rig(torso() + limb("left", openLeft, { motion: "nb-tidy-left" }) + limb("right", openRight, { motion: "nb-tidy-right" }) + head()), { canonical: false });
add("yawning", "넙죽이 · 기지개", "Both connected arms rise from the neutral shoulders as the whole compact body slowly stretches.", rig(torso() + head("tired") + limb("left", "M99 134C91 126 80 112 76 101C72 92 64 97 67 107C70 124 83 143 99 151") + limb("right", "M141 134C150 126 161 112 165 101C170 92 178 98 174 109C169 126 157 143 141 151"), "nb-yawn"), { canonical: false });
add("waking", "넙죽이 · 깨어남", "The continuous neutral shoulders and short feet stretch awake together beneath bright big eyes.", rig(tPose() + head("big"), "nb-wake"), { canonical: false });

function makeTheme() {
  const pose = (id) => [`neobjuk-${id}.svg`];
  const states = {
    idle: pose("neutral"), thinking: pose("heart-glasses"), working: pose("typing"),
    juggling: pose("dancing"), attention: pose("excited"), notification: pose("rainbow"),
    error: pose("furious"), sweeping: pose("tidying"), carrying: pose("heart-glasses"),
    yawning: pose("yawning"), dozing: pose("coffee"), collapsing: pose("loving-sleep"),
    sleeping: pose("sleeping"), waking: pose("waking"),
  };
  for (const asset of assets.filter((a) => a.canonical)) states[`pose-${asset.id}`] = [asset.file];
  return {
    schemaVersion: 1, name: "넙죽이 · Neobjuk", author: "alex6095", version: "1.0.0",
    description: "Animated SVG poses reproduced from the user-provided KAIST Neobjuk mascot reference.",
    // Attribution is explicit: the extension's MIT code license does not claim
    // ownership of KAIST's mascot design or imply permission for redistribution.
    license: "Mascot artwork © KAIST. See ASSETS-LICENSE; graphic assets are excluded from the extension's MIT code license.",
    attribution: { character: "넙죽이 / Neobjuk", rightsHolder: "KAIST", reference: "User-provided KAIST mascot expression chart", implementation: "Vector paths and animations authored for this extension" },
    preview: "neobjuk-neutral.svg",
    viewBox: { x: 0, y: 0, width: 240, height: 240 },
    layout: { contentBox: { x: 32, y: 48, width: 176, height: 162 }, centerX: 120, baselineY: 210, visibleHeightRatio: .64, baselineBottomRatio: .08 },
    eyeTracking: { enabled: true, states: ["idle", "pose-neutral"], eyeRatioX: .5, eyeRatioY: .404, maxOffset: 2, trackingLayers: { pupils: { ids: ["nb-pupils"], maxOffset: 2, ease: .13 } } },
    states,
    variants: Object.fromEntries(assets.filter((a) => a.canonical).map((a) => [a.id === "neutral" ? "default" : a.id, { name: a.name, description: a.description, preview: a.file, idleAnimations: [{ file: a.file, duration: 6500 }] }])),
    workingTiers: [{ minSessions: 1, file: "neobjuk-typing.svg" }],
    jugglingTiers: [{ minSessions: 1, file: "neobjuk-dancing.svg" }],
    idleAnimations: [{ file: "neobjuk-seated-heart.svg", duration: 6500 }, { file: "neobjuk-cool.svg", duration: 6500 }, { file: "neobjuk-shy.svg", duration: 6500 }],
    displayHintMap: {
      "clawd-working-thinking.svg": "neobjuk-heart-glasses.svg",
      "clawd-working-debugger.svg": "neobjuk-cool.svg",
      "clawd-idle-reading.svg": "neobjuk-seated-heart.svg",
      "clawd-working-typing.svg": "neobjuk-typing.svg",
      "clawd-working-building.svg": "neobjuk-typing.svg",
      "clawd-working-juggling.svg": "neobjuk-dancing.svg",
      "clawd-working-conducting.svg": "neobjuk-dancing.svg",
      "clawd-working-sweeping.svg": "neobjuk-tidying.svg",
      "clawd-working-carrying.svg": "neobjuk-heart-glasses.svg",
    },
    timings: {
      minDisplay: { attention: 3500, notification: 3000, error: 4000, working: 1000, thinking: 1000, sweeping: 3000, carrying: 3000 },
      autoReturn: { attention: 3500, notification: 3000, error: 4000, carrying: 3000, sweeping: 300000 },
      yawnDuration: 3200, collapseDuration: 1600, wakeDuration: 1600, deepSleepTimeout: 600000, mouseIdleTimeout: 20000, mouseSleepTimeout: 60000,
    },
    hitBoxes: { default: { x: 39, y: 55, w: 164, h: 155 }, wide: { x: 24, y: 35, w: 193, h: 180 }, sleeping: { x: 35, y: 93, w: 198, h: 124 } },
    wideHitboxFiles: ["neobjuk-rainbow.svg", "neobjuk-furious.svg"],
    sleepingHitboxFiles: ["neobjuk-sleeping.svg", "neobjuk-loving-sleep.svg", "neobjuk-tilted-heart.svg"],
    reactions: {
      drag: { file: "neobjuk-excited.svg" }, clickLeft: { file: "neobjuk-shy.svg", duration: 3200 },
      clickRight: { file: "neobjuk-kiss.svg", duration: 3200 }, annoyed: { file: "neobjuk-annoyed.svg", duration: 3500 },
      double: { files: ["neobjuk-rainbow.svg", "neobjuk-tilted-heart.svg"], duration: 3500 },
    },
    miniMode: { supported: false }, sounds: { complete: "complete.mp3", confirm: "confirm.mp3" },
    objectScale: { widthRatio: 1, heightRatio: 1, offsetX: 0, offsetY: 0 },
    transitions: {},
  };
}

function generate() {
  fs.mkdirSync(assetsDir, { recursive: true });
  for (const asset of assets) fs.writeFileSync(path.join(assetsDir, asset.file), asset.svg);
  fs.writeFileSync(path.join(themeDir, "theme.json"), `${JSON.stringify(makeTheme(), null, 2)}\n`);
  return assets.length;
}
if (require.main === module) console.log(`Generated ${generate()} Neobjuk SVG animations.`);
module.exports = { generate, makeTheme, assets, ANATOMY, ARM_MOTIONS, headPath, bodyPath, tPosePath };
