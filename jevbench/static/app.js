// jevbench frontend. Plain ES module, no build. All user text goes through textContent (h()), never innerHTML.

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
    throw { status: 0, error: "Cannot reach the jevbench server. Is it still running in the terminal?" };
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw { status: res.status, ...(data || { error: res.statusText }) };
  return data;
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
  return h("span", { class: `tag tag-${b}`, title: `thresholds ${t?.low ?? BAND.low} / ${t?.high ?? BAND.high}` }, labels[b]);
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
      h("code", {}, app.status.key_file), ", then restart jevbench. ",
      "The guide and History still work without it."));
  }
  if (app.status.notice) b.append(h("p", {}, app.status.notice));
  b.hidden = !b.childElementCount;
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
  (views[name] || notBuilt)(view, rest);
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
  model: null, questions: [], errors: {}, running: false, result: null,
};

function newQuestion(type) {
  const used = new Set(draft.questions.map(q => q.id));
  let n = 1; while (used.has("q" + n)) n++;
  return { id: "q" + n, type, instructions: "", choice: [{ key: "", desc: "" }, { key: "", desc: "" }],
           levels: ["", ""], yes: "", no: "" };
}

// Wire format for one question (criteria shape depends on type).
export function toWire(q) {
  const w = { type: q.type, instructions: q.instructions.trim() };
  if (q.type === "choice") w.criteria = Object.fromEntries(q.choice.filter(o => o.key.trim()).map(o => [o.key.trim(), o.desc.trim() || null]));
  if (q.type === "score") w.criteria = q.levels.map(l => l.trim());
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
    if (q.type === "score" && (q.levels.length < 2 || q.levels.some(l => !l.trim())))
      e[f + ".criteria"] = "A Score needs at least 2 levels, none empty.";
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

export function levelsEditor(levels, onChange, onStructure) {
  const move = (i, d) => { [levels[i], levels[i + d]] = [levels[i + d], levels[i]]; onStructure(); };
  return h("div", {},
    h("p", { class: "muted small" }, "Ordered from lowest to highest. Describe each level concretely."),
    levels.map((l, i) => h("div", { class: "crit-row" },
      h("span", { class: "muted small", style: "width:1.5em;text-align:right" }, String(i)),
      h("input", { value: l, placeholder: `level ${i}`, "aria-label": `Level ${i}`,
                   oninput: e => { levels[i] = e.target.value; onChange(); } }),
      h("button", { class: "link", type: "button", "aria-label": `Move level ${i} up`, disabled: i === 0, onclick: () => move(i, -1) }, "↑"),
      h("button", { class: "link", type: "button", "aria-label": `Move level ${i} down`, disabled: i === levels.length - 1, onclick: () => move(i, 1) }, "↓"),
      h("button", { class: "link", type: "button", "aria-label": `Remove level ${i}`, disabled: levels.length <= 2,
                    onclick: () => { levels.splice(i, 1); onStructure(); } }, "✕"))),
    h("button", { class: "link", type: "button", onclick: () => { levels.push(""); onStructure(); } }, "+ level"));
}

function questionCard(q, idx, rerender) {
  const f = `q.${q.id}`;
  const touch = () => { draft.errors = {}; };
  const typeSel = h("select", { "aria-label": "Question type",
    onchange: e => { q.type = e.target.value; draft.focus = q.id; rerender(); } },
    Object.entries(TYPE_LABEL).map(([v, l]) => h("option", { value: v, selected: q.type === v }, l)));
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
      r.onload = () => { draft.image = { b64: String(r.result).split(",")[1], url: r.result, name: f.name }; rerender(); };
      r.readAsDataURL(f);
    } });
  return h("section", { class: "panel stack", "aria-label": "Input" },
    h("div", { class: "row" }, h("h2", { style: "margin:0" }, "Input"), seg),
    h("p", { class: "muted small", style: "margin:0" },
      draft.kind === "text" ? "Questions refer to it as `text`." : "Questions refer to fields by name, e.g. `ticket.subject`."),
    box, errText("_input"),
    h("div", { class: "row" },
      file,
      h("button", { type: "button", onclick: () => file.click() }, draft.image ? "Replace image" : "Attach image"),
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
  const modelSel = h("select", { "aria-label": "Model", onchange: e => { draft.model = e.target.value; draft.errors = {}; } },
    app.status.models.map(m => h("option", { value: m, selected: m === draft.model }, m)));

  const editor = h("div", { class: "stack" },
    inputPanel(rerender),
    h("section", { class: "panel stack", "aria-label": "Questions" },
      h("h2", {}, "Questions"),
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
    h("section", { class: "results", "aria-live": "polite" }, draft.result && renderResult(draft.result, draft.questions)));
  view.onkeydown = e => { if (e.ctrlKey && e.key === "Enter" && !runReason()) { e.preventDefault(); doRun(rerender); } };
}
registerView("run", renderRun);

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
    const nearest = a.legend[String(Math.round(a.score))];
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
                                      style: `left:${(i / (n - 1)) * 100}%`, title: a.legend[i] }, String(i))),
        h("div", { class: "marker", style: `left:${pos * 100}%` })),
      probs.map(([i, p]) => barLine(`${i} · ${a.legend[i]}`, p, i === Math.round(a.score))),
      split && h("p", { class: "hint" }, `Split answer: levels ${t1[0]} and ${t2[0]} both carry weight. The position alone hides this.`));
  },
  box(a) {
    const b = a.box;
    return h("div", {},
      h("div", { class: "row" }, h("span", { class: "muted" }, "confidence " + fmtProb(a.confidence)), confTag(a.confidence)),
      h("p", { class: "small" }, `top ${b.top.toFixed(3)} · bottom ${b.bottom.toFixed(3)} · left ${b.left.toFixed(3)} · right ${b.right.toFixed(3)}`));
  },
};

export function renderAnswer(qid, q, a) {
  return h("div", { class: "ans" },
    h("div", { class: "ans-head" }, h("strong", {}, qid), h("span", { class: "qtype" }, TYPE_LABEL[a.type] || a.type),
      q && h("span", { class: "instr" }, q.instructions)),
    (renderers[a.type] || (x => h("pre", {}, JSON.stringify(x, null, 2))))(a));
}

export function renderResult(run, questions) {
  if (run.status === "error") {
    return h("div", { class: "result error", role: "alert" },
      h("strong", {}, run.local ? "Not sent: " : "Jev call failed: "), run.error,
      !run.local && h("p", { class: "meta" }, `run #${run.id} recorded · no cost`));
  }
  const qmap = run.questions || Object.fromEntries(questions.map(q => [q.id, toWire(q)]));
  return h("div", { class: "result" },
    Object.entries(run.answers).map(([qid, a]) => renderAnswer(qid, qmap[qid], a)),
    h("p", { class: "meta" },
      [run.model_used, run.input_tokens == null ? "tokens unknown" : `${run.input_tokens} tok`, fmtUSD(run.cost_usd),
       `${run.duration_ms} ms`, `run #${run.id}`].join(" · ")));
}

// ---------- boot ----------
async function boot() {
  try {
    [app.status, app.prefs] = await Promise.all([api("GET", "/api/status"), api("GET", "/api/prefs")]);
  } catch (err) {
    document.getElementById("view").append(h("div", { class: "result error" }, err.error || String(err)));
    return;
  }
  applyPrefs();
  showBanner();
  await import("./experiments.js");  // registers its views; loaded after app.js so the import cycle is safe
  addEventListener("hashchange", route);
  route();
}
boot();
