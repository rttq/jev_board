// jev board frontend. Plain ES module, no build. All user text goes through textContent (h()), never innerHTML.
import { freeId, levelText, levelFromEdit, kvRows, kvObject, levelToEditor, levelFromEditor } from "./metrics.js";

// ---------- tiny DOM helper ----------
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k in el && k !== "list") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}

// ---------- api ----------
export async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    setOffline(true);
    throw { status: 0, error: "Cannot reach the jev board server. Is it still running in the terminal?" };
  }
  setOffline(false);
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (method === "POST" && path === "/api/runs") refreshTotalsSoon();  // every caller that spends money
  if (!res.ok) throw { status: res.status, ...(data || { error: res.statusText }) };
  return data;
}

// Header badge while the server is unreachable; the next successful request clears it.
function setOffline(on) {
  const el = document.getElementById("offline");
  if (el) el.hidden = !on;
}

// ---------- header totals ----------
let totalsTimer = null;
// throttle, not debounce: rows of a grid run finish back to back and must not postpone the update forever
function refreshTotalsSoon() { totalsTimer ??= setTimeout(() => { totalsTimer = null; refreshTotals(); }, 150); }

export async function refreshTotals() {
  const el = document.getElementById("totals");
  let t;
  try { t = await api("GET", "/api/totals"); } catch { return; }
  const part = (x, label) => `${label}${fmtUSD(x.cost_usd)} · ${x.runs} run${x.runs === 1 ? "" : "s"}` +
    (x.unknown_cost_runs ? ` · ${x.unknown_cost_runs} unknown` : "");
  el.textContent = part(t.session, "session ");
  el.title = part(t.all_time, "all time ") +
    (t.all_time.unknown_cost_runs ? "\n“unknown” = runs with no token count, left out of the cost" : "");
}

// ---------- app state ----------
export const app = { status: null, prefs: null };

export function fmtProb(p) {
  if (p == null || Number.isNaN(p)) return "—";
  const d = app.prefs?.prob_decimals ?? 0;
  return app.prefs?.prob_format === "fraction" ? p.toFixed(d + 2) : (p * 100).toFixed(d) + "%";
}

export function fmtUSD(x) {
  if (x == null) return "unknown";
  if (x === 0) return "$0";
  const digits = Math.min(12, Math.max(2, -Math.floor(Math.log10(Math.abs(x))) + 2));
  return "$" + x.toFixed(digits);
}

export const BAND = { low: 0.5, high: 0.8 }; // single-run default; dashboards have their own thresholds
export function bandOf(v, t = BAND) {
  return v >= t.high ? "yes" : v < t.low ? "no" : "review";
}
const VERDICT = { yes: "YES", review: "REVIEW", no: "NO" };
const LEVEL = { yes: "HIGH", review: "MEDIUM", no: "LOW" }; // for confidence, which is not a yes/no verdict
export function bandTag(v, t, labels = VERDICT) {
  const b = bandOf(v, t);
  return h("span", { class: `tag tag-${b}`, title: `thresholds ${t?.low ?? BAND.low} / ${t?.high ?? BAND.high}`,
                     role: "img", "aria-label": `${labels === LEVEL ? "confidence" : "verdict"} ${labels[b].toLowerCase()}` }, labels[b]);
}
const confTag = v => bandTag(v, BAND, LEVEL);

function applyPrefs() {
  const p = app.prefs;
  document.documentElement.dataset.theme = p.theme;
  document.documentElement.style.setProperty("--text-scale", p.text_scale);
}

function showBanner() {
  const b = document.getElementById("banner");
  b.replaceChildren();
  if (!app.status.key_present) {
    b.append(h("p", {}, h("strong", {}, "No TypeSafe API key found. "),
      "Set ", h("code", {}, "TYPESAFE_API_KEY"), " or put the key in ",
      h("code", {}, app.status.key_file), ", then restart jev board. ",
      "The guide and History still work without it."));
  }
  if (app.status.notice) b.append(h("p", {}, app.status.notice));
  b.hidden = !b.childElementCount;
}

export function confirmDialog(title, body, ok = "Confirm") {
  return choiceDialog(title, body, [[true, ok]]).then(v => v === true);
}

// buttons: [[value, label], ...]; the last one is the primary. Resolves with the value, or null on Cancel/Escape.
export function choiceDialog(title, body, buttons) {
  const dlg = document.getElementById("dlg");
  return new Promise(resolve => {
    const done = v => { dlg.onclose = null; dlg.close(); resolve(v); };
    dlg.replaceChildren(h("h1", {}, title), h("p", {}, body),
      h("div", { class: "actions" }, h("span", { style: "flex:1" }),
        h("button", { type: "button", onclick: () => done(null) }, "Cancel"),
        buttons.map(([v, label], i) => h("button", { type: "button", class: i === buttons.length - 1 ? "primary" : null,
                                                     onclick: () => done(v) }, label))));
    dlg.onclose = () => resolve(null);
    dlg.showModal();
  });
}

// ---------- router ----------
const views = {};
export function registerView(name, render) { views[name] = render; }

function route() {
  const [, name = "run", ...rest] = (location.hash || "#/run").split(/[/?]/);
  for (const a of document.querySelectorAll(".top nav a")) {
    if (a.dataset.view === name) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  const view = document.getElementById("view");
  view.replaceChildren();
  // A view whose first load fails shows why instead of a blank page; views already on screen keep working.
  Promise.resolve((views[name] || notBuilt)(view, rest)).catch(err => {
    view.append(h("div", { class: "result error", role: "alert" }, err?.error || String(err)));
  });
}

function notBuilt(view) {
  view.append(h("div", { class: "panel" }, h("h1", {}, "Not built yet"),
    h("p", { class: "muted" }, "This view arrives in a later step of the plan.")));
}

// ---------- Run view ----------
export const TYPE_LABEL = { noul: "Noul", choice: "Choice", score: "Score", box: "Box" };

// ---------- type guide (static, works offline) ----------
const SVG_ATTR = 'viewBox="0 0 120 44" width="120" height="44" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"';
export const GUIDE = [
  { type: "noul", asks: "Is this true?", returns: "P(yes) 0–1", use_when: "Clean yes/no condition",
    pitfall: "0.5 = “unsure”, not “medium amount”. Use a Score for degree.",
    svg: `<svg ${SVG_ATTR}><rect x="6" y="16" width="108" height="10" rx="5"/><rect x="6" y="16" width="80" height="10" rx="5" fill="currentColor" opacity=".3" stroke="none"/><line x1="86" y1="9" x2="86" y2="33" stroke-width="2.5"/><text x="4" y="42" font-size="8" fill="currentColor" stroke="none">0</text><text x="110" y="42" font-size="8" fill="currentColor" stroke="none">1</text></svg>` },
  { type: "choice", asks: "Which one?", returns: "Option + probabilities + confidence", use_when: "Known, unordered options",
    pitfall: "It always picks one. Pair it with a Noul “does any option fit?”.",
    svg: `<svg ${SVG_ATTR}><rect x="6" y="5" width="96" height="9" rx="2" fill="currentColor" opacity=".55" stroke="none"/><rect x="6" y="18" width="28" height="9" rx="2" fill="currentColor" opacity=".2" stroke="none"/><rect x="6" y="31" width="12" height="9" rx="2" fill="currentColor" opacity=".2" stroke="none"/></svg>` },
  { type: "score", asks: "Which level?", returns: "Position + level probabilities + confidence", use_when: "Ordered levels you can describe",
    pitfall: "Each level must be concrete. Watch for split answers.",
    svg: `<svg ${SVG_ATTR}><line x1="8" y1="22" x2="112" y2="22"/><line x1="8" y1="15" x2="8" y2="29"/><line x1="43" y1="15" x2="43" y2="29"/><line x1="77" y1="15" x2="77" y2="29"/><line x1="112" y1="15" x2="112" y2="29"/><rect x="85" y="12" width="9" height="20" rx="2" fill="currentColor" opacity=".55" stroke="none"/></svg>` },
  { type: "box", asks: "Where in the image?", returns: "Edges as fractions + confidence", use_when: "Locate one object in a PNG/JPEG",
    pitfall: "It always returns a box. Pair it with a Noul “is it there?”.",
    svg: `<svg ${SVG_ATTR}><rect x="14" y="3" width="92" height="38" rx="2"/><rect x="52" y="11" width="36" height="22" stroke-width="2.5" stroke-dasharray="4 2"/></svg>` },
];

function svgNode(markup) {  // static constant markup only (never user text)
  const t = document.createElement("template"); t.innerHTML = markup; return t.content.firstChild;
}

export function guideCard(g, current) {
  return h("article", { class: "guide-card" + (current ? " is-current" : ""), "data-type": g.type, "aria-label": `${TYPE_LABEL[g.type]} guide` },
    h("div", { class: "row" }, h("h2", { style: "margin:0" }, TYPE_LABEL[g.type]), h("span", { class: "muted small" }, g.asks)),
    svgNode(g.svg),
    h("dl", {},
      h("dt", {}, "Returns"), h("dd", {}, g.returns),
      h("dt", {}, "Use when"), h("dd", {}, g.use_when),
      h("dt", {}, "Watch out"), h("dd", {}, g.pitfall)));
}

export function openCompare() {
  const dlg = document.getElementById("dlg");
  dlg.replaceChildren(
    h("div", { class: "row" }, h("h1", { style: "margin:0" }, "Compare types"), h("span", { style: "flex:1" }),
      h("button", { type: "button", onclick: () => dlg.close() }, "Close")),
    h("div", { class: "guide-grid" }, GUIDE.map(g => guideCard(g))));
  dlg.showModal();
}

function guideSlot(type) {
  return [guideCard(GUIDE.find(g => g.type === type), true),
          h("button", { type: "button", style: "margin-top:8px", onclick: openCompare }, "Compare types")];
}

const draft = {
  kind: "text", text: "", fields: '{\n  "text": ""\n}', image: null, // {b64, url, name}
  model: null, questions: [], errors: {}, running: false, result: null, inputHint: null, questionsHint: null,
};
const FIELDS_STUB = '{\n  "text": ""\n}';

function newQuestion(type) {
  const used = new Set(draft.questions.map(q => q.id));
  let n = 1; while (used.has("q" + n)) n++;
  return { id: "q" + n, type, instructions: "", choice: [{ key: "", desc: "" }, { key: "", desc: "" }],
           levels: [levelToEditor(""), levelToEditor("")], yes: "", no: "" };
}

function fromWire(id, w) {
  const q = { id, type: w.type, instructions: typeof w.instructions === "string" ? w.instructions : JSON.stringify(w.instructions),
              choice: [{ key: "", desc: "" }, { key: "", desc: "" }], levels: [levelToEditor(""), levelToEditor("")], yes: "", no: "" };
  if (w.type === "choice") q.choice = Object.entries(w.criteria || {}).map(([key, d]) => ({ key, desc: typeof d === "string" ? d : "" }));
  if (w.type === "score") q.levels = (w.criteria || []).map(levelToEditor);
  if (w.type === "noul") { q.yes = w.criteria?.true || ""; q.no = w.criteria?.false || ""; }
  return q;
}

export async function newRun() {
  const dirty = draft.text.trim() || draft.image || draft.questions.some(q => q.instructions.trim());
  if (dirty && !(await confirmDialog("Start a new run?", "The current input and questions are cleared.", "Clear"))) return;
  Object.assign(draft, { kind: "text", text: "", fields: FIELDS_STUB, image: null, questions: [], errors: {}, result: null, focus: null,
                         inputHint: null, questionsHint: null });
  if ((location.hash || "#/run").startsWith("#/run")) route(); else location.hash = "#/run";
}

// History → "Open in editor": load a saved run into the Run view (nothing is sent).
export async function openInEditor(run) {
  const inp = run.input;
  draft.kind = inp.kind === "json" ? "json" : "text";
  if (draft.kind === "text") draft.text = inp.text; else draft.fields = JSON.stringify(inp.fields, null, 2);
  draft.model = run.model_requested;
  draft.questions = Object.entries(run.questions).map(([id, w]) => fromWire(id, w));
  Object.assign(draft, { focus: draft.questions[0]?.id, errors: {}, result: null, image: null });
  if (run.image_sha) {
    try {
      const blob = await (await fetch(`/api/images/${run.image_sha}`)).blob();
      const url = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
      draft.image = { b64: url.split(",")[1], url, name: `image from run #${run.id}` };
    } catch { /* the editor shows "attach image" and Box explains why it cannot run */ }
  }
  location.hash = "#/run";
}

// Wire format for one question (criteria shape depends on type).
export function toWire(q) {
  const w = { type: q.type, instructions: q.instructions.trim() };
  if (q.type === "choice") w.criteria = Object.fromEntries(q.choice.filter(o => o.key.trim()).map(o => [o.key.trim(), o.desc.trim() || null]));
  if (q.type === "score") w.criteria = q.levels.map(st => levelFromEditor(st).value);
  if (q.type === "noul") {  // API shape: {true?, false?}, omitted when both empty
    const c = {};
    if (q.yes.trim()) c.true = q.yes.trim();
    if (q.no.trim()) c.false = q.no.trim();
    if (Object.keys(c).length) w.criteria = c;
  }
  return w;
}

// Mirrors server validation (jev.validate_questions) so most mistakes show before sending.
function validateDraft() {
  const e = {};
  if (!draft.questions.length) e._questions = "Add at least one question.";
  const ids = new Set();
  for (const q of draft.questions) {
    const f = `q.${q.id}`;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(q.id)) e[f + ".id"] = "1-64 letters, digits, _ or -";
    else if (ids.has(q.id)) e[f + ".id"] = "IDs must be unique";
    ids.add(q.id);
    if (!q.instructions.trim()) e[f + ".instructions"] = "Write the question.";
    if (q.type === "choice") {
      const keys = q.choice.map(o => o.key.trim()).filter(Boolean);
      if (keys.length < 2) e[f + ".criteria"] = "A Choice needs at least 2 options.";
      else if (new Set(keys).size !== keys.length) e[f + ".criteria"] = "Options must be unique.";
    }
    if (q.type === "score") {
      const res = q.levels.map(levelFromEditor), bad = res.findIndex(r => r.error);
      if (q.levels.length < 2) e[f + ".criteria"] = "A Score needs at least 2 levels, none empty.";
      else if (bad >= 0) e[f + ".criteria"] = `Level ${bad}: ${res[bad].error}`;
    }
    if (q.type === "box") {
      if (!draft.image) e[f + ".criteria"] = "Box needs an image. Attach a PNG or JPEG above.";
      if ((draft.model || "").startsWith("jev-1.13")) e[f + ".criteria"] = "Box needs Jev 1.14 or later.";
    }
  }
  if (draft.kind === "json") {
    try {
      const v = JSON.parse(draft.fields);
      if (!v || typeof v !== "object" || Array.isArray(v)) e._input = "Fields must be a JSON object.";
    } catch (err) { e._input = "Fields are not valid JSON: " + err.message; }
  }
  return e;
}

function errText(key) {
  return draft.errors[key] ? h("p", { class: "err-text", role: "alert" }, draft.errors[key]) : null;
}

// Reusable criteria editors (also used by experiments later). onChange() is called after each edit.
export function choiceEditor(options, onChange, onStructure) {
  return h("div", {},
    options.map((o, i) => h("div", { class: "crit-row" },
      h("input", { class: "key", value: o.key, placeholder: `option ${i + 1}`, "aria-label": `Option ${i + 1} name`,
                   oninput: e => { o.key = e.target.value; onChange(); } }),
      h("input", { value: o.desc, placeholder: "description (optional)", "aria-label": `Option ${i + 1} description`,
                   oninput: e => { o.desc = e.target.value; onChange(); } }),
      h("button", { class: "link", type: "button", "aria-label": `Remove option ${i + 1}`, disabled: options.length <= 2,
                    onclick: () => { options.splice(i, 1); onStructure(); } }, "✕"))),
    h("button", { class: "link", type: "button", onclick: () => { options.push({ key: "", desc: "" }); onStructure(); } }, "+ option"));
}

// "name → value" rows ({key, kind, value}, see kvRows in metrics.js). `label` prefixes the aria-labels.
export function kvEditor(rows, onChange, onStructure, { addLabel = "+ field", label = "Field" } = {}) {
  const KINDS = [["text", "text"], ["list", "list"], ["json", "JSON"]];
  return h("div", { class: "kv" },
    rows.map((r, i) => h("div", { class: "kv-row" },
      h("input", { class: "key", value: r.key, placeholder: "name", "aria-label": `${label} ${i + 1} name`,
                   oninput: e => { r.key = e.target.value; onChange(); } }),
      h("select", { "aria-label": `${label} ${i + 1} kind`, onchange: e => { r.kind = e.target.value; onStructure(); } },
        KINDS.map(([v, l]) => h("option", { value: v, selected: r.kind === v }, l))),
      h("textarea", { value: r.value, rows: r.kind === "text" ? 1 : 3, "aria-label": `${label} ${i + 1} value`,
                      placeholder: r.kind === "list" ? "one item per line" : r.kind === "json" ? "JSON value" : "value",
                      oninput: e => { r.value = e.target.value; onChange(); } }),
      h("button", { class: "link", type: "button", "aria-label": `Remove ${label.toLowerCase()} ${i + 1}`, disabled: rows.length <= 1,
                    onclick: () => { rows.splice(i, 1); onStructure(); } }, "✕"))),
    h("button", { class: "link", type: "button", onclick: () => { rows.push({ key: "", kind: "text", value: "" }); onStructure(); } }, addLabel));
}

// levels: editor states from levelToEditor ({mode: "text" | "fields", text, rows}).
export function levelsEditor(levels, onChange, onStructure) {
  const move = (i, d) => { [levels[i], levels[i + d]] = [levels[i + d], levels[i]]; onStructure(); };
  // Each switch rebuilds the other form from the one being left, so edits made in either mode carry over.
  const setMode = (st, mode) => {
    if (mode === st.mode) return;
    if (mode === "fields") {
      const parsed = levelFromEdit(st.text);
      if (parsed.value && typeof parsed.value === "object") st.rows = kvRows(parsed.value);
      else if (st.text.trim()) st.rows = [{ key: "description", kind: "text", value: st.text.trim() }];
      else if (!st.rows.length) st.rows = [{ key: "description", kind: "text", value: "" }];
    } else {
      const o = kvObject(st.rows);
      if (o.value) st.text = JSON.stringify(o.value);
    }
    st.mode = mode; onStructure();
  };
  return h("div", {},
    h("p", { class: "muted small" }, "Ordered from lowest to highest. Describe each level concretely; use fields for a description with examples."),
    levels.map((st, i) => h("div", {},
      h("div", { class: "crit-row" },
        h("span", { class: "muted small", style: "width:1.5em;text-align:right" }, String(i)),
        st.mode === "fields" ? h("span", { style: "flex:1" })
          : h("input", { value: st.text, placeholder: `level ${i}`, "aria-label": `Level ${i}`,
                         oninput: e => { st.text = e.target.value; onChange(); } }),
        h("span", { class: "seg", role: "group", "aria-label": `Level ${i} format` },
          ["text", "fields"].map(m => h("button", { type: "button", "aria-pressed": String(st.mode === m), onclick: () => setMode(st, m) }, m))),
        h("button", { class: "link", type: "button", "aria-label": `Move level ${i} up`, disabled: i === 0, onclick: () => move(i, -1) }, "↑"),
        h("button", { class: "link", type: "button", "aria-label": `Move level ${i} down`, disabled: i === levels.length - 1, onclick: () => move(i, 1) }, "↓"),
        h("button", { class: "link", type: "button", "aria-label": `Remove level ${i}`, disabled: levels.length <= 2,
                      onclick: () => { levels.splice(i, 1); onStructure(); } }, "✕")),
      st.mode === "fields" && h("div", { class: "kv-level" }, kvEditor(st.rows, onChange, onStructure, { label: `Level ${i} field` })))),
    h("button", { class: "link", type: "button", onclick: () => { levels.push(levelToEditor("")); onStructure(); } }, "+ level"));
}

function questionCard(q, idx, rerender) {
  const f = `q.${q.id}`;
  const touch = () => { draft.errors = {}; };
  const typeSel = h("select", { "aria-label": "Question type",
    onchange: e => { q.type = e.target.value; draft.focus = q.id; rerender(); } },
    Object.entries(TYPE_LABEL).map(([v, l]) => h("option", { value: v, selected: q.type === v,
      disabled: v === "box" && (draft.model || "").startsWith("jev-1.13") }, v === "box" && (draft.model || "").startsWith("jev-1.13") ? l + " (Jev 1.14+)" : l)));
  let crit = null;
  if (q.type === "choice") crit = choiceEditor(q.choice, touch, rerender);
  if (q.type === "score") crit = levelsEditor(q.levels, touch, rerender);
  if (q.type === "noul") crit = h("details", { open: !!(q.yes || q.no) },
    h("summary", { class: "muted small" }, "Clarify what yes / no mean (optional)"),
    h("div", { class: "crit-row" }, h("input", { value: q.yes, "aria-label": "what counts as yes",
      placeholder: "Yes means… e.g. the fruit itself is described", oninput: e => { q.yes = e.target.value; touch(); } })),
    h("div", { class: "crit-row" }, h("input", { value: q.no, "aria-label": "what counts as no",
      placeholder: "No means… e.g. a brand or another fruit", oninput: e => { q.no = e.target.value; touch(); } })));
  return h("div", { class: "qcard stack", "data-qid": q.id, onfocusin: () => showGuide(q) },
    h("div", { class: "row" },
      typeSel,
      h("input", { class: "qid" + (draft.errors[f + ".id"] ? " has-err" : ""), value: q.id, "aria-label": "Question ID",
                   oninput: e => { q.id = e.target.value; touch(); } }),
      h("span", { style: "flex:1" }),
      h("button", { class: "link", type: "button", "aria-label": `Remove question ${q.id}`,
                    onclick: () => { draft.questions.splice(idx, 1); rerender(); } }, "Remove")),
    errText(f + ".id"),
    h("textarea", { class: draft.errors[f + ".instructions"] ? "has-err" : "", value: q.instructions, rows: 2,
                    "aria-label": "Question", placeholder: placeholderFor(q.type),
                    oninput: e => { q.instructions = e.target.value; touch(); } }),
    errText(f + ".instructions"),
    crit,
    errText(f + ".criteria"));
}

function showGuide(q) {
  draft.focus = q.id;
  const slot = document.getElementById("guide-slot");
  if (slot && slot.querySelector(".guide-card")?.dataset.type !== q.type) slot.replaceChildren(...guideSlot(q.type));
}

function placeholderFor(type) {
  const ref = draft.kind === "text" ? "`text`" : "`field_name`";
  return { noul: `Is ${ref} describing an apple?`, choice: `Which fruit is ${ref} describing?`,
           score: `How sweet does ${ref} say it is?`, box: "the apple in `image`" }[type];
}

// Jev rejects any side over 1568 px (and never resizes), so shrink big photos here; small ones get the server's message.
async function fitImage(dataUrl, type) {
  const img = new Image(); img.src = dataUrl;
  try { await img.decode(); } catch { return dataUrl; }
  const k = 1568 / Math.max(img.naturalWidth, img.naturalHeight);
  if (k >= 1) return dataUrl;
  const c = document.createElement("canvas");
  c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return type === "image/png" ? c.toDataURL("image/png") : c.toDataURL("image/jpeg", 0.92);
}

// ---------- JSON library ----------
// library.js imports app.js, so it is loaded on first use (like experiments.js) to keep the import cycle safe.
export async function openLibraryFor(place, onLoad, opts) {
  const { openLibrary } = await import("./library.js");
  openLibrary(place, onLoad, opts);
}

async function loadInput(an, rerender, { index = 0 } = {}) {
  const record = an.inputs.records[index];
  const dirty = draft.kind === "text" ? draft.text.trim() : draft.fields.trim() && draft.fields !== FIELDS_STUB;
  if (dirty && !(await confirmDialog("Replace the input?", `The current input is replaced by ${an.path}` +
      (an.inputs.records.length > 1 ? ` (record #${index + 1})` : "") + ".", "Replace"))) return;
  Object.assign(draft, { kind: "json", fields: JSON.stringify(record, null, 2), errors: {}, inputHint: null });
  // jev.build_state puts the attached image under `image`, so it wins over a field of that name.
  if (draft.image && Object.hasOwn(record, "image"))
    draft.inputHint = "This input has its own `image` field. The attached image replaces it when you run; remove the image to keep the field.";
  rerender();
}

async function loadQuestions(an, rerender) {
  const loaded = Object.entries(an.questions).map(([id, q]) => fromWire(id, q.wire));
  let mode = "replace";
  if (draft.questions.some(q => q.instructions.trim())) {
    mode = await choiceDialog("Load questions", `${an.path} has ${loaded.length} question${loaded.length === 1 ? "" : "s"}. ` +
      "Add them after the current questions, or replace the current ones?", [["add", "Add"], ["replace", "Replace"]]);
    if (!mode) return;
  }
  const renames = [];
  if (mode === "add") {
    const kept = draft.questions.filter(q => q.instructions.trim());
    const taken = new Set(kept.map(q => q.id));
    for (const q of loaded) {
      const id = freeId(q.id, taken);
      if (id !== q.id) { renames.push(`${q.id} → ${id}`); q.id = id; }
      taken.add(id);
    }
    draft.questions = [...kept, ...loaded];
  } else draft.questions = loaded;
  const bad = Object.values(an.questions).filter(q => !q.valid).length;
  draft.questionsHint = [renames.length && `Renamed to keep IDs unique: ${renames.join(", ")}.`,
                         bad && `${bad} loaded question${bad === 1 ? " has" : "s have"} problems; fix them before running.`]
    .filter(Boolean).join(" ") || null;
  Object.assign(draft, { focus: loaded[0]?.id, errors: {}, result: null });
  rerender();
}

function inputPanel(rerender) {
  const seg = h("div", { class: "seg", role: "group", "aria-label": "Input kind" },
    ["text", "json"].map(k => h("button", { type: "button", "aria-pressed": String(draft.kind === k),
      onclick: () => { draft.kind = k; rerender(); } }, k === "text" ? "Text" : "Fields (JSON)")));
  const box = draft.kind === "text"
    ? h("textarea", { value: draft.text, rows: 4, "aria-label": "Input text",
                      placeholder: "A round red fruit with a crisp, sweet bite",
                      oninput: e => { draft.text = e.target.value; } })
    : h("textarea", { class: draft.errors._input ? "has-err" : "", value: draft.fields, rows: 6, spellcheck: false,
                      "aria-label": "Input fields as JSON", style: "font-family: ui-monospace, monospace",
                      oninput: e => { draft.fields = e.target.value; draft.errors = {}; } });
  const file = h("input", { type: "file", accept: "image/png,image/jpeg", hidden: true,
    onchange: e => {
      const f = e.target.files[0]; if (!f) return;
      const r = new FileReader();
      r.onload = async () => {
        const url = await fitImage(String(r.result), f.type);
        draft.image = { b64: url.split(",")[1], url, name: f.name }; rerender();
      };
      r.readAsDataURL(f);
    } });
  return h("section", { class: "panel stack", "aria-label": "Input" },
    h("div", { class: "row" }, h("h2", { style: "margin:0" }, "Input"), seg),
    h("p", { class: "muted small", style: "margin:0" },
      draft.kind === "text" ? "Questions refer to it as `text`." : "Questions refer to fields by name, e.g. `ticket.subject`."),
    box, errText("_input"),
    draft.inputHint && h("p", { class: "hint" }, draft.inputHint),
    h("div", { class: "row" },
      file,
      h("button", { type: "button", onclick: () => file.click() }, draft.image ? "Replace image" : "Attach image"),
      h("button", { type: "button", id: "lib-run-input", title: "Load an input file from the JSON library (data/json/inputs)",
                    onclick: () => openLibraryFor("run-input", (an, extra) => loadInput(an, rerender, extra)) }, "Load JSON"),
      draft.image && h("img", { class: "thumb", src: draft.image.url, alt: "Attached image: " + draft.image.name }),
      draft.image && h("span", { class: "muted small" }, "Refer to it as `image`."),
      draft.image && h("button", { class: "link", type: "button", onclick: () => { draft.image = null; rerender(); } }, "Remove image")));
}

function runReason() {
  if (!app.status.key_present) return "No API key. See the banner above.";
  if (draft.questions.some(q => q.type === "box") && !draft.image) return "Box needs an image. Attach a PNG or JPEG.";
  if (draft.running) return "Running…";
  return null;
}

async function doRun(rerender) {
  draft.errors = validateDraft();
  if (Object.keys(draft.errors).length) return rerender();
  draft.running = true; rerender();
  const body = {
    input: draft.kind === "text" ? { kind: "text", text: draft.text } : { kind: "json", fields: JSON.parse(draft.fields) },
    image_base64: draft.image?.b64 || null,
    model: draft.model,
    questions: Object.fromEntries(draft.questions.map(q => [q.id, toWire(q)])),
  };
  try {
    draft.result = await api("POST", "/api/runs", body);
  } catch (err) {
    if (err.field?.startsWith("questions.")) draft.errors["q." + err.field.slice(10)] = err.error;
    else if (err.field === "image") draft.errors._input = err.error;
    draft.result = { status: "error", error: err.error, local: true };
  }
  draft.running = false; rerender();
}

function renderRun(view) {
  if (!draft.model) draft.model = app.prefs.default_model;
  if (!draft.questions.length) draft.questions.push(newQuestion("noul"));
  const rerender = () => { view.replaceChildren(); renderRun(view); };

  const reason = runReason();
  const runBtn = h("button", { class: "primary", type: "button", disabled: !!reason, title: reason || "Run (Ctrl+Enter)",
                               onclick: () => doRun(rerender) }, draft.running ? "Running…" : "Run");
  const modelSel = h("select", { "aria-label": "Model", onchange: e => { draft.model = e.target.value; draft.errors = {}; rerender(); } },
    app.status.models.map(m => h("option", { value: m, selected: m === draft.model }, m)));

  const editor = h("div", { class: "stack" },
    inputPanel(rerender),
    h("section", { class: "panel stack", "aria-label": "Questions" },
      h("div", { class: "row" }, h("h2", { style: "margin:0" }, "Questions"), h("span", { style: "flex:1" }),
        h("button", { type: "button", id: "lib-run-questions", title: "Load questions from the JSON library (data/json/questions)",
                      onclick: () => openLibraryFor("run-questions", an => loadQuestions(an, rerender)) }, "Load questions")),
      draft.questionsHint && h("p", { class: "hint" }, draft.questionsHint),
      draft.questions.map((q, i) => questionCard(q, i, rerender)),
      errText("_questions"),
      h("div", { class: "actions" },
        h("button", { type: "button", onclick: () => { draft.questions.push(newQuestion("noul")); rerender(); } }, "+ question"),
        h("span", { style: "flex:1" }),
        h("label", { class: "row small" }, "Model", modelSel),
        runBtn,
        reason && !draft.running && h("span", { class: "reason" }, reason))));

  const focused = draft.questions.find(q => q.id === draft.focus) || draft.questions[0];
  view.append(
    h("div", { class: "run-layout" }, editor, h("aside", { id: "guide-slot", "aria-label": "Type guide" }, guideSlot(focused.type))),
    h("section", { class: "results", "aria-live": "polite" }, draft.result && renderResult(draft.result, draft.questions, { onPresence: q => {
      const target = q.instructions.replace(/\s*in\s+`image`\s*[.?]?\s*$/i, "").trim();
      const n = newQuestion("noul");
      n.instructions = `Is there ${target} in \`image\`?`;
      draft.questions.push(n); draft.focus = n.id; rerender();
    } })));
  view.onkeydown = e => { if (e.ctrlKey && e.key === "Enter" && !runReason()) { e.preventDefault(); doRun(rerender); } };
}
registerView("run", renderRun);

// ---------- Settings view ----------
async function renderSettings(view) {
  const els = {};
  const status = h("span", { class: "muted small", role: "status" });
  const preview = h("span", { class: "muted small" });
  const showPreview = () => { preview.textContent = `0.7345 shows as ${fmtProb(0.7345)}`; };
  async function save(key, value) {
    try {
      app.prefs = await api("PUT", "/api/prefs", { ...app.prefs, [key]: value });
      applyPrefs();
      for (const [k, el] of Object.entries(els)) el.value = String(app.prefs[k]);  // the server may clamp
      showPreview();
      status.textContent = "Saved.";
    } catch (err) { status.textContent = err.error || String(err); }
  }
  const field = (key, label, el, { num = false, note } = {}) => {
    els[key] = el; el.id = "pref-" + key;
    el.addEventListener("change", () => save(key, num ? Number(el.value) : el.value));
    return [h("label", { for: el.id }, label), h("div", {}, el, note && h("p", { class: "muted small", style: "margin:4px 0 0" }, note))];
  };
  const select = (key, opts) => h("select", {}, opts.map(([v, t]) => h("option", { value: v, selected: String(app.prefs[key]) === v }, t)));
  const number = (key, attrs) => h("input", { type: "number", value: app.prefs[key], style: "width:7em", ...attrs });
  const models = [...new Set([app.prefs.default_model, ...app.status.models])];
  showPreview();

  const totalsBox = h("p", { class: "small" }, "…");
  api("GET", "/api/totals").then(t => {
    const line = (x, label) => h("div", {}, h("strong", {}, label), ` ${fmtUSD(x.cost_usd)} · ${x.runs} run${x.runs === 1 ? "" : "s"}`,
      x.unknown_cost_runs ? h("span", { class: "muted" }, ` · ${x.unknown_cost_runs} with unknown cost (no token count), not in the sum`) : "");
    totalsBox.replaceChildren(line(t.session, "This session"), line(t.all_time, "All time"));
  }).catch(err => { totalsBox.textContent = err.error; });

  view.append(h("div", { class: "panel stack settings" },
    h("div", { class: "row" }, h("h1", { style: "margin:0" }, "Settings"), h("span", { style: "flex:1" }), status),
    h("h2", {}, "Display"),
    h("div", { class: "settings-grid" },
      ...field("theme", "Theme", select("theme", [["system", "System"], ["light", "Light"], ["dark", "Dark"]])),
      ...field("text_scale", "Text size", select("text_scale", [["0.85", "Small"], ["1", "Normal"], ["1.15", "Large"], ["1.3", "Larger"], ["1.5", "Largest"]]), { num: true }),
      ...field("prob_format", "Probabilities as", select("prob_format", [["percent", "Percent (73%)"], ["fraction", "Fraction (0.73)"]])),
      ...field("prob_decimals", "Extra decimals", number("prob_decimals", { min: 0, max: 4, step: 1 }), { num: true }),
      h("span", {}), preview),
    h("h2", {}, "Runs"),
    h("div", { class: "settings-grid" },
      ...field("default_model", "Default model", select("default_model", models.map(m => [m, m]))),
      ...field("concurrency", "Parallel requests", number("concurrency", { min: 1, max: 8, step: 1 }), { num: true,
        note: "How many rows a matrix run sends at once (1–8)." }),
      ...field("price_per_mtok", "Price per million input tokens (USD)", number("price_per_mtok", { min: 0, step: "any" }), { num: true,
        note: "Applies to new runs only. Recorded runs keep the price they were charged at." })),
    h("h2", {}, "Cost"), totalsBox,
    h("p", { class: "muted small" }, "Data folder: ", h("code", {}, app.status.data_dir), " · API key from ", h("code", {}, app.status.key_file)),
    h("div", { class: "row" }, h("button", { type: "button", onclick: async () => {
      if (!(await confirmDialog("Reset settings?", "All settings go back to their defaults. Runs and experiments are not touched.", "Reset"))) return;
      app.prefs = await api("POST", "/api/prefs/reset"); applyPrefs(); route();
    } }, "Reset to defaults"))));
}
registerView("settings", renderSettings);

// ---------- result renderers ----------
function barLine(label, p, top) {
  return h("div", { class: "barline" + (top ? " is-top" : "") },
    h("span", { class: "lbl", title: label }, label),
    h("div", { class: "bar", role: "img", "aria-label": `${label} ${fmtProb(p)}` }, h("span", { style: `--v:${p}` })),
    h("span", { class: "num" }, fmtProb(p)));
}

const renderers = {
  noul(a) {
    return h("div", {},
      h("div", { class: "noul-main" },
        h("span", { class: "big" }, fmtProb(a.noul)),
        h("div", { class: "bar", role: "img", "aria-label": `probability of yes ${fmtProb(a.noul)}` }, h("span", { style: `--v:${a.noul}` })),
        bandTag(a.noul)),
      h("p", { class: "muted small", style: "margin:4px 0 0" }, "Probability that the answer is yes."));
  },
  choice(a) {
    const opts = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]);
    return h("div", {},
      h("div", { class: "row" }, h("span", { class: "big" }, a.choice), h("span", { class: "muted" }, "confidence " + fmtProb(a.confidence)), confTag(a.confidence)),
      h("div", { style: "margin-top:8px" }, opts.map(([k, p]) => barLine(k, p, k === a.choice))));
  },
  score(a) {
    const n = Object.keys(a.legend).length;
    const pos = n > 1 ? a.score / (n - 1) : 0;
    const nearest = levelText(a.legend[String(Math.round(a.score))]);
    const probs = Object.entries(a.probabilities).map(([k, p]) => [Number(k), p]).sort((x, y) => x[0] - y[0]);
    const [t1, t2] = [...probs].sort((x, y) => y[1] - x[1]);
    const split = t2 && Math.abs(t1[0] - t2[0]) > 1 && t1[1] >= 0.25 && t2[1] >= 0.25;
    return h("div", {},
      h("div", { class: "row" },
        h("span", { class: "big" }, a.score.toFixed(2)),
        h("span", {}, `of 0–${n - 1} · nearest “${nearest}”`),
        h("span", { class: "muted" }, "confidence " + fmtProb(a.confidence)), confTag(a.confidence)),
      h("div", { class: "scale", role: "img", "aria-label": `position ${a.score.toFixed(2)} on ${n} levels` },
        h("div", { class: "axis" }),
        probs.map(([i]) => h("div", { class: "tick", style: `left:${(i / (n - 1)) * 100}%` })),
        probs.map(([i]) => h("div", { class: "tick-lbl" + (i === 0 ? " first" : i === n - 1 ? " last" : ""),
                                      style: `left:${(i / (n - 1)) * 100}%`, title: levelText(a.legend[i]) }, String(i))),
        h("div", { class: "marker", style: `left:${pos * 100}%` })),
      probs.map(([i, p]) => barLine(`${i} · ${levelText(a.legend[i])}`, p, i === Math.round(a.score))),
      split && h("p", { class: "hint" }, `Split answer: levels ${t1[0]} and ${t2[0]} both carry weight. The position alone hides this.`));
  },
  box(a, { run, q, onPresence } = {}) {
    const b = a.box;
    let overlay = null;
    if (run?.image_sha) {
      const NS = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(NS, "svg");
      svg.setAttribute("viewBox", "0 0 100 100");
      svg.setAttribute("preserveAspectRatio", "none");
      svg.setAttribute("aria-hidden", "true");
      const rect = document.createElementNS(NS, "rect");
      for (const [k, v] of Object.entries({ x: b.left * 100, y: b.top * 100, width: (b.right - b.left) * 100, height: (b.bottom - b.top) * 100 }))
        rect.setAttribute(k, v);
      svg.append(rect);
      overlay = h("div", { class: "box-wrap" },
        h("img", { src: `/api/images/${run.image_sha}`, alt: "Image with the found box drawn on it" }), svg);
    }
    return h("div", { class: "stack" },
      overlay,
      h("div", { class: "row" }, h("span", { class: "muted" }, "confidence " + fmtProb(a.confidence)), confTag(a.confidence),
        onPresence && q && h("button", { type: "button", onclick: () => onPresence(q),
          title: "A Box always returns a box. A Noul tells you whether the object is there at all." }, "Add presence check")),
      h("p", { class: "small muted", style: "margin:0" }, `top ${b.top.toFixed(3)} · bottom ${b.bottom.toFixed(3)} · left ${b.left.toFixed(3)} · right ${b.right.toFixed(3)}`));
  },
};

export function renderAnswer(qid, q, a, ctx) {
  return h("div", { class: "ans" },
    h("div", { class: "ans-head" }, h("strong", {}, qid), h("span", { class: "qtype" }, TYPE_LABEL[a.type] || a.type),
      q && h("span", { class: "instr" }, q.instructions)),
    (renderers[a.type] || (x => h("pre", {}, JSON.stringify(x, null, 2))))(a, { ...ctx, q }));
}

export function renderResult(run, questions, { onPresence } = {}) {
  if (run.status === "error") {
    return h("div", { class: "result error", role: "alert" },
      h("strong", {}, run.local ? "Not sent: " : "Jev call failed: "), run.error,
      !run.local && h("p", { class: "meta" }, `run #${run.id} recorded · no cost`));
  }
  const qmap = run.questions || Object.fromEntries(questions.map(q => [q.id, toWire(q)]));
  return h("div", { class: "result" },
    Object.entries(run.answers).map(([qid, a]) => renderAnswer(qid, qmap[qid], a, { run, onPresence })),
    h("p", { class: "meta" },
      [run.model_used, run.input_tokens == null ? "tokens unknown" : `${run.input_tokens} tok`, fmtUSD(run.cost_usd),
       `${run.duration_ms} ms`, `run #${run.id}`].join(" · ")));
}

// ---------- boot ----------
let experiments;
async function boot() {
  try {
    [app.status, app.prefs] = await Promise.all([api("GET", "/api/status"), api("GET", "/api/prefs")]);
  } catch (err) {
    document.getElementById("view").append(h("div", { class: "result error" }, err.error || String(err)));
    return;
  }
  applyPrefs();
  showBanner();
  refreshTotals();
  [experiments] = await Promise.all([import("./experiments.js"), import("./history.js")]);  // register their views; loaded after app.js so the import cycle is safe
  addEventListener("hashchange", route);
  // Chrome and Opera keep Ctrl+N for a new window and never pass it to the page, so Alt+N does the same.
  addEventListener("keydown", e => {
    if (e.shiftKey || e.ctrlKey === e.altKey || document.querySelector("dialog[open]")) return;  // ctrl+alt = AltGr typing
    const k = e.key.toLowerCase();
    if (k === "h" && e.ctrlKey) { e.preventDefault(); location.hash = "#/history"; }
    else if (k === "n") { e.preventDefault(); location.hash.startsWith("#/experiments") ? experiments.newExperiment() : newRun(); }
  });
  route();
}
boot();
