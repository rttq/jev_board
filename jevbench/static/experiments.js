// Experiments: list, setup, and the matrix dashboard. Live controls re-render from applyView with no fetch.
import { h, api, app, registerView, fmtProb, fmtUSD, choiceEditor, levelsEditor, renderAnswer, TYPE_LABEL } from "./app.js";
import { applyView, transpose } from "./metrics.js";

const DEFAULT_VIEW = {
  threshold: { low: 0.5, high: 0.8 }, focus_option: null, sort: { by: "input", dir: "asc" },
  filters: { labeled: null, misclassified: false, review_only: false, spread_min: null, tags: [], text: "" },
  pivot: false, overlay: "value", model: null, weights_override: null,
};
const clone = x => JSON.parse(JSON.stringify(x));
const vname = key => key.replace(/^c/, "v").replace(/@.*/, "");
const TAG = { yes: "YES", review: "REV", no: "NO" };

function confirmDialog(title, body, ok = "Confirm") {
  const dlg = document.getElementById("dlg");
  return new Promise(resolve => {
    const done = v => { dlg.close(); resolve(v); };
    dlg.replaceChildren(h("h1", {}, title), h("p", {}, body),
      h("div", { class: "actions" }, h("span", { style: "flex:1" }),
        h("button", { type: "button", onclick: () => done(false) }, "Cancel"),
        h("button", { type: "button", class: "primary", onclick: () => done(true) }, ok)));
    dlg.onclose = () => resolve(false);
    dlg.showModal();
  });
}

// ---------- list ----------
async function renderList(view) {
  const list = await api("GET", "/api/experiments");
  const create = async () => {
    const names = new Set(list.map(e => e.name));
    let n = list.length + 1; while (names.has(`Experiment ${n}`)) n++;
    const out = await api("POST", "/api/experiments", { name: `Experiment ${n}`, type: "noul", criteria: null, rows: [], columns: [] });
    location.hash = `#/experiments/${out.experiment.id}`;
  };
  view.append(h("div", { class: "row" }, h("h1", { style: "margin:0" }, "Experiments"), h("span", { style: "flex:1" }),
    h("button", { type: "button", class: "primary", onclick: create }, "New experiment")));
  if (!list.length) {
    view.append(h("p", { class: "muted" }, "An experiment is a matrix: inputs as rows, wordings of one question as columns. ",
      "Create one to compare wordings across many inputs."));
    return;
  }
  view.append(h("table", { class: "list" },
    h("thead", {}, h("tr", {}, ["Name", "Type", "Size", "Cost", "Updated", ""].map(t => h("th", {}, t)))),
    h("tbody", {}, list.map(e => h("tr", {},
      h("td", {}, h("a", { href: `#/experiments/${e.id}` }, e.name)),
      h("td", {}, TYPE_LABEL[e.type]),
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
let S = null;

async function load(id) {
  const d = await api("GET", `/api/experiments/${id}`);
  S = { id, exp: d.experiment, cells: d.cells, run_costs: d.run_costs, models: d.models, cost: d.cost,
        rowErrors: {}, running: null, runModel: app.prefs.default_model, plan: null, selected: null, limit: 200,
        setupErr: null, setupMsg: d.warnings?.join(" ") || null, newRows: "", newCol: "", hideAfter: null };
  S.exp.view = { ...clone(DEFAULT_VIEW), ...S.exp.view };
  S.crit = critToEditor(S.exp.type, S.exp.criteria);
}

async function refreshCells() {
  const d = await api("GET", `/api/experiments/${S.id}`);
  Object.assign(S, { cells: d.cells, run_costs: d.run_costs, models: d.models, cost: d.cost });
  await refreshPlan();
}

async function refreshPlan() {
  try { S.plan = await api("GET", `/api/experiments/${S.id}/plan?model=${encodeURIComponent(S.runModel)}`); }
  catch { S.plan = null; }
}

const hasAnswers = () => Object.keys(S.cells).length > 0;

function critToEditor(type, c) {
  if (type === "choice") return Object.entries(c || { "": null, " ": null }).map(([key, desc]) => ({ key: key.trim(), desc: desc || "" }));
  if (type === "score") return [...(c || ["", ""])];
  return { yes: c?.true || "", no: c?.false || "" };
}

function critFromEditor(type, e) {
  if (type === "choice") return Object.fromEntries(e.filter(o => o.key.trim()).map(o => [o.key.trim(), o.desc.trim() || null]));
  if (type === "score") return e.map(l => l.trim());
  const c = {};
  if (e.yes.trim()) c.true = e.yes.trim();
  if (e.no.trim()) c.false = e.no.trim();
  return Object.keys(c).length ? c : null;
}

function wire(col) {
  const q = { type: S.exp.type, instructions: col.instructions };
  if (S.exp.criteria != null) q.criteria = S.exp.criteria;
  return q;
}

// Structural save: PUT then reload everything from the server's answer.
async function saveDoc(patch) {
  S.setupErr = null;
  try {
    const d = await api("PUT", `/api/experiments/${S.id}`, { ...S.exp, ...patch });
    Object.assign(S, { exp: { ...d.experiment, view: S.exp.view }, cells: d.cells, run_costs: d.run_costs, models: d.models, cost: d.cost });
    S.setupMsg = d.warnings?.join(" ") || null;
    S.crit = critToEditor(S.exp.type, S.exp.criteria);
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

function changed() { drawGrid(); saveViewSoon(); }

// ---------- page ----------
let root = null;

async function renderExperiment(view, id) {
  root = view;
  try { await load(id); } catch (err) { view.append(h("div", { class: "result error" }, err.error || String(err))); return; }
  await refreshPlan();
  drawAll();
  view.onkeydown = e => { if (e.ctrlKey && e.key === "Enter") { e.preventDefault(); runMissing(); } };
}

function drawAll() {
  if (!root || !S) return;
  root.replaceChildren(
    h("div", { id: "exp-summary" }),
    setupPanel(),
    toolbar(),
    h("div", { class: "dash-layout" }, h("div", { id: "grid-wrap" }), h("aside", { id: "cell-panel", "aria-label": "Cell details" })));
  drawGrid();
}

function summary(result) {
  const e = S.exp, visible = e.columns.filter(c => !c.hidden).length;
  const parts = [TYPE_LABEL[e.type], `${e.rows.length} rows × ${visible} variants`, result.model || "no answers yet",
                 `${fmtUSD(S.cost.cost_usd)} spent here`];
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

async function importFile(file) {
  const text = await file.text();
  let rows;
  if (/\.csv$/i.test(file.name)) {
    const [head, ...rest] = parseCSV(text);
    const idx = n => head.findIndex(x => x.trim().toLowerCase() === n);
    const [ii, li, ti] = [idx("input"), idx("label"), idx("tags")];
    if (ii < 0) { S.setupErr = "The CSV needs an `input` column (optional: label, tags)."; return drawAll(); }
    rows = rest.map(r => ({ input: r[ii], label: li >= 0 ? labelFrom(r[li]) : null,
                            tags: ti >= 0 ? (r[ti] || "").split(/[;|]/) : [] }));
  } else rows = text.split(/\r?\n/).filter(l => l.trim()).map(l => ({ input: l }));
  await saveDoc({ rows: [...S.exp.rows, ...rows] });
}

function setupPanel() {
  const e = S.exp, locked = hasAnswers();
  const typeSel = h("select", { "aria-label": "Experiment type", disabled: locked,
    onchange: ev => { S.crit = critToEditor(ev.target.value, null); S.pendingType = ev.target.value; drawAll(); } },
    ["noul", "choice", "score"].map(t => h("option", { value: t, selected: (S.pendingType || e.type) === t }, TYPE_LABEL[t])));
  const type = S.pendingType || e.type;
  const noop = () => {}, redraw = () => drawAll();
  let crit;
  if (type === "choice") crit = choiceEditor(S.crit, noop, redraw);
  else if (type === "score") crit = levelsEditor(S.crit, noop, redraw);
  else crit = h("div", {},
    h("p", { class: "muted small" }, "Optional: what counts as yes / no (shared by every variant)."),
    h("div", { class: "crit-row" }, h("input", { value: S.crit.yes, placeholder: "Yes means…", "aria-label": "what counts as yes",
      oninput: ev => { S.crit.yes = ev.target.value; } })),
    h("div", { class: "crit-row" }, h("input", { value: S.crit.no, placeholder: "No means…", "aria-label": "what counts as no",
      oninput: ev => { S.crit.no = ev.target.value; } })));
  const name = h("input", { value: e.name, "aria-label": "Experiment name", style: "min-width:16em" });
  const file = h("input", { type: "file", accept: ".txt,.csv,text/plain,text/csv", hidden: true,
                            onchange: ev => ev.target.files[0] && importFile(ev.target.files[0]) });
  const ref = e.rows[0]?.input.kind === "json" ? "`field`" : "`text`";
  const refBox = h("textarea", { id: "exp-ref", rows: 3, value: e.reference || "",
                                 placeholder: "e.g. a passage from a book or doc the inputs are judged against" });
  return h("details", { class: "panel setup", open: !e.rows.length || !e.columns.length || !!S.setupErr || S.openSetup,
                        ontoggle: ev => { S.openSetup = ev.target.open; } },
    h("summary", {}, h("strong", {}, "Setup"), h("span", { class: "muted small" }, " · name, type, shared criteria, inputs, variants")),
    h("div", { class: "setup-grid" },
      h("section", { class: "stack" },
        h("h2", {}, "Question"),
        h("div", { class: "row" }, name, typeSel),
        h("fieldset", { disabled: locked, class: "plain" }, crit),
        locked && h("p", { class: "muted small" }, "Type and criteria are fixed once answers exist (they are part of every cell's identity). ",
          h("button", { class: "link", type: "button", onclick: async () => {
            const out = await api("POST", `/api/experiments/${S.id}/duplicate`); location.hash = `#/experiments/${out.experiment.id}`;
          } }, "Duplicate to change")),
        h("label", { class: "small", for: "exp-ref" }, "Shared reference (optional)"),
        refBox,
        h("p", { class: "muted tiny" }, "Sent with every input as `reference`; point wordings at it. Changing it starts fresh cells."),
        h("button", { type: "button", onclick: () => {
          const patch = { name: name.value, reference: refBox.value };
          if (!locked) { patch.type = type; patch.criteria = critFromEditor(type, S.crit); }
          S.pendingType = null; saveDoc(patch);
        } }, "Save question")),
      h("section", { class: "stack" },
        h("h2", {}, "Add inputs"),
        h("textarea", { rows: 4, value: S.newRows, "aria-label": "New inputs, one per line",
                        placeholder: "One input per line", oninput: ev => { S.newRows = ev.target.value; } }),
        h("div", { class: "row" },
          h("button", { type: "button", onclick: async () => {
            const lines = S.newRows.split(/\r?\n/).filter(l => l.trim());
            if (lines.length && await saveDoc({ rows: [...e.rows, ...lines.map(l => ({ input: l }))] })) { S.newRows = ""; drawAll(); }
          } }, "Add inputs"),
          file, h("button", { type: "button", onclick: () => file.click() }, "Import .txt / .csv"),
          h("span", { class: "muted small" }, "CSV columns: input, label, tags"))),
      h("section", { class: "stack" },
        h("h2", {}, "Add variant"),
        h("textarea", { id: "new-col", rows: 3, value: S.newCol, "aria-label": "New variant wording",
                        placeholder: `A wording of the question, e.g. Does ${ref} describe an apple?`,
                        oninput: ev => { S.newCol = ev.target.value; } }),
        h("div", { class: "row" },
          h("button", { type: "button", onclick: async () => {
            if (!S.newCol.trim()) return;
            const cols = e.columns.map(c => (c.key === S.hideAfter ? { ...c, hidden: true } : c));
            if (await saveDoc({ columns: [...cols, { instructions: S.newCol.trim() }] })) { S.newCol = ""; S.hideAfter = null; drawAll(); }
          } }, "+ variant"),
          S.hideAfter && h("label", { class: "small" }, h("input", { type: "checkbox", checked: true,
            onchange: ev => { if (!ev.target.checked) S.hideAfter = null; } }), ` hide ${vname(S.hideAfter)} after adding`)))),
    S.setupErr && h("p", { class: "err-text", role: "alert" }, S.setupErr),
    S.setupMsg && h("p", { class: "hint" }, S.setupMsg));
}

// ---------- toolbar ----------
function toolbar() {
  const v = S.exp.view, e = S.exp;
  const num = (val, attrs, on) => h("input", { type: "number", step: "any", min: 0, max: 1, value: val, style: "width:5em", ...attrs,
                                              onchange: ev => on(Number(ev.target.value)) });
  const setT = (which, x) => {
    x = Math.min(1, Math.max(0, x));
    const t = v.threshold;
    if (which === "low") t.low = Math.min(x, t.high - 0.01); else t.high = Math.max(x, t.low + 0.01);
    t.low = +t.low.toFixed(2); t.high = +t.high.toFixed(2);
    for (const el of root.querySelectorAll("[data-t]")) el.value = t[el.dataset.t];
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
  const savedNames = Object.keys(e.views || {});
  const hidden = e.columns.filter(c => c.hidden);

  return h("section", { class: "panel toolbar", "aria-label": "Analysis controls" },
    h("div", { class: "row" },
      h("strong", { class: "small" }, "Threshold"), h("span", { class: "muted small" }, "no"),
      range("low"), num(v.threshold.low, { "data-t": "low", "aria-label": "low threshold value" }, x => setT("low", x)),
      range("high"), num(v.threshold.high, { "data-t": "high", "aria-label": "high threshold value" }, x => setT("high", x)),
      h("span", { class: "muted small" }, "yes"),
      h("span", { style: "flex:1" }),
      seg([["value", "Values"], ["cost", "Cost"]], v.overlay, x => { v.overlay = x; drawAll(); saveViewSoon(); }),
      h("button", { type: "button", "aria-pressed": String(!!v.pivot), onclick: () => { v.pivot = !v.pivot; drawAll(); saveViewSoon(); } }, "Pivot")),
    h("div", { class: "row" },
      sel("Sort", v.sort.by, sortOpts, x => { v.sort.by = x; changed(); }),
      h("button", { type: "button", "aria-label": "sort direction", onclick: ev => {
        v.sort.dir = v.sort.dir === "asc" ? "desc" : "asc"; ev.target.textContent = v.sort.dir; changed(); } }, v.sort.dir),
      sel("Show", v.filters.labeled ?? "", [["", "all rows"], ["labeled", "labeled"], ["unlabeled", "unlabeled"]],
          x => { v.filters.labeled = x || null; changed(); }),
      (hasLabels() || v.filters.misclassified) && h("label", { class: "row small" }, h("input", { type: "checkbox", checked: !!v.filters.misclassified,
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
          onclick: () => saveDoc({ columns: e.columns.map(x => (x.key === c.key ? { ...x, hidden: false } : x)) }) }, `${vname(c.key)} ↺`))),
      h("span", { style: "flex:1" }),
      sel("View", S.viewName || "", [["", "current"], ...savedNames.map(n => [n, n])], x => {
        S.viewName = x || null;
        if (x) { e.view = { ...clone(DEFAULT_VIEW), ...clone(e.views[x]) }; drawAll(); saveViewSoon(); }
      }),
      h("button", { type: "button", onclick: () => {
        const n = prompt("Save the current view as:", S.viewName || "");
        if (n && n.trim()) { e.views = { ...e.views, [n.trim()]: clone(v) }; S.viewName = n.trim(); drawAll(); saveViewSoon(); }
      } }, "Save view…"),
      S.viewName && h("button", { class: "link", type: "button", onclick: () => {
        const n = prompt("Rename view:", S.viewName);
        if (n && n.trim() && n.trim() !== S.viewName) {
          const views = { ...e.views, [n.trim()]: e.views[S.viewName] }; delete views[S.viewName];
          e.views = views; S.viewName = n.trim(); drawAll(); saveViewSoon();
        }
      } }, "Rename"),
      S.viewName && h("button", { class: "link", type: "button", onclick: () => {
        const views = { ...e.views }; delete views[S.viewName]; e.views = views; S.viewName = null; drawAll(); saveViewSoon();
      } }, "Delete view"),
      h("button", { class: "link", type: "button", onclick: () => { e.view = clone(DEFAULT_VIEW); S.viewName = null; drawAll(); saveViewSoon(); } }, "Reset view")),
    runBar());
}

function runBar() {
  const n = S.plan?.requests.length ?? 0;
  const reason = !app.status.key_present ? "No API key. See the banner above."
    : !S.exp.rows.length || !S.exp.columns.some(c => !c.hidden) ? "Add inputs and at least one variant in Setup."
    : S.running ? `Running… ${S.running.done}/${S.running.total}` : n === 0 ? "Every visible cell has an answer for this model." : null;
  return h("div", { class: "row runbar" },
    h("label", { class: "row small" }, "Run with",
      h("select", { "aria-label": "Model to run", onchange: async ev => { S.runModel = ev.target.value; await refreshPlan(); drawAll(); } },
        app.status.models.map(m => h("option", { value: m, selected: m === S.runModel }, m)))),
    h("button", { type: "button", class: "primary", disabled: !!reason, title: reason || "Ctrl+Enter", onclick: runMissing },
      `Run missing (${n})`),
    reason && h("span", { class: "reason small muted", "aria-live": "polite" }, reason));
}

// ---------- runner ----------
async function runMissing() {
  if (S.running) return;
  await refreshPlan();
  const p = S.plan;
  if (!p || !p.requests.length) return drawAll();
  const cells = p.requests.reduce((a, r) => a + r.columns.length, 0);
  const ok = await confirmDialog("Run missing cells?",
    `${p.requests.length} requests (one per input) for ${cells} cells on ${p.model} · ≈ ${p.estimated_tokens} tokens · ≈ ${fmtUSD(p.estimated_cost_usd)}`, "Run");
  if (!ok) return;
  await runRequests(p.requests);
}

async function runRequests(requests) {
  S.running = { done: 0, total: requests.length };
  drawAll();
  const queue = [...requests];
  const worker = async () => { while (queue.length) await runRow(queue.shift()); };
  await Promise.all(Array.from({ length: Math.min(app.prefs.concurrency, requests.length) }, worker));
  S.running = null;
  await refreshCells();
  drawAll();
}

async function runRow(req) {
  const row = S.exp.rows.find(r => r.key === req.row);
  const cols = req.columns.map(k => S.exp.columns.find(c => c.key === k)).filter(Boolean);
  let run;
  try {
    run = await api("POST", "/api/runs", { input: row.input, model: S.runModel, experiment_id: S.id,
                                          questions: Object.fromEntries(cols.map(c => [c.key, wire(c)])) });
  } catch (err) { run = { status: "error", error: err.error || String(err) }; }
  if (run.status === "ok") {
    delete S.rowErrors[row.key];
    const lens = Object.fromEntries(cols.map(c => [c.key, c.instructions.length]));
    S.run_costs[run.id] = { cost_usd: run.cost_usd, input_tokens: run.input_tokens, questions: lens };
    for (const [qid, answer] of Object.entries(run.answers)) {
      ((S.cells[row.key] ??= {})[qid] ??= {})[run.model_used] = { answer, run_id: run.id };
    }
    if (!S.models.includes(run.model_used)) S.models.unshift(run.model_used);
  } else S.rowErrors[row.key] = { error: run.error, columns: req.columns };
  S.running.done++;
  const status = root.querySelector(".runbar .reason");
  if (status) status.textContent = `Running… ${S.running.done}/${S.running.total}`;
  drawGrid();
}

// ---------- grid ----------
function cellText(x, rv) {
  if (S.exp.view.overlay === "cost") {
    const rc = S.run_costs[x.runId];
    return [h("span", { class: "v" }, rc ? fmtUSD(rc.cost_usd) : "?"), h("span", { class: "muted tiny" }, rc?.input_tokens != null ? `${rc.input_tokens} tok` : "")];
  }
  const extra = S.exp.type === "choice" && !x.won ? h("span", { class: "alt", title: `Jev chose ${x.choice}` }, `↯${x.choice}`)
    : S.exp.type === "score" ? h("span", { class: "muted tiny lvl", title: S.exp.criteria[x.level] }, `“${S.exp.criteria[x.level]}”`) : null;
  return [h("span", { class: "v" }, fmtProb(x.v)), h("span", { class: `tag tag-${x.band}` }, TAG[x.band]), missMark(x.miss), extra];
}

const missMark = miss => miss && h("span", { class: "x", title: "Disagrees with the label", "aria-label": "misclassified" }, "✕");
const hasLabels = () => S.exp.rows.some(r => r.label != null);

function labelOptions() {
  const e = S.exp;
  const opts = e.type === "noul" ? [["yes", "yes"], ["no", "no"]]
    : e.type === "choice" ? Object.keys(e.criteria || {}).map(k => [k, k])
    : (e.criteria || []).map((l, i) => [String(i), `${i} · ${l.length > 28 ? l.slice(0, 27) + "…" : l}`]);
  return [["", "—"], ...opts];
}

function labelCell(r) {
  return h("td", {}, h("select", { class: "lbl", "data-label": r.key, "aria-label": `label for ${r.input}`,
    onchange: ev => {
      const row = S.exp.rows.find(x => x.key === r.key), val = ev.target.value;
      row.label = val === "" ? null : S.exp.type === "score" ? Number(val) : val;
      drawAll(); saveViewSoon();  // drawAll: the toolbar's misclassified filter appears with the first label
      root.querySelector(`select[data-label="${CSS.escape(r.key)}"]`)?.focus();
    } }, labelOptions().map(([val, text]) => h("option", { value: val, selected: String(r.label ?? "") === val }, text))));
}

const pct = x => (x == null ? "—" : `${Math.round(x * 100)}%`);

function useThreshold(t) {
  S.exp.view.threshold = { low: t, high: t };
  drawAll(); saveViewSoon();
}

// Footer label metrics for one column (c) or the composite (m, best).
function accText(m) {
  if (!m) return "—";
  return S.exp.type === "score" ? `${pct(m.accuracy)} (${m.n})` : `${pct(m.accuracy)} (${m.n}) · ${pct(m.reviewRate)}`;
}
function confText(m) { return m ? `${m.tp}/${m.tn}/${m.fp}/${m.fn}/${m.review}` : "—"; }
function calText(m, best) {
  if (!m) return "—";
  if (S.exp.type === "score") return `${m.mae.toFixed(2)} lv`;
  return [`${best.t.toFixed(2)} · ${m.brier.toFixed(2)} `,
          h("button", { class: "link small", type: "button", title: `Set the threshold to ${best.t.toFixed(2)} (${pct(best.accuracy)} accuracy)`,
                        onclick: () => useThreshold(best.t) }, "use")];  // exact: rounding can flip rows that sit within 0.01
}

function cellTd(rowKey, colKey, x, errorInfo) {
  const sel = S.selected && S.selected.row === rowKey && S.selected.col === colKey;
  const open = () => { S.selected = { row: rowKey, col: colKey }; drawPanel(); markSelected(); };
  const attrs = { tabindex: 0, "data-cell": `${rowKey}|${colKey}`, class: "cell" + (sel ? " is-sel" : ""),
                  onclick: open, onkeydown: ev => { if (ev.key === "Enter") open(); } };
  if (x) return h("td", { ...attrs, class: attrs.class + (x.miss ? " miss" : ""), style: S.exp.view.overlay === "cost" ? "" : `--v:${x.v}` }, cellText(x));
  if (errorInfo) return h("td", { ...attrs, class: attrs.class + " failed", title: errorInfo.error, "aria-label": "failed: " + errorInfo.error }, "!");
  return h("td", { ...attrs, class: attrs.class + " empty", title: "not run yet" }, "·");
}

function markSelected() {
  for (const el of root.querySelectorAll("td.is-sel")) el.classList.remove("is-sel");
  const s = S.selected && root.querySelector(`td[data-cell="${CSS.escape(S.selected.row + "|" + S.selected.col)}"]`);
  if (s) s.classList.add("is-sel");
}

function colHeader(c) {
  const v = S.exp.view, col = c.col;
  const w = v.weights_override?.[col.key] ?? col.weight ?? 1;
  const answered = Object.values(S.cells).some(r => r[col.key]);
  const thr = col.threshold;
  const setColThr = t => saveDoc({ columns: S.exp.columns.map(x => (x.key === col.key ? { ...x, threshold: t } : x)) });
  return h("th", { scope: "col", class: "colh" },
    h("div", { class: "row tight" },
      h("strong", {}, vname(c.key)), c.model && S.exp.view.model === "compare" && h("span", { class: "muted tiny" }, c.model),
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
          h("button", { type: "button", onclick: () => saveDoc({ columns: S.exp.columns.map(x => (x.key === col.key ? { ...x, hidden: true } : x)) }) }, "Hide"),
          h("button", { type: "button", onclick: () => {
            S.newCol = typeof col.instructions === "string" ? col.instructions : JSON.stringify(col.instructions);
            S.hideAfter = answered ? col.key : null; S.openSetup = true; drawAll(); root.querySelector("#new-col")?.focus();
          } }, "Duplicate & edit"),
          !answered && h("button", { type: "button", onclick: () => saveDoc({ columns: S.exp.columns.filter(x => x.key !== col.key) }) }, "Remove")))),
    h("div", { class: "wording", title: String(col.instructions) }, String(col.instructions)),
    thr && h("div", { class: "tiny muted" }, `own threshold ${thr.low} / ${thr.high}`),
    v.overlay === "cost" && h("div", { class: "tiny muted" }, `≈ ${fmtUSD(lastResult.cost[c.key])} share`));
}

let lastResult = null;

function drawGrid() {
  if (!root || !S) return;
  const e = S.exp, v = e.view;
  const result = applyView(e, S.cells, S.run_costs, v, S.models);
  lastResult = result;
  root.querySelector("#exp-summary")?.replaceChildren(summary(result));
  const wrap = root.querySelector("#grid-wrap");
  if (!wrap) return;
  if (!e.rows.length || !result.columns.length) {
    wrap.replaceChildren(h("p", { class: "muted panel" }, "Add inputs and at least one variant in Setup to see the matrix."));
    return drawPanel();
  }
  wrap.replaceChildren(v.pivot ? pivotTable(result) : mainTable(result));
  drawPanel();
}

function mainTable(result) {
  const e = S.exp, v = e.view;
  const showComp = result.columns.length >= 2, labels = hasLabels();
  const rows = result.rows.slice(0, S.limit);
  // fn(stats, metrics, best) per column; the composite gets the same with its own numbers
  const statRow = (title, fn, attrs = {}) => h("tr", attrs, h("th", { scope: "row" }, title),
    result.columns.map(c => h("td", { class: "num" }, fn(c.stats, c.metrics, c.best))),
    showComp && h("td", { class: "num" }, fn(result.compositeStats, result.compositeMetrics, result.compositeBest)),
    h("td", {}), h("td", {}));
  const mean = s => (s.mean == null ? "—" : fmtProb(s.mean));
  const table = h("table", { class: "grid", "aria-label": "Results matrix" },
    h("thead", {}, h("tr", {},
      h("th", { scope: "col", class: "inputh" }, `input (${result.rows.length} of ${e.rows.length})`),
      result.columns.map(colHeader),
      showComp && h("th", { scope: "col" }, "composite"),
      h("th", { scope: "col" }, "spread"),
      h("th", { scope: "col" }, "label"))),
    h("tbody", {}, rows.map(r => {
      const err = S.rowErrors[r.key];
      return h("tr", {},
        h("th", { scope: "row", class: "inputc" },
          h("span", { class: "inp", title: r.input }, r.input),
          err && h("button", { class: "link small", type: "button", title: err.error,
            onclick: () => runRequests([{ row: r.key, columns: err.columns }]) }, "Retry"),
          h("button", { class: "link tiny rm", type: "button", "aria-label": `Remove input ${r.input}`,
            onclick: () => saveDoc({ rows: e.rows.filter(x => x.key !== r.key) }) }, "✕")),
        result.columns.map(c => cellTd(r.key, c.key, r.values[c.key], err && err.columns.includes(c.col.key) ? err : null)),
        showComp && h("td", { class: "cell comp" + (r.compositeMiss ? " miss" : ""), style: r.composite == null ? "" : `--v:${r.composite}` },
          r.composite == null ? "—" : [h("span", { class: "v" }, fmtProb(r.composite)),
                                       h("span", { class: `tag tag-${r.compositeBand}` }, TAG[r.compositeBand]), missMark(r.compositeMiss)]),
        h("td", { class: "num" }, r.spread == null ? "—" : r.spread.toFixed(2)),
        labelCell(r));
    })),
    h("tfoot", {},
      statRow("mean", mean),
      statRow("yes / review / no", s => `${s.yes}/${s.review}/${s.no}`),
      labels && statRow(e.type === "score" ? "acc (n)" : "acc (n) · review", (s, m) => accText(m)),
      labels && e.type !== "score" && statRow(h("abbr", { title: "correct yes / correct no / false yes / false no / in review" },
                                                "✓y/✓n/✗y/✗n/rev"), (s, m) => confText(m)),
      labels && statRow(e.type === "score" ? "MAE (levels)" : "best thr · Brier", (s, m, b) => calText(m, b)),
      result.columns.length >= 2 && h("tr", {}, h("th", { scope: "row" }, "agreement"),
        h("td", { colspan: result.columns.length + 3 + (showComp ? 1 : 0), class: "muted small" },
          result.agreement == null ? "—" : `${fmtProb(result.agreement)} of rows have every variant in the same band`))));
  const more = result.rows.length > S.limit && h("button", { type: "button", onclick: () => { S.limit += 200; drawGrid(); } },
    `Show more (${result.rows.length - S.limit} hidden)`);
  return h("div", { class: "grid-scroll" }, table, more);
}

function pivotTable(result) {
  const p = transpose(result);
  const rows = p.columns.slice(0, S.limit);
  return h("div", { class: "grid-scroll" }, h("table", { class: "grid", "aria-label": "Results matrix, pivoted" },
    h("thead", {}, h("tr", {}, h("th", { scope: "col", class: "inputh" }, "variant"),
      rows.map(c => h("th", { scope: "col", class: "colh" }, h("div", { class: "wording", title: c.row.input }, c.row.input))),
      h("th", { scope: "col" }, "mean"), h("th", { scope: "col" }, "yes / review / no"))),
    h("tbody", {}, p.rows.map(r => h("tr", {},
      h("th", { scope: "row", class: "inputc" }, h("strong", {}, vname(r.key)), " ", h("span", { class: "inp", title: String(r.col.col.instructions) }, String(r.col.col.instructions))),
      rows.map(c => cellTd(c.key, r.col.key, r.values[c.key])),
      h("td", { class: "num" }, r.col.stats.mean == null ? "—" : fmtProb(r.col.stats.mean)),
      h("td", { class: "num" }, `${r.col.stats.yes}/${r.col.stats.review}/${r.col.stats.no}`))))));
}

function drawPanel() {
  const panel = root?.querySelector("#cell-panel");
  if (!panel) return;
  const s = S.selected;
  const r = s && lastResult?.rows.find(x => x.key === s.row);
  const x = r?.values[s.col];
  const col = s && lastResult?.columns.find(c => c.key === s.col);
  if (!s || !r || !col) { panel.replaceChildren(h("p", { class: "muted small" }, "Click a cell (or focus it and press Enter) to see the full answer.")); return; }
  const err = S.rowErrors[s.row];
  const rc = x && S.run_costs[x.runId];
  panel.replaceChildren(h("div", { class: "panel stack" },
    h("div", { class: "row" }, h("strong", {}, `${vname(col.key)} × input`), h("span", { style: "flex:1" }),
      h("button", { class: "link", type: "button", onclick: () => { S.selected = null; drawPanel(); markSelected(); } }, "Close")),
    h("p", { class: "small", style: "margin:0" }, r.input),
    x ? renderAnswer(vname(col.key), wire(col.col), x.answer)
      : h("p", { class: "muted" }, err ? `Failed: ${err.error}` : "Not run yet for this model."),
    x && h("p", { class: "meta" }, [`run #${x.runId}`, x.model, rc?.input_tokens != null ? `${rc.input_tokens} tok` : "tokens unknown",
      `request cost ${fmtUSD(rc?.cost_usd)}`].join(" · ")),
    x && h("a", { href: `#/history?ids=${x.runId}`, class: "small" }, "Open in History")));
}

registerView("experiments", (view, rest) => (rest[0] && /^\d+$/.test(rest[0]) ? renderExperiment(view, Number(rest[0])) : renderList(view)));
