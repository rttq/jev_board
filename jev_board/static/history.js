// History view: every saved run, filterable; detail with note/tags, delete, "Open in editor"; export.
import { h, api, app, registerView, fmtUSD, renderResult, confirmDialog, openInEditor, refreshTotals, TYPE_LABEL } from "./app.js";

const PAGE = 50;
const H = { filters: {}, offset: 0, selected: new Set(), current: null, page: null, exps: null };
let root = null;

const query = extra => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...H.filters, ...extra })) if (v !== "" && v != null) p.set(k, v);
  return p.toString();
};
const inputText = inp => (inp.kind === "json" ? JSON.stringify(inp.fields) : inp.text);
const types = run => [...new Set(Object.values(run.questions).map(q => TYPE_LABEL[q.type] || q.type))].join(", ");

async function load() {
  try { H.page = await api("GET", "/api/runs?" + query({ limit: PAGE, offset: H.offset })); H.error = null; }
  catch (err) { H.page = { total: 0, runs: [] }; H.error = err.error; }
  drawList(); drawDetail();
}

function setFilter(k, v) { H.filters = { ...H.filters, [k]: v }; if (k !== "ids") delete H.filters.ids; H.offset = 0; load(); }

function filterBar() {
  const f = H.filters;
  const sel = (k, label, opts) => h("label", { class: "row small" }, label, h("select", { onchange: ev => setFilter(k, ev.target.value) },
    [["", "any"], ...opts].map(([v, t]) => h("option", { value: v, selected: String(f[k] ?? "") === String(v) }, t))));
  let timer = null;
  const text = (k, attrs) => h("input", { ...attrs, value: f[k] || "",
    oninput: ev => { clearTimeout(timer); const v = ev.target.value; timer = setTimeout(() => setFilter(k, v), 300); } });
  const date = (k, label) => h("label", { class: "row small" }, label,
    h("input", { type: "date", value: f[k] || "", onchange: ev => setFilter(k, ev.target.value) }));
  return h("section", { class: "panel toolbar", "aria-label": "History filters" },
    h("div", { class: "row" },
      sel("type", "Type", Object.entries(TYPE_LABEL)),
      sel("model", "Model", app.status.models.map(m => [m, m])),
      sel("status", "Status", [["ok", "ok"], ["error", "error"]]),
      sel("experiment_id", "Experiment", (H.exps || []).map(e => [String(e.id), e.name])),
      text("tag", { placeholder: "tag", "aria-label": "Tag", style: "width:8em" }),
      text("q", { type: "search", placeholder: "search input, questions, note", "aria-label": "Search", style: "min-width:16em" })),
    h("div", { class: "row" },
      date("from", "From"), date("to", "to"),
      h("span", { style: "flex:1" }),
      h("button", { class: "link", type: "button", onclick: () => { H.filters = {}; H.offset = 0; draw(); load(); } }, "Clear filters")));
}

function drawList() {
  const wrap = root?.querySelector("#hist-list");
  if (!wrap) return;
  const { total, runs } = H.page;
  const pageIds = runs.map(r => r.id);
  const allOnPage = pageIds.length > 0 && pageIds.every(id => H.selected.has(id));
  const toggle = (id, on) => { on ? H.selected.add(id) : H.selected.delete(id); drawList(); };
  const exportBtn = fmt => h("button", { type: "button", disabled: !total && !H.selected.size, onclick: () => {
    const a = h("a", { href: `/api/export?${H.selected.size ? query({ format: fmt, ids: [...H.selected].join(",") }) : query({ format: fmt })}` });
    document.body.append(a); a.click(); a.remove();
  } }, `Export ${fmt.toUpperCase()}`);
  const scope = H.selected.size ? `${H.selected.size} selected` : `all ${total} matching`;
  wrap.replaceChildren(h("div", {},  // h() drops false/null children; replaceChildren would print them
    H.filters.ids && h("p", { class: "hint" }, `Showing run${H.filters.ids.includes(",") ? "s" : ""} #${H.filters.ids.split(",").join(", #")}. `,
      h("button", { class: "link", type: "button", onclick: () => setFilter("ids", "") }, "Show all runs")),
    H.error && h("p", { class: "err-text", role: "alert" }, H.error),
    h("div", { class: "row" }, h("strong", {}, `${total} run${total === 1 ? "" : "s"}`),
      total > PAGE && h("span", { class: "muted small" }, `${H.offset + 1}–${Math.min(total, H.offset + PAGE)}`),
      total > PAGE && h("button", { type: "button", disabled: H.offset === 0, onclick: () => { H.offset -= PAGE; load(); } }, "‹ Newer"),
      total > PAGE && h("button", { type: "button", disabled: H.offset + PAGE >= total, onclick: () => { H.offset += PAGE; load(); } }, "Older ›"),
      h("span", { style: "flex:1" }),
      h("button", { type: "button", disabled: !total && !H.selected.size, title: "Build an experiment from these runs' answers. No requests are sent.",
                    onclick: openAsMatrix }, `Open ${H.selected.size ? "selected" : "these"} as matrix`),
      h("span", { class: "muted small" }, `Export ${scope}:`), exportBtn("csv"), exportBtn("jsonl"),
      H.selected.size > 0 && h("button", { class: "link", type: "button", onclick: () => { H.selected.clear(); drawList(); } }, "Clear selection")),
    runs.length ? h("div", { class: "hist-scroll" }, h("table", { class: "list hist" },
      h("thead", {}, h("tr", {},
        h("th", {}, h("input", { type: "checkbox", checked: allOnPage, "aria-label": "Select all on this page",
          onchange: ev => { for (const id of pageIds) ev.target.checked ? H.selected.add(id) : H.selected.delete(id); drawList(); } })),
        ["#", "when", "type", "model", "input", "cost", "tags"].map(t => h("th", { scope: "col" }, t)))),
      h("tbody", {}, runs.map(r => h("tr", { class: (r.id === H.current ? "is-sel " : "") + (r.status === "error" ? "is-err" : ""), tabindex: 0,
          onclick: ev => { if (ev.target.type !== "checkbox") { H.current = r.id; drawList(); drawDetail(); } },
          onkeydown: ev => { if (ev.key === "Enter") { H.current = r.id; drawList(); drawDetail(); } } },
        h("td", {}, h("input", { type: "checkbox", checked: H.selected.has(r.id), "aria-label": `Select run ${r.id}`,
                                 onchange: ev => toggle(r.id, ev.target.checked) })),
        h("td", { class: "num" }, r.id),
        h("td", { class: "small nowrap" }, new Date(r.created_at).toLocaleString()),
        h("td", { class: "small" }, types(r)),
        h("td", { class: "small nowrap" }, r.model_used || r.model_requested),
        h("td", { class: "inp-cell" }, r.status === "error" && h("span", { class: "tag tag-no" }, "ERROR"), " ", inputText(r.input)),
        h("td", { class: "num small" }, r.status === "error" ? "—" : fmtUSD(r.cost_usd)),
        h("td", { class: "small" }, r.tags.join(", ")))))))
    : h("p", { class: "muted panel" }, Object.keys(H.filters).length ? "No runs match these filters." : "No runs yet. Make one in Run or Experiments.")));
}

// History → matrix: rows = distinct inputs, columns = distinct wordings of one type. Cells fill from saved answers.
async function openAsMatrix() {
  const scope = H.selected.size ? { run_ids: [...H.selected] } : { filter: H.filters };
  const q = H.selected.size ? query({ ids: [...H.selected].join(","), status: "ok", limit: 500 }) : query({ status: "ok", limit: 500 });
  const { runs } = await api("GET", "/api/runs?" + q);  // ponytail: counts from the first 500; the server uses all
  const counts = {};
  for (const r of runs) for (const qq of Object.values(r.questions)) if (qq.type !== "box") counts[qq.type] = (counts[qq.type] || 0) + 1;
  const dlg = document.getElementById("dlg");
  const typesHere = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  if (!typesHere.length) {
    dlg.replaceChildren(h("h1", {}, "Nothing to build"), h("p", {}, "These runs have no successful Noul, Choice or Score answers."),
      h("div", { class: "actions" }, h("span", { style: "flex:1" }), h("button", { type: "button", onclick: () => dlg.close() }, "Close")));
    return dlg.showModal();
  }
  const name = h("input", { value: `From history ${new Date().toLocaleString()}`, "aria-label": "Experiment name", style: "width:100%" });
  const type = h("select", { "aria-label": "Question type" },
    typesHere.map(t => h("option", { value: t }, `${TYPE_LABEL[t]} (${counts[t]} question${counts[t] === 1 ? "" : "s"})`)));
  const err = h("p", { class: "err-text", role: "alert" });
  dlg.replaceChildren(h("h1", {}, "Open as matrix"),
    h("p", { class: "small muted" }, "Rows are the distinct inputs. Columns are the distinct wordings of one type that share the same criteria. ",
      "Cells come from answers you already have; nothing is sent to Jev."),
    h("label", { class: "small" }, "Name"), name,
    h("label", { class: "small", style: "display:block;margin-top:8px" }, "Type"), type, err,
    h("div", { class: "actions" }, h("span", { style: "flex:1" }),
      h("button", { type: "button", onclick: () => dlg.close() }, "Cancel"),
      h("button", { type: "button", class: "primary", onclick: async () => {
        try {
          const out = await api("POST", "/api/experiments/from-runs", { name: name.value, type: type.value, ...scope });
          app.flash = out.warnings;  // shown once by the experiment page
          dlg.close(); location.hash = `#/experiments/${out.experiment.id}`;
        } catch (e) { err.textContent = e.error; }
      } }, "Create")));
  dlg.showModal();
}

function drawDetail() {
  const panel = root?.querySelector("#hist-detail");
  if (!panel) return;
  const run = H.page?.runs.find(r => r.id === H.current);
  if (!run) { panel.replaceChildren(h("p", { class: "muted small" }, "Click a run to see it in full.")); return; }
  const note = h("textarea", { rows: 2, value: run.note || "", "aria-label": "Note" });
  const tags = h("input", { value: run.tags.join(", "), "aria-label": "Tags, comma-separated", placeholder: "tags, comma-separated" });
  const msg = h("span", { class: "muted small", role: "status" });
  panel.replaceChildren(h("div", { class: "panel stack" },
    h("div", { class: "row" }, h("strong", {}, `Run #${run.id}`), h("span", { class: "muted small" }, new Date(run.created_at).toLocaleString()),
      h("span", { style: "flex:1" }),
      h("button", { class: "link", type: "button", onclick: () => { H.current = null; drawList(); drawDetail(); } }, "Close")),
    h("p", { class: "small prewrap", style: "margin:0" }, inputText(run.input)),
    run.image_sha && h("img", { class: "thumb", src: `/api/images/${run.image_sha}`, alt: `Image sent with run ${run.id}` }),
    run.experiment_id && h("a", { class: "small", href: `#/experiments/${run.experiment_id}` }, "Open its experiment"),
    renderResult(run),
    h("label", { class: "small" }, "Note"), note,
    h("label", { class: "small" }, "Tags"), tags,
    h("div", { class: "row" },
      h("button", { type: "button", onclick: async () => {
        try {
          const upd = await api("PATCH", `/api/runs/${run.id}`, { note: note.value, tags: tags.value });
          Object.assign(run, upd); msg.textContent = "Saved."; drawList();
        } catch (err) { msg.textContent = err.error; }
      } }, "Save note & tags"), msg),
    h("div", { class: "row" },
      h("button", { type: "button", onclick: () => openInEditor(run) }, "Open in editor"),
      h("span", { style: "flex:1" }),
      h("button", { type: "button", class: "danger", onclick: async () => {
        if (!(await confirmDialog("Delete run?", `Run #${run.id} and its answers will be removed. Matrix cells it filled become empty.`, "Delete"))) return;
        await api("DELETE", `/api/runs/${run.id}`);
        H.selected.delete(run.id); H.current = null; refreshTotals(); load();
      } }, "Delete"))));
}

function draw() {
  root.replaceChildren(
    h("div", { class: "row summary" }, h("h1", { style: "margin:0" }, "History"),
      h("span", { class: "muted" }, "Every request is saved here, including failed ones.")),
    filterBar(),
    h("div", { class: "dash-layout" }, h("div", { id: "hist-list" }), h("aside", { id: "hist-detail", "aria-label": "Run details" })));
}

async function renderHistory(view) {
  root = view;
  const ids = new URLSearchParams(location.hash.split("?")[1] || "").get("ids");
  if (ids) { H.filters = { ids }; H.offset = 0; H.current = Number(ids.split(",")[0]); }
  else if (H.filters.ids) { H.filters = {}; H.offset = 0; }  // the nav link means "all runs"; other filters are kept
  H.exps = await api("GET", "/api/experiments").catch(() => []);  // fresh each visit: experiments come and go
  H.page = { total: 0, runs: [] };
  draw();
  await load();
}

registerView("history", renderHistory);
