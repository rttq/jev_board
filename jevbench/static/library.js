// JSON library picker: one modal dialog for input files and question files, used by the Run view and experiments.
// The server reads and checks every file (jevbench/library.py); this module only shows the analysis and hands it on.
import { h, api } from "./app.js";
import { recordSummary, matchQuestions } from "./metrics.js";

const KIND = { "run-input": "inputs", "exp-input": "inputs", "run-questions": "questions", "exp-questions": "questions" };
const TYPE_TAG = { noul: "NOUL", choice: "CHOICE", score: "SCORE", box: "BOX" };
const lastFile = {};  // place -> relative path, for this session only (FR-035)
const MAX_MATCHES = 200, COLLAPSE_OVER = 200, SAMPLE_CUT = 60;

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const fmtSize = n => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
// replaceChildren would print null/false as text; h() skips them, so do the same here.
const put = (el, ...kids) => el.replaceChildren(...kids.flat().filter(k => k != null && k !== false && k !== 0 && k !== ""));
const fileUrl = (kind, path) => `/api/library/${kind}/file?path=${encodeURIComponent(path)}`;

// place: run-input | run-questions | exp-input | exp-questions. onLoad(analysis, {index}) runs after the dialog closes.
// opts.exp: the experiment ({type, criteria, columns}) for exp-questions, to show what will be skipped.
export function openLibrary(place, onLoad, opts = {}) {
  const kind = KIND[place];
  const dlg = document.getElementById("lib");
  const opener = document.activeElement;
  const st = { files: null, folder: "", note: null, sel: lastFile[place] || null, an: null, anErr: null, loading: false,
               tab: null, rec: 0, recQuery: "", status: {}, showAll: new Set() };
  let seq = 0;

  const live = h("p", { class: "sr-only", "aria-live": "polite" });
  const announce = msg => { live.textContent = ""; setTimeout(() => { live.textContent = msg; }, 30); };
  const list = h("ul", { class: "lib-list", role: "listbox", tabindex: 0, "aria-label": kind === "inputs" ? "Input files" : "Question files",
                         onkeydown: listKeys });
  const preview = h("div", { class: "lib-preview" });
  const pathRow = h("div", { class: "row small lib-path-row" });
  const confirmBtn = h("button", { type: "button", class: "primary", onclick: confirm });
  const reasonEl = h("span", { class: "reason" });

  put(dlg, 
    h("div", { class: "row lib-head" },
      h("h1", { id: "lib-title", style: "margin:0" }, kind === "inputs" ? "Load JSON · inputs" : "Load questions"),
      h("span", { style: "flex:1" }),
      h("button", { type: "button", class: "link", "aria-label": "Close", onclick: () => dlg.close() }, "✕")),
    pathRow,
    h("div", { class: "lib-body" }, list, preview),
    live,
    h("div", { class: "actions" }, reasonEl, h("span", { style: "flex:1" }),
      h("button", { type: "button", onclick: () => dlg.close() }, "Cancel"), confirmBtn));
  // The opener may be re-rendered by onLoad; buttons with an id are found again by it.
  const refocus = () => (opener?.isConnected ? opener : opener?.id && document.getElementById(opener.id))?.focus?.();
  dlg.onclose = refocus;
  dlg.showModal();
  list.focus();
  loadList();

  // ---------- data ----------
  async function loadList() {
    try {
      const out = await api("GET", `/api/library/${kind}`);
      Object.assign(st, { files: out.files, folder: out.folder });
    } catch (err) { Object.assign(st, { files: [], note: err.error }); }
    if (st.sel && !st.files.some(f => f.path === st.sel)) Object.assign(st, { sel: null, an: null });
    drawPath(); drawList();
    if (st.sel) select(st.sel); else { drawPreview(); drawFooter(); }
  }

  async function select(path) {
    const my = ++seq;
    Object.assign(st, { sel: path, an: null, anErr: null, loading: true, rec: 0, recQuery: "", note: null });
    st.showAll.clear();
    drawList(); drawPreview(); drawFooter();
    try {
      const an = await api("GET", fileUrl(kind, path));
      if (my !== seq) return;  // the user moved on; the last request wins
      st.an = an;
      st.tab = kind === "inputs" ? (an.ok ? "structure" : "raw") : (an.ok ? "questions" : "raw");
      st.status[path] = an.ok ? "ok" : "invalid";
    } catch (err) {
      if (my !== seq) return;
      st.anErr = err.status === 404 ? "The file was removed. Refresh the list." : err.error;
    }
    st.loading = false;
    drawList(); drawPreview(); drawFooter();
  }

  async function confirm() {
    if (confirmBtn.disabled) return;
    confirmBtn.disabled = true;
    let fresh;
    try { fresh = await api("GET", fileUrl(kind, st.sel)); }  // re-read: use what is on disk now (FR-027)
    catch (err) {
      st.anErr = err.status === 404 ? "The file was removed. Refresh the list." : err.error;
      st.an = null; drawPreview(); drawFooter(); return;
    }
    if (fresh.mtime !== st.an.mtime || fresh.size !== st.an.size || fresh.pretty !== st.an.pretty) {
      const rec = st.rec;
      st.an = fresh; st.status[st.sel] = fresh.ok ? "ok" : "invalid";
      st.rec = Math.min(rec, (fresh.inputs?.records.length || 1) - 1);
      st.note = "The file changed on disk. This is its new content; confirm again to use it.";
      drawList(); drawPreview(); drawFooter(); return;
    }
    lastFile[place] = st.sel;
    const index = st.rec;
    dlg.close();
    await onLoad(fresh, { index });
    refocus();
  }

  // ---------- header ----------
  function drawPath() {
    put(pathRow, 
      h("code", { class: "lib-folder", title: st.folder }, st.folder),
      h("button", { type: "button", onclick: async () => {
        try { await api("POST", `/api/library/${kind}/reveal`); st.note = null; }
        catch (err) { st.note = err.error + ". Open the folder above by hand."; }
        drawPath();
      } }, "Open folder"),
      h("button", { type: "button", onclick: () => { st.note = null; loadList(); } }, "Refresh"),
      st.note && h("span", { class: "hint", role: "status" }, st.note));
  }

  // ---------- file list ----------
  function drawList() {
    if (!st.files) { put(list, h("li", { class: "muted" }, "Reading the folder…")); return; }
    if (!st.files.length) {
      put(list, h("li", { class: "muted lib-empty" }, "No JSON files in this folder yet. Put ",
        kind === "inputs" ? "input files (an object, or a list of objects)" : "question files ({\"id\": {type, instructions, criteria}})",
        " in the folder above, then Refresh."));
      list.removeAttribute("aria-activedescendant");
      return;
    }
    put(list, ...st.files.map((f, i) => {
      const id = `lib-opt-${i}`, on = f.path === st.sel;
      return h("li", { id, role: "option", "aria-selected": String(on), class: "lib-opt" + (on ? " on" : ""),
                       onclick: () => { list.focus(); if (f.path !== st.sel) select(f.path); } },
        h("span", { class: "lib-name" }, f.path),
        h("span", { class: "muted tiny" }, fmtSize(f.size)),
        f.too_large && h("span", { class: "tag tag-no" }, "TOO LARGE (limit 1 MB)"),
        !f.too_large && st.status[f.path] === "invalid" && h("span", { class: "tag tag-no" }, "INVALID"));
    }));
    const i = st.files.findIndex(f => f.path === st.sel);
    if (i >= 0) { list.setAttribute("aria-activedescendant", `lib-opt-${i}`); list.children[i].scrollIntoView({ block: "nearest" }); }
    else list.removeAttribute("aria-activedescendant");
  }

  function listKeys(e) {
    if (!st.files?.length) return;
    const i = st.files.findIndex(f => f.path === st.sel), n = st.files.length;
    const to = { ArrowDown: Math.min(i + 1, n - 1), ArrowUp: Math.max(i - 1, 0), Home: 0, End: n - 1 }[e.key];
    if (to !== undefined) { e.preventDefault(); if (to !== i) select(st.files[to].path); }
    else if (e.key === "Enter") { e.preventDefault(); confirm(); }
  }

  // ---------- preview ----------
  function drawPreview() {
    if (!st.sel) { put(preview, h("p", { class: "muted" }, "Select a file to see what it holds.")); return; }
    if (st.anErr) { put(preview, h("p", { class: "err-text", role: "alert" }, st.anErr)); return; }
    if (st.loading || !st.an) { put(preview, h("p", { class: "muted" }, "Reading ", st.sel, "…")); return; }
    const an = st.an;
    const tabs = an.ok ? [kind === "inputs" ? ["structure", "Structure"] : ["questions", "Questions"], ["raw", "Raw"]] : [];
    put(preview, 
      h("p", { class: "lib-summary" }, h("strong", {}, an.path), " · ", summary(an)),
      !an.ok && h("p", { class: "err-text", role: "alert" }, an.error.message,
        an.error.line != null && ` · line ${an.error.line}, column ${an.error.col}`),
      an.warnings.length > 0 && h("ul", { class: "lib-warn" }, an.warnings.map(w => h("li", {}, "⚠ ", w))),
      tabs.length > 0 && h("div", { class: "seg", role: "tablist", "aria-label": "Preview",
                                    onkeydown: e => {
                                      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
                                      st.tab = tabs[(tabs.findIndex(t => t[0] === st.tab) + 1) % tabs.length][0];
                                      drawPreview(); preview.querySelector('[role="tab"][aria-selected="true"]')?.focus();
                                    } },
        tabs.map(([k, label]) => h("button", { type: "button", role: "tab", "aria-selected": String(st.tab === k),
                                               "aria-pressed": String(st.tab === k), tabindex: st.tab === k ? 0 : -1,
                                               onclick: () => { st.tab = k; drawPreview(); } }, label))),
      an.ok && place === "run-input" && an.inputs.shape === "list" && recordPicker(an.inputs.records),
      an.ok && st.tab === "structure" && structure(an.inputs),
      an.ok && st.tab === "questions" && questionCards(an.questions),
      (st.tab === "raw" || !an.ok) && an.pretty != null && h("pre", { class: "lib-raw", tabindex: 0, "aria-label": "File content" }, an.pretty));
  }

  function summary(an) {
    if (!an.ok) return "cannot be loaded";
    if (an.inputs) {
      const n = an.inputs.records.length, top = an.inputs.fields.filter(d => !d.path.includes(".") && !d.path.includes("[]")).length;
      return `${an.inputs.shape} · ${plural(n, "record")} · ${plural(an.inputs.fields.length, "field")} (${top} top-level) · depth ${an.inputs.depth}`;
    }
    const qs = Object.values(an.questions), bad = qs.filter(q => !q.valid).length;
    return `${plural(qs.length, "question")}` + (bad ? ` · ${bad} invalid` : "");
  }

  function recordPicker(records) {
    const search = h("input", { type: "search", value: st.recQuery, placeholder: "Find by number or text", "aria-label": "Find a record" });
    const sel = h("select", { "aria-label": "Record to load", onchange: e => { st.rec = Number(e.target.value); drawFooter(); } });
    const note = h("span", { class: "muted tiny" });
    const fill = () => {
      const q = st.recQuery.trim().toLowerCase().replace(/^#/, "");
      const hits = [];
      for (let i = 0; i < records.length && hits.length < MAX_MATCHES; i++) {
        const s = recordSummary(records[i]);
        if (!q || String(i + 1) === q || s.toLowerCase().includes(q)) hits.push([i, s]);
      }
      if (hits.length && !hits.some(([i]) => i === st.rec)) st.rec = hits[0][0];
      put(sel, ...hits.map(([i, s]) => h("option", { value: i, selected: i === st.rec }, `#${i + 1} · ${s}`)));
      note.textContent = !hits.length ? "No record matches." : hits.length === MAX_MATCHES ? `Showing the first ${MAX_MATCHES}; refine the search.` : "";
      drawFooter();
    };
    search.oninput = e => { st.recQuery = e.target.value; fill(); };
    fill();
    return h("div", { class: "row lib-rec" }, h("span", { class: "small" }, "Record"), search, sel, note);
  }

  function structure(inp) {
    const N = inp.records.length, collapse = inp.fields.length > COLLAPSE_OVER;
    // nest descriptors (parent always comes before its children)
    const roots = [], stack = [];
    for (const d of inp.fields) {
      const node = { d, kids: [] };
      while (stack.length && !(d.path.startsWith(stack.at(-1).d.path + ".") || d.path.startsWith(stack.at(-1).d.path + "[]"))) stack.pop();
      (stack.length ? stack.at(-1).kids : roots).push(node);
      stack.push(node);
    }
    const row = (d, depth) => {
      const tail = depth ? d.path.slice(d.path.lastIndexOf(".") + 1) || d.path : d.path;
      return h("div", { class: "lib-field", style: `--depth:${depth}` },
        h("code", { class: "lib-key", title: d.path }, tail),
        h("span", { class: "muted small" }, typeText(d)),
        sample(d),
        h("span", { class: "tiny num" }, `${d.count}/${N}`, d.count < N && " ", d.count < N && h("span", { class: "tag tag-review" }, "PARTIAL")),
        h("button", { type: "button", class: "link", "aria-label": `Copy path ${d.path}`, title: `Copy ${d.path}`, onclick: ev => {
          ev.stopPropagation(); ev.preventDefault();
          navigator.clipboard.writeText(d.path).then(() => announce(`Copied ${d.path}`), () => announce("Copy failed. Select the path by hand."));
        } }, "⧉"));
    };
    const render = (node, depth) => node.kids.length
      ? h("details", { class: "lib-node", open: !collapse }, h("summary", {}, row(node.d, depth)), node.kids.map(k => render(k, depth + 1)))
      : row(node.d, depth);
    return h("div", { class: "lib-tree" },
      !inp.fields.length && h("p", { class: "muted" }, "No fields. Questions will have nothing to refer to."),
      collapse && h("p", { class: "muted tiny" }, `${inp.fields.length} fields: objects start collapsed.`),
      roots.map(n => render(n, 0)));
  }

  function typeText(d) {
    if (d.type === "list") return `list of ${d.items.type ?? "nothing"} (${d.items.n})`;
    if (d.type === "mixed") return `mixed: ${d.types.join(", ")}`;
    return d.type;
  }

  function sample(d) {
    if (!("sample" in d)) return h("span", {});
    const full = typeof d.sample === "string" ? JSON.stringify(d.sample) : String(d.sample);
    if (full.length <= SAMPLE_CUT || st.showAll.has(d.path)) return h("span", { class: "lib-sample prewrap" }, full);
    return h("span", { class: "lib-sample" }, full.slice(0, SAMPLE_CUT - 1) + "…", " ",
      h("button", { type: "button", class: "link tiny", onclick: ev => { ev.preventDefault(); st.showAll.add(d.path); drawPreview(); } }, "show all"));
  }

  function questionCards(qs) {
    const m = place === "exp-questions" && opts.exp ? matchQuestions(opts.exp, qs) : null;
    const skipped = new Map((m?.skipped || []).map(s => [s.id, s.reason]));
    return h("div", { class: "stack" },
      m && h("p", { class: "small" }, `${plural(m.columns.length, "variant")} will be added`,
        !opts.exp.columns.length && m.columns.length > 0 && ` (the experiment becomes ${m.type} with these criteria)`,
        skipped.size > 0 && `; ${skipped.size} will be skipped.`),
      Object.entries(qs).map(([id, q]) => h("div", { class: "panel lib-q" },
        h("div", { class: "row" }, h("code", {}, id), h("span", { class: "tag" }, TYPE_TAG[q.wire.type]),
          h("span", { class: "tag " + (q.valid ? "tag-yes" : "tag-no") }, q.valid ? "VALID" : "INVALID"),
          skipped.has(id) && h("span", { class: "tag tag-review" }, "WILL BE SKIPPED")),
        h("p", { class: "prewrap", style: "margin:6px 0" },
          typeof q.wire.instructions === "string" ? q.wire.instructions : JSON.stringify(q.wire.instructions, null, 2)),
        criteria(q.wire),
        q.errors.map(e => h("p", { class: "err-text small" }, e)),
        q.notes.map(n => h("p", { class: "muted small" }, n)),
        skipped.has(id) && h("p", { class: "hint" }, "Skipped: ", skipped.get(id)))));
  }

  function criteria(w) {
    const c = w.criteria;
    if (w.type === "choice" && c && typeof c === "object")
      return h("ul", { class: "small" }, Object.entries(c).map(([k, d]) => h("li", {}, h("strong", {}, k), d ? ` — ${d}` : "")));
    if (w.type === "score" && Array.isArray(c))
      return h("ol", { class: "small", start: 0 }, c.map(l => h("li", {}, typeof l === "string" ? l
        : h("code", { style: "white-space:pre-wrap" }, JSON.stringify(l, null, 2)))));
    if (w.type === "noul" && c)
      return h("ul", { class: "small" }, c.true && h("li", {}, "Yes means: ", c.true), c.false && h("li", {}, "No means: ", c.false));
    return null;
  }

  // ---------- footer ----------
  function drawFooter() {
    const an = st.an;
    let label = kind === "inputs" ? "Load" : "Load questions", reason = null;
    if (!st.sel) reason = "Select a file.";
    else if (st.anErr) reason = st.anErr;
    else if (!an) reason = "Reading…";
    else if (!an.ok) reason = "This file cannot be loaded: " + an.error.message;
    else if (place === "run-input") label = an.inputs.shape === "list" ? `Load record #${st.rec + 1}` : "Load";
    else if (place === "exp-input") label = an.inputs.records.length === 1 ? "Fill the form" : `Add ${plural(an.inputs.records.length, "row")}`;
    else if (place === "run-questions") label = `Load ${plural(Object.keys(an.questions).length, "question")}`;
    else {
      const k = opts.exp ? matchQuestions(opts.exp, an.questions).columns.length : 0;
      label = `Add ${plural(k, "variant")}`;
      if (!k) reason = "No question in this file fits this experiment.";
    }
    confirmBtn.textContent = label;
    confirmBtn.disabled = !!reason;
    confirmBtn.title = reason || "";
    reasonEl.textContent = reason && st.sel ? reason : "";
  }
}
