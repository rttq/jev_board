// Experiments: list, setup, and one matrix per step. Live controls re-render from applyView with no fetch.
import { h, api, app, registerView, fmtProb, fmtUSD, choiceEditor, levelsEditor, kvEditor, renderAnswer, TYPE_LABEL, confirmDialog } from "./app.js";
import { applyView, transpose, matrixCsv, recordSummary, matchQuestions, levelText, kvRows, kvObject, levelToEditor, levelFromEditor,
         allSteps, chain, stepExp, missingRequests, gateFor, stepLabel, chainCsv, reachable } from "./metrics.js";
import { openLibrary } from "./library.js";

const DEFAULT_VIEW = {
  threshold: { low: 0.5, high: 0.8 }, focus_option: null, sort: { by: "input", dir: "asc" },
  filters: { labeled: null, misclassified: false, review_only: false, spread_min: null, tags: [], text: "" },
  pivot: false, overlay: "value", model: null, weights_override: null,
  gate: { min_level: null, pass_options: null, review_passes: false }, step_name: null, collapsed: false,
};
const clone = x => JSON.parse(JSON.stringify(x));
const vname = key => key.replace(/^c/, "v").replace(/@.*/, "");
const TAG = { yes: "YES", review: "REV", no: "NO" };
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
// Matrix label for an applyView row: JSON inputs read as a summary, not raw JSON (search and sort still use r.input).
const rowLabel = r => (r.row.input.kind === "json" ? recordSummary(r.row.input.fields) : r.input);

// ---------- list ----------
export async function newExperiment() {
  const list = await api("GET", "/api/experiments");
  const names = new Set(list.map(e => e.name));
  let n = list.length + 1; while (names.has(`Experiment ${n}`)) n++;
  const out = await api("POST", "/api/experiments", { name: `Experiment ${n}`, type: "noul", criteria: null, rows: [], columns: [] });
  location.hash = `#/experiments/${out.experiment.id}`;
}

async function renderList(view) {
  const list = await api("GET", "/api/experiments");
  view.append(h("div", { class: "row" }, h("h1", { style: "margin:0" }, "Experiments"), h("span", { style: "flex:1" }),
    h("button", { type: "button", class: "primary", title: "Alt+N", onclick: newExperiment }, "New experiment")));
  if (!list.length) {
    view.append(h("p", { class: "muted" }, "An experiment is a matrix: inputs as rows, wordings of one question as columns. ",
      "Create one to compare wordings across many inputs."));
    return;
  }
  view.append(h("table", { class: "list" },
    h("thead", {}, h("tr", {}, ["Name", "Type", "Size", "Cost", "Updated", ""].map(t => h("th", {}, t)))),
    h("tbody", {}, list.map(e => h("tr", {},
      h("td", {}, h("a", { href: `#/experiments/${e.id}` }, e.name)),
      h("td", {}, (e.steps || [e.type]).map(t => TYPE_LABEL[t]).join(" → ")),
      h("td", { class: "num" }, `${e.rows} × ${e.columns}`),
      h("td", { class: "num" }, fmtUSD(e.cost_usd)),
      h("td", { class: "muted small" }, e.updated_at.slice(0, 16).replace("T", " ")),
      h("td", {},
        h("button", { class: "link", type: "button", onclick: async () => {
          const out = await api("POST", `/api/experiments/${e.id}/duplicate`); location.hash = `#/experiments/${out.experiment.id}`;
        } }, "Duplicate"),
        h("button", { class: "link", type: "button", onclick: async () => {
          if (await confirmDialog("Delete experiment?", `“${e.name}” will be removed. Its runs stay in History.`, "Delete")) {
            await api("DELETE", `/api/experiments/${e.id}`); view.replaceChildren(); renderList(view);
          }
        } }, "Delete")))))));
}

// ---------- experiment page state ----------
// Page-level state lives in S; per-step UI state (selection, editors, errors) in S.ui[stepKey]. Step 1's key is "s0".
let S = null;

function mergeViews(exp) {
  exp.view = { ...clone(DEFAULT_VIEW), ...exp.view };
  exp.steps = (exp.steps || []).map(s => ({ ...s, view: { ...clone(DEFAULT_VIEW), ...s.view } }));
}

async function load(id) {
  const d = await api("GET", `/api/experiments/${id}`);
  S = { id, exp: d.experiment, cells: d.cells, run_costs: d.run_costs, models: d.models, cost: d.cost,
        running: null, runModel: app.prefs.default_model, resolved: null, ui: {}, chain: [], msgStep: "s0",
        setupErr: null, setupMsg: [...(app.flash || []), ...(d.warnings || [])].join(" ") || null, openSetup: !!app.flash?.length, newRows: "" };
  mergeViews(S.exp);
  app.flash = null;
  const lastJson = [...S.exp.rows].reverse().find(r => r.input?.kind === "json");
  S.newFields = lastJson ? blankFields(kvRows(lastJson.input.fields)) : [{ key: "text", kind: "text", value: "" }];
}

function ui(key) {
  if (!S.ui[key]) {
    const d = allSteps(S.exp).find(x => x.key === key);
    S.ui[key] = { selected: null, limit: 200, newCol: "", hideAfter: null, crit: critToEditor(d?.type, d?.criteria),
                  pendingType: null, rowErrors: {}, openSetup: false, lastResult: null, viewName: null };
  }
  return S.ui[key];
}

async function refreshCells() {
  const d = await api("GET", `/api/experiments/${S.id}`);
  Object.assign(S, { cells: d.cells, run_costs: d.run_costs, models: d.models, cost: d.cost });
  await refreshPlan();
}

// Only resolves the Run-with alias to the version it answers with; counts come from missingRequests.
async function refreshPlan() {
  try { S.resolved = (await api("GET", `/api/experiments/${S.id}/plan?model=${encodeURIComponent(S.runModel)}`)).resolved_model; }
  catch { S.resolved = null; }
}

// ---------- steps ----------
// st = one step as the page sees it: its definition, the rows that reach it, and its UI state.
function stepCtxs() {
  return S.chain.map(res => ({ def: res.def, i: res.def.index, key: res.def.key, arrived: res.arrived, res,
                               exp: stepExp(S.exp, res.def, res.arrived), ui: ui(res.def.key) }));
}
const multi = () => S.chain.length > 1;
const stepEl = st => root?.querySelector(`section.step[data-step="${CSS.escape(st.key)}"]`);
const stored = st => (st.i === 0 ? S.exp : S.exp.steps[st.i - 1]);  // the object that owns the step's view, views, labels
const sfx = st => (st.i === 0 ? "" : `-${st.key}`);  // step 1 keeps its original element ids
const hasAnswers = st => st.def.columns.some(c => Object.values(S.cells).some(r => r[c.key]));
const hasLabels = st => st.exp.rows.some(r => r.label != null);

function saveStep(st, patch) {
  return st.i === 0 ? saveDoc(patch)
    : saveDoc({ steps: S.exp.steps.map(s => (s.key === st.key ? { ...s, ...patch } : s)) }, st.key);
}

function setLabel(st, rowKey, val) {
  if (st.i === 0) { S.exp.rows.find(x => x.key === rowKey).label = val; return; }
  const s = stored(st), labels = { ...s.labels };
  if (val == null) delete labels[rowKey]; else labels[rowKey] = val;
  s.labels = labels;
}

function critToEditor(type, c) {
  if (type === "choice") return Object.entries(c || { "": null, " ": null }).map(([key, desc]) => ({ key: key.trim(), desc: desc || "" }));
  if (type === "score") return (c || ["", ""]).map(levelToEditor);
  return { yes: c?.true || "", no: c?.false || "" };
}

function critFromEditor(type, e) {
  if (type === "choice") return Object.fromEntries(e.filter(o => o.key.trim()).map(o => [o.key.trim(), o.desc.trim() || null]));
  if (type === "score") return e.map(st => levelFromEditor(st).value);
  const c = {};
  if (e.yes.trim()) c.true = e.yes.trim();
  if (e.no.trim()) c.false = e.no.trim();
  return Object.keys(c).length ? c : null;
}

function wire(st, col) {
  const q = { type: st.def.type, instructions: col.instructions };
  if (st.def.criteria != null) q.criteria = st.def.criteria;
  return q;
}

// Structural save: PUT then reload everything from the server's answer. Messages show in step `msgStep`'s setup.
async function saveDoc(patch, msgStep = "s0") {
  S.setupErr = null; S.msgStep = msgStep;
  try {
    const d = await api("PUT", `/api/experiments/${S.id}`, { ...S.exp, ...patch });
    const views = Object.fromEntries(S.exp.steps.map(s => [s.key, s.view]));  // keep live view edits (saved with a delay)
    const exp = { ...d.experiment, view: S.exp.view };
    mergeViews(exp);
    exp.steps = exp.steps.map(s => (views[s.key] ? { ...s, view: views[s.key] } : s));
    Object.assign(S, { exp, cells: d.cells, run_costs: d.run_costs, models: d.models, cost: d.cost });
    S.setupMsg = d.warnings?.join(" ") || null;
    // Reset type and criteria together: a stale pendingType with criteria rebuilt for def.type breaks the editor.
    for (const def of allSteps(S.exp)) Object.assign(ui(def.key), { crit: critToEditor(def.type, def.criteria), pendingType: null });
    await refreshPlan();
    return true;
  } catch (err) {
    S.setupErr = err.rows ? err.error + ": " + err.rows.map(r => `line ${r.index + 1 - S.exp.rows.length}: ${r.error}`).join("; ") : err.error;
    return false;
  } finally { drawAll(); }
}

// View-only changes: debounced PUT, never a Jev request, never reloads.
let saveTimer = null;
function saveViewSoon() {
  clearTimeout(saveTimer);
  const id = S.id;
  saveTimer = setTimeout(() => {
    if (S?.id === id) api("PUT", `/api/experiments/${id}`, S.exp).catch(err => { S.setupErr = err.error; });
  }, 500);
}

function changed() { drawGrids(); saveViewSoon(); }

async function addStep() {
  const before = new Set(S.exp.steps.map(s => s.key));
  if (!(await saveDoc({ steps: [...S.exp.steps, { type: "noul", criteria: null, columns: [], labels: {}, view: {} }] }))) return;
  const s = S.exp.steps.find(x => !before.has(x.key));
  if (!s) return;
  ui(s.key).openSetup = true;
  drawAll();
  const sec = root.querySelector(`section.step[data-step="${CSS.escape(s.key)}"]`);
  sec?.scrollIntoView({ block: "start" });
  sec?.querySelector(`#new-col-${CSS.escape(s.key)}`)?.focus();
}

async function removeStep(st) {
  if (!(await confirmDialog("Remove step?", `Step ${st.i + 1} and its setup will be removed. Its answers stay in History.`, "Remove"))) return;
  if (await saveDoc({ steps: S.exp.steps.filter(s => s.key !== st.key) })) root.querySelector("#add-step")?.focus();
}

// ---------- page ----------
let root = null;

async function renderExperiment(view, id) {
  root = view;
  try { await load(id); } catch (err) { view.append(h("div", { class: "result error" }, err.error || String(err))); return; }
  await refreshPlan();
  drawAll();
  view.onkeydown = e => { if (e.ctrlKey && e.key === "Enter") { e.preventDefault(); runMissing(stepAt(e.target)); } };
}

function stepAt(el) {
  const sts = stepCtxs(), key = el?.closest?.("section.step")?.dataset.step;
  return sts.find(s => s.key === key) || sts[0];
}

function drawAll() {
  if (!root || !S) return;
  S.chain = chain(S.exp, S.cells, S.models);
  root.replaceChildren(h("div", { id: "exp-summary" }), ...stepCtxs().map(stepSection), stepBar());
  drawGrids();
}

function stepSection(st) {
  const attrs = { class: "step", "data-step": st.key, id: `step-${st.key}`, "aria-labelledby": multi() ? `step-${st.key}-h` : null };
  if (multi() && st.def.view.collapsed) return h("section", { ...attrs, class: "step collapsed" }, stepHeader(st));
  return h("section", attrs,
    multi() && stepHeader(st),
    setupPanel(st),
    toolbar(st),
    h("div", { class: "dash-layout" }, h("div", { class: "grid-wrap" }),
      h("aside", { class: "cell-panel", "aria-label": multi() ? `Cell details, step ${st.i + 1}` : "Cell details" })));
}

function stepHeader(st) {
  const v = st.def.view, focusIn = sel => stepEl(st)?.querySelector(sel)?.focus();
  return h("div", { class: "row step-h" },
    h("button", { type: "button", class: "link step-toggle", "aria-expanded": String(!v.collapsed), "aria-controls": `step-${st.key}`,
                  title: v.collapsed ? "Expand this step" : "Collapse this step",
                  onclick: () => { v.collapsed = !v.collapsed; drawAll(); saveViewSoon(); focusIn(".step-toggle"); } }, v.collapsed ? "▸" : "▾"),
    h("h2", { id: `step-${st.key}-h`, style: "margin:0" }, `Step ${st.i + 1} · ${v.step_name || TYPE_LABEL[st.def.type]}`),
    h("span", { class: "muted small step-counts", "aria-live": "polite" }, countsText(st)),
    h("span", { style: "flex:1" }),
    h("button", { class: "link step-rename", type: "button", onclick: () => {
      const n = prompt("Step name (empty for the default):", v.step_name || "");
      if (n == null) return;
      v.step_name = n.trim() || null; drawAll(); saveViewSoon(); focusIn(".step-rename");
    } }, "Rename"),
    st.i > 0 && h("button", { class: "link", type: "button", onclick: () => removeStep(st) }, "Remove"));
}

function countsText(st) {
  const c = st.res.counts;
  return st.i > 0 && !c.entered ? `waiting for rows that pass step ${st.i}`
    : `${c.entered} in · ${c.passed} passed · ${c.stopped} stopped · ${c.waiting} waiting`;
}

function stepBar() {
  return h("div", { class: "stepbar" },
    multi() && h("div", { class: "funnel-wrap" }),
    h("div", { class: "row" },
      h("button", { type: "button", id: "add-step", onclick: addStep,
                    title: "Add a step: the rows that pass the last step's gate go on to it" }, "+ Add step"),
      multi() && h("span", { class: "chain-run-slot" }),
      multi() && h("button", { type: "button", title: "One line per input: its outcome and pass likelihood at every step",
                               onclick: () => download(`${safeName(S.exp.name)}-chain.csv`, chainCsv(S.exp, S.chain)) }, "Export chain CSV")));
}

// Where inputs drop out: entered / passed / stopped / waiting per step, and how many pass the whole chain.
function drawFunnel() {
  const wrap = root?.querySelector(".funnel-wrap");
  if (!wrap) return;
  root.querySelector(".chain-run-slot")?.replaceChildren(runChainButton());
  const res = S.chain, last = res[res.length - 1];
  const line = (label, key) => h("tr", {}, h("th", { scope: "row" }, label), res.map(r => h("td", { class: "num" }, r.counts[key])));
  wrap.replaceChildren(h("table", { class: "funnel", "aria-label": "Funnel" },
    h("caption", {}, `Passed the chain: ${last.counts.passed} of ${S.exp.rows.length}`),
    h("thead", {}, h("tr", {}, h("th", { scope: "col" }, ""), res.map(r => h("th", { scope: "col" }, stepLabel(r.def))))),
    h("tbody", {}, line("in", "entered"), line("passed", "passed"), line("stopped", "stopped"), line("waiting", "waiting"))));
}

function summary() {
  const e = S.exp, defs = allSteps(e);
  const visible = defs.reduce((a, d) => a + d.columns.filter(c => !c.hidden).length, 0);
  const parts = [defs.map(d => TYPE_LABEL[d.type]).join(" → "), `${e.rows.length} rows × ${visible} variants`,
                 ui("s0").lastResult?.model || "no answers yet", `${fmtUSD(S.cost.cost_usd)} spent here`];
  const withCells = Object.keys(S.cells).length;
  return h("div", { class: "row summary" }, h("a", { href: "#/experiments", class: "small" }, "← Experiments"),
    h("h1", { style: "margin:0" }, e.name), h("span", { class: "muted" }, parts.join(" · ")),
    e.view.overlay === "cost" && withCells && h("span", { class: "muted" }, `· per answered row ≈ ${fmtUSD(S.cost.cost_usd / withCells)}`),
    S.cost.unknown_cost_runs ? h("span", { class: "muted small" }, `(${S.cost.unknown_cost_runs} runs with unknown cost)`) : null);
}

// ---------- setup ----------
function parseCSV(text) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { row.push(f); f = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; }
    else f += ch;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}

function labelFrom(s) {
  s = (s || "").trim();
  if (!s) return null;
  return S.exp.type === "score" && /^\d+$/.test(s) ? Number(s) : s;
}

// The input form keeps field names and kinds between inputs; only the values are cleared.
const blankFields = rows => rows.map(r => ({ ...r, value: "" }));

async function addFormInput() {
  const r = kvObject(S.newFields);
  if (r.error) { S.setupErr = "Input: " + r.error; S.msgStep = "s0"; return drawAll(); }
  if (await saveDoc({ rows: [...S.exp.rows, { input: { kind: "json", fields: r.value } }] })) { S.newFields = blankFields(S.newFields); drawAll(); }
}

// ---------- JSON library ----------
async function addLibraryRows(an) {
  const records = an.inputs.records, before = S.exp.rows.length;
  if (records.length === 1) {  // one record: fill the form so it can be checked before adding
    S.newFields = kvRows(records[0]);
    S.setupMsg = `Form filled from ${an.path}. Check the fields, then click Add input.`; S.msgStep = "s0";
    S.openSetup = true; return drawAll();
  }
  if (!(await saveDoc({ rows: [...S.exp.rows, ...records.map(f => ({ input: { kind: "json", fields: f } }))] }))) return;
  S.newFields = blankFields(kvRows(records[0]));
  const added = S.exp.rows.length - before, merged = records.length - added;
  S.setupMsg = [`${plural(added, "row")} added from ${an.path}` + (merged ? ` · ${merged} merged as repeats` : "") + ".",
                S.exp.reference && records.some(r => Object.hasOwn(r, "reference")) &&
                  "Rows with their own `reference` field keep it; the shared reference is not used for them."]
    .filter(Boolean).join(" ");
  S.openSetup = true; drawAll();
}

async function addLibraryVariants(st, an) {
  const m = matchQuestions(st.exp, an.questions), before = st.def.columns.length;
  const patch = { columns: [...st.def.columns, ...m.columns] };
  if (!before) Object.assign(patch, { type: m.type, criteria: m.criteria });  // an empty step takes the file's question
  if (!(await saveStep(st, patch))) return;
  const now = allSteps(S.exp)[st.i];
  ui(st.key).pendingType = null;
  const added = now.columns.length - before, merged = m.columns.length - added;
  S.setupMsg = [`${plural(added, "variant")} added from ${an.path}` + (merged ? ` · ${merged} merged as repeats` : "") + ".",
                m.skipped.length && "Skipped: " + m.skipped.map(x => `${x.id}: ${x.reason}`).join("; ") + "."]
    .filter(Boolean).join(" ");
  if (st.i === 0) S.openSetup = true; else ui(st.key).openSetup = true;
  drawAll();
}

async function importFile(file) {
  const text = await file.text();
  let rows;
  if (/\.csv$/i.test(file.name)) {
    const [head, ...rest] = parseCSV(text);
    const idx = n => head.findIndex(x => x.trim().toLowerCase() === n);
    const [ii, li, ti] = [idx("input"), idx("label"), idx("tags")];
    if (ii < 0) { S.setupErr = "The CSV needs an `input` column (optional: label, tags)."; S.msgStep = "s0"; return drawAll(); }
    rows = rest.map(r => ({ input: r[ii], label: li >= 0 ? labelFrom(r[li]) : null,
                            tags: ti >= 0 ? (r[ti] || "").split(/[;|]/) : [] }));
  } else rows = text.split(/\r?\n/).filter(l => l.trim()).map(l => ({ input: l }));
  await saveDoc({ rows: [...S.exp.rows, ...rows] });
}

// Step 1: name, question, inputs, reference, variants (as before steps existed). Later steps: question and variants only.
function setupPanel(st) {
  const e = S.exp, d = st.def, u = st.ui, locked = hasAnswers(st), first = st.i === 0;
  const typeSel = h("select", { "aria-label": first ? "Experiment type" : `Step ${st.i + 1} type`, disabled: locked,
    onchange: ev => { u.crit = critToEditor(ev.target.value, null); u.pendingType = ev.target.value; drawAll(); } },
    ["noul", "choice", "score"].map(t => h("option", { value: t, selected: (u.pendingType || d.type) === t }, TYPE_LABEL[t])));
  const type = u.pendingType || d.type;
  const noop = () => {}, redraw = () => drawAll();
  let crit;
  if (type === "choice") crit = choiceEditor(u.crit, noop, redraw);
  else if (type === "score") crit = levelsEditor(u.crit, noop, redraw);
  else crit = h("div", {},
    h("p", { class: "muted small" }, "Optional: what counts as yes / no (shared by every variant)."),
    h("div", { class: "crit-row" }, h("input", { value: u.crit.yes, placeholder: "Yes means…", "aria-label": "what counts as yes",
      oninput: ev => { u.crit.yes = ev.target.value; } })),
    h("div", { class: "crit-row" }, h("input", { value: u.crit.no, placeholder: "No means…", "aria-label": "what counts as no",
      oninput: ev => { u.crit.no = ev.target.value; } })));
  const name = first && h("input", { value: e.name, "aria-label": "Experiment name", style: "min-width:16em" });
  const file = h("input", { type: "file", accept: ".txt,.csv,text/plain,text/csv", hidden: true,
                            onchange: ev => ev.target.files[0] && importFile(ev.target.files[0]) });
  const ref = e.rows[0]?.input.kind === "json" ? "`field`" : "`text`";
  const refBox = first && h("textarea", { id: "exp-ref", rows: 3, value: e.reference || "",
                                          placeholder: "e.g. a passage from a book or doc the inputs are judged against" });
  const mine = S.msgStep === st.key;
  const open = first ? !e.rows.length || !d.columns.length || (mine && !!S.setupErr) || S.openSetup
    : !d.columns.length || (mine && !!S.setupErr) || u.openSetup;
  return h("details", { class: "panel setup", open,
                        ontoggle: ev => { if (first) S.openSetup = ev.target.open; else u.openSetup = ev.target.open; } },
    h("summary", {}, h("strong", {}, "Setup"),
      h("span", { class: "muted small" }, first ? " · name, type, shared criteria, inputs, variants" : " · question and variants")),
    h("div", { class: "setup-grid" },
      h("section", { class: "stack" },
        h("h2", {}, "Question"),
        h("div", { class: "row" }, name, typeSel),
        h("fieldset", { disabled: locked, class: "plain" }, crit),
        locked && h("p", { class: "muted small" }, "Type and criteria are fixed once answers exist (they are part of every cell's identity). ",
          h("button", { class: "link", type: "button", onclick: async () => {
            const out = await api("POST", `/api/experiments/${S.id}/duplicate`); location.hash = `#/experiments/${out.experiment.id}`;
          } }, "Duplicate to change")),
        first && h("label", { class: "small", for: "exp-ref" }, "Shared reference (optional)"),
        refBox,
        first && h("p", { class: "muted tiny" }, "Sent with every input as `reference`; point wordings at it. Changing it starts fresh cells."),
        h("button", { type: "button", onclick: () => {
          const patch = first ? { name: name.value, reference: refBox.value } : {};
          const res = !locked && type === "score" ? u.crit.map(levelFromEditor) : [], bad = res.findIndex(r => r.error);
          if (bad >= 0) { S.setupErr = `Level ${bad}: ${res[bad].error}`; S.msgStep = st.key; drawAll(); return; }
          if (!locked) { patch.type = type; patch.criteria = critFromEditor(type, u.crit); }
          u.pendingType = null; saveStep(st, patch);
        } }, "Save question")),
      first && h("section", { class: "stack" },
        h("h2", {}, "Add inputs"),
        h("p", { class: "muted small" }, "One input as named fields. Questions refer to them by name, e.g. `answer`."),
        kvEditor(S.newFields, noop, redraw, { label: "Input field" }),
        h("div", { class: "row" },
          h("button", { type: "button", onclick: addFormInput }, "Add input"),
          file, h("button", { type: "button", onclick: () => file.click() }, "Import .txt / .csv"),
          h("button", { type: "button", id: "lib-exp-input", title: "Add inputs from the JSON library (data/json/inputs)",
                        onclick: () => openLibrary("exp-input", addLibraryRows) }, "Load JSON"),
          h("span", { class: "muted small" }, "CSV columns: input, label, tags")),
        h("details", {},
          h("summary", { class: "muted small" }, "Paste lines (one text input per line)"),
          h("textarea", { rows: 4, value: S.newRows, "aria-label": "New inputs, one per line",
                          placeholder: "One input per line", oninput: ev => { S.newRows = ev.target.value; } }),
          h("button", { type: "button", onclick: async () => {
            const lines = S.newRows.split(/\r?\n/).filter(l => l.trim());
            if (lines.length && await saveDoc({ rows: [...e.rows, ...lines.map(l => ({ input: l }))] })) { S.newRows = ""; drawAll(); }
          } }, "Add lines"))),
      h("section", { class: "stack" },
        h("h2", {}, "Add variant"),
        h("textarea", { id: `new-col${sfx(st)}`, rows: 3, value: u.newCol, "aria-label": first ? "New variant wording" : `New variant wording, step ${st.i + 1}`,
                        placeholder: `A wording of the question, e.g. Does ${ref} describe an apple?`,
                        oninput: ev => { u.newCol = ev.target.value; } }),
        h("div", { class: "row" },
          h("button", { type: "button", onclick: async () => {
            if (!u.newCol.trim()) return;
            const cols = d.columns.map(c => (c.key === u.hideAfter ? { ...c, hidden: true } : c));
            if (await saveStep(st, { columns: [...cols, { instructions: u.newCol.trim() }] })) { u.newCol = ""; u.hideAfter = null; drawAll(); }
          } }, "+ variant"),
          h("button", { type: "button", id: `lib-exp-questions${sfx(st)}`, title: "Add wordings from a question file in the JSON library (data/json/questions)",
                        onclick: () => openLibrary("exp-questions", an => addLibraryVariants(st, an),
                                                   { exp: { type: d.type, criteria: d.criteria, columns: d.columns } }) },
            "Load questions"),
          u.hideAfter && h("label", { class: "small" }, h("input", { type: "checkbox", checked: true,
            onchange: ev => { if (!ev.target.checked) u.hideAfter = null; } }), ` hide ${vname(u.hideAfter)} after adding`)))),
    mine && S.setupErr && h("p", { class: "err-text", role: "alert" }, S.setupErr),
    mine && S.setupMsg && h("p", { class: "hint" }, S.setupMsg));
}

// ---------- toolbar ----------
function toolbar(st) {
  const v = st.def.view, e = st.exp;
  const num = (val, attrs, on) => h("input", { type: "number", step: "any", min: 0, max: 1, value: val, style: "width:5em", ...attrs,
                                              onchange: ev => on(Number(ev.target.value)) });
  const setT = (which, x) => {
    x = Math.min(1, Math.max(0, x));
    const t = v.threshold;
    if (which === "low") t.low = Math.min(x, t.high - 0.01); else t.high = Math.max(x, t.low + 0.01);
    t.low = +t.low.toFixed(2); t.high = +t.high.toFixed(2);
    for (const el of stepEl(st).querySelectorAll("[data-t]")) el.value = t[el.dataset.t];
    const gt = stepEl(st).querySelector(".gate-t");
    if (gt) gt.textContent = gateThresholdText(v);
    changed();
  };
  const range = which => h("input", { type: "range", min: 0, max: 1, step: 0.01, value: v.threshold[which], "data-t": which,
                                      "aria-label": `${which} threshold`, oninput: ev => setT(which, Number(ev.target.value)) });
  const sel = (label, value, options, on, attrs = {}) => h("label", { class: "row small" }, label,
    h("select", { onchange: ev => on(ev.target.value), ...attrs }, options.map(([val, text]) => h("option", { value: val, selected: val === value }, text))));
  const visible = e.columns.filter(c => !c.hidden);
  const sortOpts = [["input", "input"], ["composite", "composite"], ["spread", "spread"], ["label", "label"],
                    ...visible.map(c => [c.key, vname(c.key)])];
  const tags = [...new Set(e.rows.flatMap(r => r.tags || []))];
  const modelOpts = [["", "latest answered"], ...S.models.map(m => [m, m]), ...(S.models.length > 1 ? [["compare", "compare versions"]] : [])];
  const seg = (items, cur, on) => h("div", { class: "seg", role: "group" },
    items.map(([val, text]) => h("button", { type: "button", "aria-pressed": String(cur === val), onclick: () => on(val) }, text)));
  const views = st.def.views || {}, savedNames = Object.keys(views);
  const hidden = e.columns.filter(c => c.hidden);
  const keep = cur => ({ step_name: cur.step_name, collapsed: cur.collapsed });  // not part of a saved view
  const setView = nv => { stored(st).view = nv; };

  return h("section", { class: "panel toolbar", "aria-label": multi() ? `Analysis controls, step ${st.i + 1}` : "Analysis controls" },
    h("div", { class: "row" },
      h("strong", { class: "small" }, "Threshold"), h("span", { class: "muted small" }, "no"),
      range("low"), num(v.threshold.low, { "data-t": "low", "aria-label": "low threshold value" }, x => setT("low", x)),
      range("high"), num(v.threshold.high, { "data-t": "high", "aria-label": "high threshold value" }, x => setT("high", x)),
      h("span", { class: "muted small" }, "yes"),
      h("span", { style: "flex:1" }),
      seg([["value", "Values"], ["cost", "Cost"]], v.overlay, x => { v.overlay = x; drawAll(); saveViewSoon(); }),
      h("button", { type: "button", "aria-pressed": String(!!v.pivot), onclick: () => { v.pivot = !v.pivot; drawAll(); saveViewSoon(); } }, "Pivot"),
      h("button", { type: "button", title: "Download what the grid shows: visible rows and variants, values, composite, spread, label, metrics",
                    onclick: () => exportMatrix(st) }, "Export CSV")),
    h("div", { class: "row" },
      sel("Sort", v.sort.by, sortOpts, x => { v.sort.by = x; changed(); }),
      h("button", { type: "button", "aria-label": "sort direction", onclick: ev => {
        v.sort.dir = v.sort.dir === "asc" ? "desc" : "asc"; ev.target.textContent = v.sort.dir; changed(); } }, v.sort.dir),
      sel("Show", v.filters.labeled ?? "", [["", "all rows"], ["labeled", "labeled"], ["unlabeled", "unlabeled"]],
          x => { v.filters.labeled = x || null; changed(); }),
      (hasLabels(st) || v.filters.misclassified) && h("label", { class: "row small" }, h("input", { type: "checkbox", checked: !!v.filters.misclassified,
        onchange: ev => { v.filters.misclassified = ev.target.checked; changed(); } }), "misclassified"),
      h("label", { class: "row small" }, h("input", { type: "checkbox", checked: v.filters.review_only,
        onchange: ev => { v.filters.review_only = ev.target.checked; changed(); } }), "review only"),
      h("label", { class: "row small" }, "spread ≥", h("input", { type: "number", step: "0.05", min: 0, max: 1, style: "width:5em",
        value: v.filters.spread_min ?? "", onchange: ev => { v.filters.spread_min = ev.target.value === "" ? null : Number(ev.target.value); changed(); } })),
      tags.length > 0 && sel("tag", v.filters.tags[0] || "", [["", "any"], ...tags.map(t => [t, t])],
          x => { v.filters.tags = x ? [x] : []; changed(); }),
      h("input", { type: "search", placeholder: "filter text", "aria-label": "Filter inputs by text", value: v.filters.text,
                   oninput: ev => { v.filters.text = ev.target.value; changed(); } })),
    h("div", { class: "row" },
      sel("Model", v.model ?? "", modelOpts, x => { v.model = x || null; changed(); }),
      e.type === "choice" && sel("Focus", v.focus_option ?? Object.keys(e.criteria || {})[0], Object.keys(e.criteria || {}).map(k => [k, k]),
          x => { v.focus_option = x; changed(); }),
      hidden.length > 0 && h("span", { class: "small muted" }, "Hidden: ",
        hidden.map(c => h("button", { class: "link", type: "button", title: "Show again",
          onclick: () => saveStep(st, { columns: e.columns.map(x => (x.key === c.key ? { ...x, hidden: false } : x)) }) }, `${vname(c.key)} ↺`))),
      h("span", { style: "flex:1" }),
      sel("View", st.ui.viewName || "", [["", "current"], ...savedNames.map(n => [n, n])], x => {
        st.ui.viewName = x || null;
        if (x) { setView({ ...clone(DEFAULT_VIEW), ...clone(views[x]), ...keep(v) }); drawAll(); saveViewSoon(); }
      }),
      h("button", { type: "button", onclick: () => {
        const n = prompt("Save the current view as:", st.ui.viewName || "");
        if (n && n.trim()) { stored(st).views = { ...views, [n.trim()]: clone(v) }; st.ui.viewName = n.trim(); drawAll(); saveViewSoon(); }
      } }, "Save view…"),
      st.ui.viewName && h("button", { class: "link", type: "button", onclick: () => {
        const n = prompt("Rename view:", st.ui.viewName);
        if (n && n.trim() && n.trim() !== st.ui.viewName) {
          const nv = { ...views, [n.trim()]: views[st.ui.viewName] }; delete nv[st.ui.viewName];
          stored(st).views = nv; st.ui.viewName = n.trim(); drawAll(); saveViewSoon();
        }
      } }, "Rename"),
      st.ui.viewName && h("button", { class: "link", type: "button", onclick: () => {
        const nv = { ...views }; delete nv[st.ui.viewName]; stored(st).views = nv; st.ui.viewName = null; drawAll(); saveViewSoon();
      } }, "Delete view"),
      h("button", { class: "link", type: "button", onclick: () => { setView({ ...clone(DEFAULT_VIEW), ...keep(v) }); st.ui.viewName = null; drawAll(); saveViewSoon(); } }, "Reset view")),
    multi() && gateRow(st),
    h("div", { class: "runbar-slot" }));
}

// ---------- gate ----------
const gateThresholdText = v => `pass ≥ ${v.threshold.high} · stop < ${v.threshold.low}`;

function gateRow(st) {
  const d = st.def, v = d.view, g = v.gate, now = gateFor(d);
  const warn = [];
  if (!d.columns.some(c => !c.hidden)) warn.push("No visible variants: every row waits here.");
  if (v.model === "compare") warn.push(`Comparing versions: the gate uses ${S.models[0] || "the latest model"}.`);
  if (d.type === "choice" && !now.passOptions.length) warn.push("No option is marked as passing: no row can pass.");
  if (d.type === "score" && now.minLevel === 0) warn.push("Minimum level is the lowest: every judged row passes.");
  const regate = sel => { drawAll(); saveViewSoon(); stepEl(st)?.querySelector(`.gate-row ${sel}`)?.focus(); };  // warnings follow the gate
  const level = d.type === "score" && h("label", { class: "row small" }, "Pass at level ≥",
    h("select", { "aria-label": `Minimum passing level, step ${st.i + 1}`,
                  onchange: ev => { g.min_level = Number(ev.target.value); regate("select"); } },
      (d.criteria || []).map((l, i) => h("option", { value: i, selected: i === now.minLevel }, `${i} · ${levelText(l)}`))));
  const options = d.type === "choice" && h("span", { class: "row small", role: "group", "aria-label": `Passing options, step ${st.i + 1}` },
    "Passing options:",
    Object.keys(d.criteria || {}).map(k => h("label", { class: "row small" }, h("input", { type: "checkbox", checked: now.passOptions.includes(k), "data-opt": k,
      onchange: ev => {
        const set = new Set(gateFor(d).passOptions);
        if (ev.target.checked) set.add(k); else set.delete(k);
        g.pass_options = Object.keys(d.criteria).filter(x => set.has(x));  // keep the criteria's order
        regate(`input[data-opt="${CSS.escape(k)}"]`);
      } }), k)));
  return h("div", { class: "row gate-row" },
    h("strong", { class: "small" }, "Gate"),
    level, options,
    h("span", { class: "muted small gate-t" }, gateThresholdText(v)),
    h("label", { class: "row small" }, h("input", { type: "checkbox", checked: !!g.review_passes,
      onchange: ev => { g.review_passes = ev.target.checked; changed(); } }), "review passes"),
    warn.map(w => h("span", { class: "hint small", role: "status" }, w)));
}

function gateCell(st, key) {
  const o = st.res.outcome[key];
  if (!o || o.state === "wait") return h("td", { class: "gate gate-wait" }, "waiting");
  const p = fmtProb(o.p), review = o.band === "review" ? "review → " : "";
  return o.state === "pass" ? h("td", { class: "gate gate-pass" }, `${review}passes ${p}`)
    : h("td", { class: "gate gate-stop" }, `${review}stops ${p}`);
}

function runBar(st) {
  const n = missingRequests(st.arrived, st.def.columns, S.cells, S.resolved).length;
  const reason = !app.status.key_present ? "No API key. See the banner above."
    : !S.exp.rows.length || !st.def.columns.some(c => !c.hidden)
      ? (st.i === 0 ? "Add inputs and at least one variant in Setup." : "Add at least one variant to this step.")
    : S.running ? `Running… ${S.running.label ? S.running.label + ": " : ""}${S.running.done}/${S.running.total}`
    : st.i > 0 && !st.arrived.length ? "No rows reach this step yet."
    : n === 0 ? "Every visible cell has an answer for this model." : null;
  return h("div", { class: "row runbar" },
    h("label", { class: "row small" }, "Run with",
      h("select", { "aria-label": "Model to run", onchange: async ev => { S.runModel = ev.target.value; await refreshPlan(); drawAll(); } },
        app.status.models.map(m => h("option", { value: m, selected: m === S.runModel }, m)))),
    h("button", { type: "button", class: "primary", disabled: !!reason, title: reason || "Ctrl+Enter", onclick: () => runMissing(st) },
      `Run missing (${n})`),
    reason && h("span", { class: "reason small muted", "aria-live": "polite" }, reason));
}

// Rows each step could still get (step 1: all of them); the upper bound Run chain confirms before it starts.
const chainRows = st => (st.i === 0 ? st.arrived : reachable(S.exp, S.chain, st.i));

function runChainButton() {
  const work = stepCtxs().some(st => missingRequests(chainRows(st), st.def.columns, S.cells, S.resolved).length);
  const reason = !app.status.key_present ? "No API key. See the banner above." : S.running ? "A run is in progress."
    : !work ? "Every step already has answers for every row that can reach it." : null;
  return h("button", { type: "button", id: "run-chain", class: "primary", disabled: !!reason,
                       title: reason || "Run every step in order; each step only gets the rows that pass the one before", onclick: runChain }, "Run chain");
}

// Step by step: run what is missing, re-gate with the new answers, move on. Failed rows stay waiting and go no further.
async function runChain() {
  if (S.running) return;
  const sts = stepCtxs();
  let plans;
  try { plans = await Promise.all(sts.map(st => stepPlan(st, st.i === 0 ? null : chainRows(st)))); } catch { return drawAll(); }
  if (!plans.some(p => p.requests.length)) return drawAll();
  const text = plans.map((p, i) => `Step ${i + 1}: ${i ? "at most " : ""}${p.requests.length} requests ≈ ${fmtUSD(p.estimated_cost_usd)}`);
  if (!(await confirmDialog("Run the whole chain?", `${text.join(" · ")} · on ${plans[0].model}`, "Run chain"))) return;
  for (let i = 0; i < sts.length; i++) {
    S.chain = chain(S.exp, S.cells, S.models);
    const st = stepCtxs()[i];
    let p;
    try { p = await stepPlan(st); } catch { break; }
    if (p.requests.length) await runRequests(st, p.requests, `Step ${i + 1}`);
  }
  drawAll();
}

// ---------- runner ----------
// The plan for one step: step 1 over every row; later steps over the rows that reach them (never asked with none).
async function stepPlan(st, rows = st.i === 0 ? null : st.arrived) {
  if (rows && !rows.length) return { requests: [], estimated_tokens: 0, estimated_cost_usd: 0, model: S.runModel };
  const q = `model=${encodeURIComponent(S.runModel)}` + (st.i ? `&step=${encodeURIComponent(st.key)}` : "")
    + (rows ? `&rows=${encodeURIComponent(rows.join(","))}` : "");
  const p = await api("GET", `/api/experiments/${S.id}/plan?${q}`);
  S.resolved = p.resolved_model;
  return p;
}

async function runMissing(st) {
  if (S.running || !st) return;
  let p;
  try { p = await stepPlan(st); } catch { return drawAll(); }
  if (!p.requests.length) return drawAll();
  const cells = p.requests.reduce((a, r) => a + r.columns.length, 0);
  const ok = await confirmDialog("Run missing cells?", (multi() ? `Step ${st.i + 1}: ` : "") +
    `${p.requests.length} requests (one per input) for ${cells} cells on ${p.model} · ≈ ${p.estimated_tokens} tokens · ≈ ${fmtUSD(p.estimated_cost_usd)}`, "Run");
  if (!ok) return;
  await runRequests(st, p.requests);
}

async function runRequests(st, requests, label = null) {
  S.running = { done: 0, total: requests.length, label };
  drawAll();
  const queue = [...requests];
  const worker = async () => { while (queue.length) await runRow(st, queue.shift()); };
  await Promise.all(Array.from({ length: Math.min(app.prefs.concurrency, requests.length) }, worker));
  S.running = null;
  await refreshCells();
  drawAll();
}

async function runRow(st, req) {
  const row = S.exp.rows.find(r => r.key === req.row);
  const cols = req.columns.map(k => st.def.columns.find(c => c.key === k)).filter(Boolean);
  let run;
  try {
    run = await api("POST", "/api/runs", { input: row.input, model: S.runModel, experiment_id: S.id,
                                          questions: Object.fromEntries(cols.map(c => [c.key, wire(st, c)])) });
  } catch (err) { run = { status: "error", error: err.error || String(err) }; }
  if (run.status === "ok") {
    delete st.ui.rowErrors[row.key];
    const lens = Object.fromEntries(cols.map(c => [c.key, c.instructions.length]));
    S.run_costs[run.id] = { cost_usd: run.cost_usd, input_tokens: run.input_tokens, questions: lens };
    for (const [qid, answer] of Object.entries(run.answers)) {
      ((S.cells[row.key] ??= {})[qid] ??= {})[run.model_used] = { answer, run_id: run.id };
    }
    if (!S.models.includes(run.model_used)) S.models.unshift(run.model_used);
  } else st.ui.rowErrors[row.key] = { error: run.error, columns: req.columns };
  S.running.done++;
  drawGrids();
}

// ---------- grid ----------
function cellText(st, x) {
  const e = st.exp;
  if (st.def.view.overlay === "cost") {
    const rc = S.run_costs[x.runId];
    return [h("span", { class: "v" }, rc ? fmtUSD(rc.cost_usd) : "?"), h("span", { class: "muted tiny" }, rc?.input_tokens != null ? `${rc.input_tokens} tok` : "")];
  }
  const extra = e.type === "choice" && !x.won ? h("span", { class: "alt", title: `Jev chose ${x.choice}` }, `↯${x.choice}`)
    : e.type === "score" ? h("span", { class: "muted tiny lvl", title: levelText(e.criteria[x.level]) }, `“${levelText(e.criteria[x.level])}”`) : null;
  return [h("span", { class: "v" }, fmtProb(x.v)), h("span", { class: `tag tag-${x.band}`, role: "img", "aria-label": `band ${x.band}` }, TAG[x.band]), missMark(x.miss), extra];
}

const missMark = miss => miss && h("span", { class: "x", title: "Disagrees with the label", role: "img", "aria-label": "misclassified" }, "✕");

function labelOptions(st) {
  const e = st.exp;
  const opts = e.type === "noul" ? [["yes", "yes"], ["no", "no"]]
    : e.type === "choice" ? Object.keys(e.criteria || {}).map(k => [k, k])
    : (e.criteria || []).map((l, i) => { const t = levelText(l); return [String(i), `${i} · ${t.length > 28 ? t.slice(0, 27) + "…" : t}`]; });
  return [["", "—"], ...opts];
}

function labelCell(st, r) {
  return h("td", {}, h("select", { class: "lbl", "data-label": r.key, "aria-label": `label for ${r.input}`,
    onchange: ev => {
      const val = ev.target.value;
      setLabel(st, r.key, val === "" ? null : st.def.type === "score" ? Number(val) : val);
      drawAll(); saveViewSoon();  // drawAll: the toolbar's misclassified filter appears with the first label
      stepEl(st)?.querySelector(`select[data-label="${CSS.escape(r.key)}"]`)?.focus();
    } }, labelOptions(st).map(([val, text]) => h("option", { value: val, selected: String(r.label ?? "") === val }, text))));
}

const pct = x => (x == null ? "—" : `${Math.round(x * 100)}%`);

function useThreshold(st, t) {
  stored(st).view.threshold = { low: t, high: t };
  drawAll(); saveViewSoon();
}

// Footer label metrics for one column (c) or the composite (m, best).
function accText(st, m) {
  if (!m) return "—";
  return st.exp.type === "score" ? `${pct(m.accuracy)} (${m.n})` : `${pct(m.accuracy)} (${m.n}) · ${pct(m.reviewRate)}`;
}
function confText(m) { return m ? `${m.tp}/${m.tn}/${m.fp}/${m.fn}/${m.review}` : "—"; }
function calText(st, m, best) {
  if (!m) return "—";
  if (st.exp.type === "score") return `${m.mae.toFixed(2)} lv`;
  return [`${best.t.toFixed(2)} · ${m.brier.toFixed(2)} `,
          h("button", { class: "link small", type: "button", title: `Set the threshold to ${best.t.toFixed(2)} (${pct(best.accuracy)} accuracy)`,
                        onclick: () => useThreshold(st, best.t) }, "use")];  // exact: rounding can flip rows that sit within 0.01
}

function cellTd(st, rowKey, colKey, x, errorInfo) {
  const s = st.ui.selected, sel = s && s.row === rowKey && s.col === colKey;
  const open = () => { st.ui.selected = { row: rowKey, col: colKey }; drawPanel(st); markSelected(st); };
  const attrs = { tabindex: -1, "data-cell": `${rowKey}|${colKey}`, class: "cell" + (sel ? " is-sel" : ""), onclick: open };
  if (x) return h("td", { ...attrs, class: attrs.class + (x.miss ? " miss" : ""), style: st.def.view.overlay === "cost" ? "" : `--v:${x.v}` }, cellText(st, x));
  if (errorInfo) return h("td", { ...attrs, class: attrs.class + " failed", title: errorInfo.error, "aria-label": "failed: " + errorInfo.error }, "!");
  return h("td", { ...attrs, class: attrs.class + " empty", title: "not run yet", "aria-label": "not run yet" }, "·");
}

// One tab stop per grid (roving tabindex); arrows move between cells, Enter opens the panel.
const STEP = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] };
function rovingGrid(table, focusKey) {
  const cells = table ? [...table.querySelectorAll("td[data-cell]")] : [];
  if (!cells.length) return;
  const start = cells.find(c => c.dataset.cell === focusKey) || table.querySelector("td.is-sel[data-cell]") || cells[0];
  start.tabIndex = 0;
  if (focusKey && start.dataset.cell === focusKey) start.focus();
  table.addEventListener("focusin", ev => {
    const td = ev.target.closest("td[data-cell]"); if (!td) return;
    for (const c of table.querySelectorAll('td[data-cell][tabindex="0"]')) c.tabIndex = -1;
    td.tabIndex = 0;
  });
  table.addEventListener("keydown", ev => {
    const td = ev.target.closest("td[data-cell]"); if (!td) return;
    if (ev.key === "Enter") { ev.preventDefault(); return td.click(); }
    const step = STEP[ev.key]; if (!step) return;
    ev.preventDefault();
    let tr = td.parentElement, i = td.cellIndex, next = null;
    if (step[1]) {
      next = tr.cells[i + step[1]];
      while (next && !next.dataset.cell) next = tr.cells[next.cellIndex + step[1]];
    } else {
      for (tr = step[0] < 0 ? tr.previousElementSibling : tr.nextElementSibling; tr && !next;
           tr = step[0] < 0 ? tr.previousElementSibling : tr.nextElementSibling)
        if (tr.cells[i]?.dataset.cell) next = tr.cells[i];
    }
    next?.focus();
  });
}

function markSelected(st) {
  const el = stepEl(st);
  if (!el) return;
  for (const c of el.querySelectorAll("td.is-sel")) c.classList.remove("is-sel");
  const s = st.ui.selected && el.querySelector(`td[data-cell="${CSS.escape(st.ui.selected.row + "|" + st.ui.selected.col)}"]`);
  if (s) s.classList.add("is-sel");
}

function colHeader(st, c) {
  const v = st.def.view, col = c.col;
  const w = v.weights_override?.[col.key] ?? col.weight ?? 1;
  const answered = Object.values(S.cells).some(r => r[col.key]);
  const thr = col.threshold;
  const setColThr = t => saveStep(st, { columns: st.def.columns.map(x => (x.key === col.key ? { ...x, threshold: t } : x)) });
  return h("th", { scope: "col", class: "colh" },
    h("div", { class: "row tight" },
      h("strong", {}, vname(c.key)), c.model && v.model === "compare" && h("span", { class: "muted tiny" }, c.model),
      h("label", { class: "tiny muted" }, "w", h("input", { type: "number", min: 0, max: 5, step: 0.5, value: w, class: "w",
        "aria-label": `weight of ${vname(c.key)}`,
        onchange: ev => { v.weights_override = { ...(v.weights_override || {}), [col.key]: Math.min(5, Math.max(0, Number(ev.target.value) || 0)) }; changed(); } })),
      h("details", { class: "menu" }, h("summary", { "aria-label": `${vname(c.key)} options` }, "⋯"),
        h("div", { class: "menu-body stack" },
          h("div", { class: "small" }, "Own threshold ",
            h("input", { type: "number", step: 0.01, min: 0, max: 1, value: thr?.low ?? "", placeholder: "low", style: "width:4.5em",
                         onchange: ev => setColThr({ low: Number(ev.target.value), high: thr?.high ?? v.threshold.high }) }),
            h("input", { type: "number", step: 0.01, min: 0, max: 1, value: thr?.high ?? "", placeholder: "high", style: "width:4.5em",
                         onchange: ev => setColThr({ low: thr?.low ?? v.threshold.low, high: Number(ev.target.value) }) }),
            thr && h("button", { class: "link", type: "button", onclick: () => setColThr(null) }, "clear")),
          h("button", { type: "button", onclick: () => saveStep(st, { columns: st.def.columns.map(x => (x.key === col.key ? { ...x, hidden: true } : x)) }) }, "Hide"),
          h("button", { type: "button", onclick: () => {
            st.ui.newCol = typeof col.instructions === "string" ? col.instructions : JSON.stringify(col.instructions);
            st.ui.hideAfter = answered ? col.key : null;
            if (st.i === 0) S.openSetup = true; else st.ui.openSetup = true;
            drawAll(); root.querySelector(`#new-col${CSS.escape(sfx(st))}`)?.focus();
          } }, "Duplicate & edit"),
          !answered && h("button", { type: "button", onclick: () => saveStep(st, { columns: st.def.columns.filter(x => x.key !== col.key) }) }, "Remove")))),
    h("div", { class: "wording", title: String(col.instructions) }, String(col.instructions)),
    thr && h("div", { class: "tiny muted" }, `own threshold ${thr.low} / ${thr.high}`),
    v.overlay === "cost" && h("div", { class: "tiny muted" }, `≈ ${fmtUSD(st.ui.lastResult.cost[c.key])} share`));
}

// ---------- matrix export: the current applyView result, so what you see is what you export ----------
const safeName = s => s.replace(/[\\/:*?"<>|]+/g, "-").trim() || "matrix";

function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  const a = h("a", { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportMatrix(st) {
  const res = st.ui.lastResult;
  if (!res) return;
  const step = multi() ? `-step${st.i + 1}` : "";
  download(`${safeName(S.exp.name)}${step}-${safeName(st.ui.viewName || "current")}.csv`, matrixCsv(res, st.exp, st.def.view.model === "compare"));
}

function drawGrids() {
  if (!root || !S) return;
  S.chain = chain(S.exp, S.cells, S.models);
  for (const st of stepCtxs()) drawGrid(st);
  root.querySelector("#exp-summary")?.replaceChildren(summary());
  drawFunnel();
}

function drawGrid(st) {
  const el = stepEl(st);
  if (!el) return;
  if (multi() && st.def.view.collapsed) { el.querySelector(".step-counts")?.replaceChildren(countsText(st)); return; }
  const e = st.exp, v = st.def.view;
  const result = applyView(e, S.cells, S.run_costs, v, S.models);
  st.ui.lastResult = result;
  el.querySelector(".step-counts")?.replaceChildren(countsText(st));
  el.querySelector(".runbar-slot")?.replaceChildren(runBar(st));
  const wrap = el.querySelector(".grid-wrap");
  if (!wrap) return;
  if (!e.rows.length || !result.columns.length) {
    const msg = st.i > 0 && !st.arrived.length && result.columns.length ? `No rows have passed step ${st.i} yet.`
      : st.i > 0 ? "Add at least one variant in this step's Setup to see its matrix."
      : "Add inputs and at least one variant in Setup to see the matrix.";
    wrap.replaceChildren(h("p", { class: "muted panel" }, msg));
    return drawPanel(st);
  }
  const focusKey = wrap.contains(document.activeElement) ? document.activeElement.dataset.cell : null;  // keep focus across live redraws
  wrap.replaceChildren(v.pivot ? pivotTable(st, result) : mainTable(st, result));
  rovingGrid(wrap.querySelector("table.grid"), focusKey);
  drawPanel(st);
}

function mainTable(st, result) {
  const e = st.exp, gate = multi();
  const showComp = result.columns.length >= 2, labels = hasLabels(st);
  const rows = result.rows.slice(0, st.ui.limit);
  // fn(stats, metrics, best) per column; the composite gets the same with its own numbers
  const statRow = (title, fn, attrs = {}) => h("tr", attrs, h("th", { scope: "row" }, title),
    result.columns.map(c => h("td", { class: "num" }, fn(c.stats, c.metrics, c.best))),
    showComp && h("td", { class: "num" }, fn(result.compositeStats, result.compositeMetrics, result.compositeBest)),
    h("td", {}), h("td", {}), gate && h("td", {}));
  const mean = s => (s.mean == null ? "—" : fmtProb(s.mean));
  const table = h("table", { class: "grid", "aria-label": gate ? `Results matrix, step ${st.i + 1}` : "Results matrix" },
    h("thead", {}, h("tr", {},
      h("th", { scope: "col", class: "inputh" }, `input (${result.rows.length} of ${e.rows.length})`),
      result.columns.map(c => colHeader(st, c)),
      showComp && h("th", { scope: "col" }, "composite"),
      h("th", { scope: "col" }, "spread"),
      h("th", { scope: "col" }, "label"),
      gate && h("th", { scope: "col", title: "Whether the row goes on to the next step (or passes the chain, on the last step)" }, "gate"))),
    h("tbody", {}, rows.map(r => {
      const err = st.ui.rowErrors[r.key];
      return h("tr", {},
        h("th", { scope: "row", class: "inputc" },
          h("span", { class: "inp", title: r.input }, rowLabel(r)),
          err && h("button", { class: "link small", type: "button", title: err.error,
            onclick: () => runRequests(st, [{ row: r.key, columns: err.columns }]) }, "Retry"),
          st.i === 0 && h("button", { class: "link tiny rm", type: "button", "aria-label": `Remove input ${r.input}`,
            onclick: () => saveDoc({ rows: S.exp.rows.filter(x => x.key !== r.key) }) }, "✕")),
        result.columns.map(c => cellTd(st, r.key, c.key, r.values[c.key], err && err.columns.includes(c.col.key) ? err : null)),
        showComp && h("td", { class: "cell comp" + (r.compositeMiss ? " miss" : ""), style: r.composite == null ? "" : `--v:${r.composite}` },
          r.composite == null ? "—" : [h("span", { class: "v" }, fmtProb(r.composite)),
                                       h("span", { class: `tag tag-${r.compositeBand}` }, TAG[r.compositeBand]), missMark(r.compositeMiss)]),
        h("td", { class: "num" }, r.spread == null ? "—" : r.spread.toFixed(2)),
        labelCell(st, r),
        gate && gateCell(st, r.key));
    })),
    h("tfoot", {},
      statRow("mean", mean),
      statRow("yes / review / no", s => `${s.yes}/${s.review}/${s.no}`),
      labels && statRow(e.type === "score" ? "acc (n)" : "acc (n) · review", (s, m) => accText(st, m)),
      labels && e.type !== "score" && statRow(h("abbr", { title: "correct yes / correct no / false yes / false no / in review" },
                                                "✓y/✓n/✗y/✗n/rev"), (s, m) => confText(m)),
      labels && statRow(e.type === "score" ? "MAE (levels)" : "best thr · Brier", (s, m, b) => calText(st, m, b)),
      result.columns.length >= 2 && h("tr", {}, h("th", { scope: "row" }, "agreement"),
        h("td", { colspan: result.columns.length + 3 + (showComp ? 1 : 0) + (gate ? 1 : 0), class: "muted small" },
          result.agreement == null ? "—" : `${fmtProb(result.agreement)} of rows have every variant in the same band`))));
  const more = result.rows.length > st.ui.limit && h("button", { type: "button", onclick: () => { st.ui.limit += 200; drawGrid(st); } },
    `Show more (${result.rows.length - st.ui.limit} hidden)`);
  return h("div", { class: "grid-scroll" }, table, more);
}

function pivotTable(st, result) {
  const p = transpose(result);
  const rows = p.columns.slice(0, st.ui.limit);
  return h("div", { class: "grid-scroll" }, h("table", { class: "grid", "aria-label": multi() ? `Results matrix, pivoted, step ${st.i + 1}` : "Results matrix, pivoted" },
    h("thead", {}, h("tr", {}, h("th", { scope: "col", class: "inputh" }, "variant"),
      rows.map(c => h("th", { scope: "col", class: "colh" }, h("div", { class: "wording", title: c.row.input }, rowLabel(c.row)))),
      h("th", { scope: "col" }, "mean"), h("th", { scope: "col" }, "yes / review / no"))),
    h("tbody", {}, p.rows.map(r => h("tr", {},
      h("th", { scope: "row", class: "inputc" }, h("strong", {}, vname(r.key)), " ", h("span", { class: "inp", title: String(r.col.col.instructions) }, String(r.col.col.instructions))),
      rows.map(c => cellTd(st, c.key, r.col.key, r.values[c.key])),
      h("td", { class: "num" }, r.col.stats.mean == null ? "—" : fmtProb(r.col.stats.mean)),
      h("td", { class: "num" }, `${r.col.stats.yes}/${r.col.stats.review}/${r.col.stats.no}`))))));
}

function drawPanel(st) {
  const panel = stepEl(st)?.querySelector(".cell-panel");
  if (!panel) return;
  const s = st.ui.selected, res = st.ui.lastResult;
  const r = s && res?.rows.find(x => x.key === s.row);
  const x = r?.values[s.col];
  const col = s && res?.columns.find(c => c.key === s.col);
  if (!s || !r || !col) { panel.replaceChildren(h("p", { class: "muted small" }, "Click a cell (or focus it and press Enter) to see the full answer.")); return; }
  const err = st.ui.rowErrors[s.row];
  const rc = x && S.run_costs[x.runId];
  panel.replaceChildren(h("div", { class: "panel stack" },
    h("div", { class: "row" }, h("strong", {}, `${vname(col.key)} × input`), h("span", { style: "flex:1" }),
      h("button", { class: "link", type: "button", onclick: () => { st.ui.selected = null; drawPanel(st); markSelected(st); } }, "Close")),
    h("p", { class: "small", style: "margin:0" }, r.input),
    x ? renderAnswer(vname(col.key), wire(st, col.col), x.answer)
      : h("p", { class: "muted" }, err ? `Failed: ${err.error}` : "Not run yet for this model."),
    x && h("p", { class: "meta" }, [`run #${x.runId}`, x.model, rc?.input_tokens != null ? `${rc.input_tokens} tok` : "tokens unknown",
      `request cost ${fmtUSD(rc?.cost_usd)}`].join(" · ")),
    x && h("a", { href: `#/history?ids=${x.runId}`, class: "small" }, "Open in History")));
}

registerView("experiments", (view, rest) => (rest[0] && /^\d+$/.test(rest[0]) ? renderExperiment(view, Number(rest[0])) : renderList(view)));
