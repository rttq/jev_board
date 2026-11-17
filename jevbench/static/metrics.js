// Pure dashboard math (no DOM, no fetch). Everything the live controls change goes through applyView.

export function cellValue(answer, type, { focus, nLevels } = {}) {
  if (!answer) return null;
  if (type === "noul") return { v: answer.noul };
  if (type === "choice") return { v: answer.probabilities?.[focus] ?? 0, won: answer.choice === focus, choice: answer.choice };
  if (type === "score") {
    const n = nLevels ?? Object.keys(answer.legend || {}).length;
    return { v: n > 1 ? answer.score / (n - 1) : 0, level: Math.round(answer.score) };
  }
  return null;
}

export const band = (v, t) => (v >= t.high ? "yes" : v < t.low ? "no" : "review");

export function spread(values) {
  const xs = values.filter(x => x != null);
  return xs.length < 2 ? null : Math.max(...xs) - Math.min(...xs);
}

export function columnStats(values, t) {
  const xs = values.filter(x => x != null);
  const out = { n: xs.length, mean: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null, yes: 0, review: 0, no: 0 };
  for (const x of xs) out[band(x, t)]++;
  return out;
}

export function composite(values, weights) {
  let sw = 0, s = 0;
  values.forEach((v, i) => { if (v != null) { sw += weights[i]; s += weights[i] * v; } });
  return sw > 0 ? s / sw : null;
}

// Share of rows (with ≥ 2 values) whose visible values all fall in the same band.
export function agreement(rowBands) {
  const rows = rowBands.map(bs => bs.filter(Boolean)).filter(bs => bs.length >= 2);
  return rows.length ? rows.filter(bs => bs.every(b => b === bs[0])).length / rows.length : null;
}

// ---- labels (points = [{v, label}], v = cell value; for Score v = score / (N-1)) ----
const truthOf = (label, type, focus) => (type === "noul" ? label === "yes" : label === focus);
const labeled = points => points.filter(p => p.v != null && p.label != null);

// Noul/Choice: wrong only when decided (review is not a miss). Score: nearest level differs from the label.
export function isMiss(v, label, type, t, { focus, nLevels } = {}) {
  if (v == null || label == null) return false;
  if (type === "score") return Math.round(v * ((nLevels || 2) - 1)) !== label;
  const b = band(v, t);
  return b !== "review" && (b === "yes") !== truthOf(label, type, focus);
}

export function labelMetrics(points, type, t, { focus, nLevels } = {}) {
  const ps = labeled(points), n = ps.length;
  if (!n) return null;
  if (type === "score") {
    const k = (nLevels || 2) - 1;
    let ok = 0, err = 0;
    for (const p of ps) { ok += Math.round(p.v * k) === p.label; err += Math.abs(p.v * k - p.label); }
    return { n, accuracy: ok / n, mae: err / n };
  }
  const m = { n, tp: 0, tn: 0, fp: 0, fn: 0, review: 0 };
  let brier = 0;
  for (const p of ps) {
    const b = band(p.v, t), y = truthOf(p.label, type, focus);
    if (b === "review") m.review++; else m[b === "yes" ? (y ? "tp" : "fp") : (y ? "fn" : "tn")]++;
    brier += (p.v - y) ** 2;
  }
  const decided = n - m.review;
  return { ...m, accuracy: decided ? (m.tp + m.tn) / decided : null, reviewRate: m.review / n, brier: brier / n };
}

// The single cut t (low = high = t, v ≥ t is yes) with the best accuracy. Candidates: each value, plus 1 ("all no").
// Ties go to the t closest to 0.5. Sorted sweep, so O(n log n).
export function bestThreshold(points, type, { focus } = {}) {
  if (type === "score") return null;
  const ps = labeled(points).map(p => [p.v, truthOf(p.label, type, focus)]).sort((a, b) => a[0] - b[0]);
  const n = ps.length;
  if (!n) return null;
  const pos = ps.filter(p => p[1]).length;
  let best = null, posBelow = 0, negBelow = 0;
  const consider = t => {
    const acc = (negBelow + pos - posBelow) / n;
    if (!best || acc > best.accuracy + 1e-12 || (acc > best.accuracy - 1e-12 && Math.abs(t - 0.5) < Math.abs(best.t - 0.5)))
      best = { t, accuracy: acc };
  };
  ps.forEach(([v, y], i) => { if (i === 0 || v !== ps[i - 1][0]) consider(v); y ? posBelow++ : negBelow++; });
  if (ps[n - 1][0] < 1) consider(1);
  return best;
}

// ≈ cost of one column inside a request: run cost split by instruction length.
export function costShare(runCost, colKey) {
  if (!runCost || runCost.cost_usd == null) return null;
  const lens = runCost.questions || {};
  const total = Object.values(lens).reduce((a, b) => a + b, 0);
  return total ? runCost.cost_usd * (lens[colKey] || 0) / total : null;
}

export const inputText = inp => (inp.kind === "json" ? JSON.stringify(inp.fields) : inp.text);

export function defaultModel(models) { return models[0] ?? null; }

// exp: experiment doc; cells: {row: {col: {model: {answer, run_id}}}}; runCosts: {run_id: {...}}; view: View; models: [..]
export function applyView(exp, cells, runCosts, view, models = []) {
  const focus = view.focus_option ?? (exp.type === "choice" ? Object.keys(exp.criteria || {})[0] : undefined);
  const nLevels = exp.type === "score" ? (exp.criteria || []).length : undefined;
  const model = view.model ?? defaultModel(models);
  const groups = model === "compare" ? models : [model];
  const columns = [];
  for (const m of groups) for (const c of exp.columns) {
    if (c.hidden) continue;
    columns.push({ key: groups.length > 1 ? `${c.key}@${m}` : c.key, col: c, model: m,
                   t: c.threshold || view.threshold,
                   w: view.weights_override?.[c.key] ?? c.weight ?? 1 });
  }
  const f = view.filters || {};
  const text = (f.text || "").toLowerCase();
  const lo = { focus, nLevels };
  let rows = exp.rows.map(r => {
    const values = {}, label = r.label ?? null;
    for (const c of columns) {
      const cell = cells?.[r.key]?.[c.col.key]?.[c.model];
      const cv = cell && cellValue(cell.answer, exp.type, lo);
      values[c.key] = cv ? { ...cv, band: band(cv.v, c.t), miss: isMiss(cv.v, label, exp.type, c.t, lo),
                             runId: cell.run_id, answer: cell.answer, model: c.model } : null;
    }
    const vs = columns.map(c => values[c.key]?.v ?? null);
    const comp = composite(vs, columns.map(c => c.w));
    return { key: r.key, row: r, input: inputText(r.input), label, tags: r.tags || [], values,
             composite: comp, compositeBand: comp == null ? null : band(comp, view.threshold),
             compositeMiss: isMiss(comp, label, exp.type, view.threshold, lo), spread: spread(vs),
             runIds: [...new Set(Object.values(values).filter(Boolean).map(x => x.runId))] };
  });
  rows = rows.filter(r =>
    (f.labeled == null || (f.labeled === "labeled") === (r.label != null)) &&
    (!f.misclassified || r.compositeMiss || Object.values(r.values).some(x => x?.miss)) &&
    (!f.review_only || Object.values(r.values).some(x => x?.band === "review")) &&
    (f.spread_min == null || (r.spread != null && r.spread >= f.spread_min)) &&
    (!f.tags?.length || r.tags.some(t => f.tags.includes(t))) &&
    (!text || r.input.toLowerCase().includes(text)));
  const s = view.sort || { by: "input", dir: "asc" };
  const key = r => s.by === "composite" ? r.composite : s.by === "spread" ? r.spread : s.by === "label" ? r.label
    : s.by === "input" ? r.input.toLowerCase() : r.values[s.by]?.v ?? null;
  const dir = s.dir === "desc" ? -1 : 1;
  rows.sort((a, b) => {
    const x = key(a), y = key(b);
    if (x == null || y == null) return x == null && y == null ? 0 : x == null ? 1 : -1; // empties last either way
    return (x < y ? -1 : x > y ? 1 : 0) * dir;
  });
  for (const c of columns) {
    const pts = rows.map(r => ({ v: r.values[c.key]?.v ?? null, label: r.label }));
    c.stats = columnStats(pts.map(p => p.v), c.t);
    c.metrics = labelMetrics(pts, exp.type, c.t, lo);
    c.best = bestThreshold(pts, exp.type, lo);
  }
  const cpts = rows.map(r => ({ v: r.composite, label: r.label }));
  return {
    rows, columns, focus, model, nLevels,
    compositeStats: columnStats(rows.map(r => r.composite), view.threshold),
    compositeMetrics: labelMetrics(cpts, exp.type, view.threshold, lo),
    compositeBest: bestThreshold(cpts, exp.type, lo),
    agreement: agreement(rows.map(r => columns.map(c => r.values[c.key]?.band))),
    cost: Object.fromEntries(columns.map(c => [c.key, rows.reduce((a, r) => {
      const v = r.values[c.key]; const share = v && costShare(runCosts?.[v.runId], c.col.key);
      return share == null ? a : a + share;
    }, 0)])),
  };
}

// Pivot: variants become rows, inputs become columns. Same value objects, nothing recomputed.
export function transpose(result) {
  return {
    rows: result.columns.map(c => ({ key: c.key, col: c, values: Object.fromEntries(result.rows.map(r => [r.key, r.values[c.key]])) })),
    columns: result.rows.map(r => ({ key: r.key, row: r })),
  };
}

// Matrix CSV of an applyView result (what you see is what you export). BOM so Excel reads UTF-8.
const csvCell = x => { const s = x == null ? "" : String(x); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const num4 = v => (v == null ? "" : +v.toFixed(4));

const vname = key => key.replace(/^c/, "v").replace(/@.*/, "");
const wording = x => (typeof x === "string" ? x : JSON.stringify(x));

export function matrixCsv(result, exp, compare = false) {
  const cols = result.columns;
  const name = c => vname(c.key) + (compare ? "@" + c.model : "");
  const lines = [["input", "label", "tags", ...cols.map(c => `${name(c)}: ${String(c.col.instructions)}`), "composite", "spread"],
    ...result.rows.map(r => [r.input, r.label ?? "", r.tags.join(";"), ...cols.map(c => num4(r.values[c.key]?.v)), num4(r.composite), num4(r.spread)]),
    [], ["metric", "", "", ...cols.map(name), "composite", ""]];
  const stat = (label, f) => lines.push([label, "", "", ...cols.map(c => f(c.stats, c.metrics, c.best)),
                                         f(result.compositeStats, result.compositeMetrics, result.compositeBest), ""]);
  stat("mean", s => num4(s.mean)); stat("yes", s => s.yes); stat("review", s => s.review); stat("no", s => s.no);
  stat("n", (s, m) => m?.n ?? 0); stat("accuracy", (s, m) => num4(m?.accuracy));
  if (exp.type === "score") stat("mae_levels", (s, m) => num4(m?.mae));
  else { stat("review_rate", (s, m) => num4(m?.reviewRate)); stat("best_threshold", (s, m, b) => num4(b?.t)); stat("brier", (s, m) => num4(m?.brier)); }
  return "\ufeff" + lines.map(l => l.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

// ---------- experiment steps: rows walk down the chain through each step's gate ----------
// Step 1 is the experiment's top level; steps 2..N are exp.steps. View filters and sort never gate.

export function allSteps(exp) {
  return [{ key: "s0", index: 0, type: exp.type, criteria: exp.criteria, columns: exp.columns, view: exp.view, views: exp.views,
            labels: Object.fromEntries(exp.rows.map(r => [r.key, r.label ?? null])) },
          ...(exp.steps || []).map((s, i) => ({ ...s, index: i + 1 }))];
}

// Gate settings with defaults: Score passes from the middle level up, Choice passes the focus option.
export function gateFor(def) {
  const g = def.view?.gate || {};
  const n = def.type === "score" ? (def.criteria || []).length : 0;
  const first = def.type === "choice" ? Object.keys(def.criteria || {})[0] : undefined;
  return { minLevel: g.min_level ?? Math.ceil((n - 1) / 2),
           passOptions: g.pass_options ?? [def.view?.focus_option ?? first].filter(x => x != null),
           reviewPasses: !!g.review_passes };
}

// How likely one answer is to pass: P(yes), P(level ≥ min), or P(option in the passing set).
export function passLikelihood(answer, type, gate) {
  if (!answer) return null;
  if (type === "noul") return answer.noul ?? null;
  const p = answer.probabilities || {};
  if (type === "score") return Object.entries(p).reduce((a, [l, x]) => a + (Number(l) >= gate.minLevel ? x : 0), 0);
  if (type === "choice") return gate.passOptions.reduce((a, o) => a + (p[o] ?? 0), 0);
  return null;
}

// One result per step: which rows arrived, and each one's outcome (pass / stop / wait) with its pass likelihood.
export function chain(exp, cells, models = []) {
  const out = [];
  let arrived = exp.rows.map(r => r.key);
  for (const def of allSteps(exp)) {
    const v = def.view || {}, t = v.threshold || { low: 0.5, high: 0.8 }, g = gateFor(def);
    const model = v.model && v.model !== "compare" ? v.model : models[0];
    const cols = def.columns.filter(c => !c.hidden);
    const ws = cols.map(c => v.weights_override?.[c.key] ?? c.weight ?? 1);
    const outcome = {}, counts = { entered: arrived.length, passed: 0, stopped: 0, waiting: 0 }, next = [];
    for (const rk of arrived) {
      const ps = cols.map(c => passLikelihood(cells?.[rk]?.[c.key]?.[model]?.answer, def.type, g));
      const p = !cols.length || ps.some(x => x == null) ? null : composite(ps, ws);  // judged only when fully answered
      if (p == null) { outcome[rk] = { state: "wait", p: null, band: null }; counts.waiting++; continue; }
      const b = band(p, t), pass = b === "yes" || (b === "review" && g.reviewPasses);
      outcome[rk] = { state: pass ? "pass" : "stop", p, band: b };
      if (pass) { counts.passed++; next.push(rk); } else counts.stopped++;
    }
    out.push({ def, arrived, outcome, counts });
    arrived = next;
  }
  return out;
}

// The experiment as one step sees it: that step's question, only the arrived rows, that step's labels.
export function stepExp(exp, def, arrived) {
  const keep = new Set(arrived);
  return { ...exp, type: def.type, criteria: def.criteria, columns: def.columns, view: def.view, views: def.views,
           rows: exp.rows.filter(r => keep.has(r.key)).map(r => ({ ...r, label: def.labels[r.key] ?? null })) };
}

// Rows that could still reach step i: not stopped at any earlier step (waiting rows might pass once answered).
export function reachable(exp, results, i) {
  return exp.rows.filter(r => results.slice(0, i).every(res => res.outcome[r.key]?.state !== "stop")).map(r => r.key);
}

export const stepLabel = def => def.view?.step_name || `Step ${def.index + 1} · ${def.type[0].toUpperCase() + def.type.slice(1)}`;

// One line per input: its outcome and pass likelihood at every step ("did not reach" after it stopped or waited).
// Below the table: the visible variant wordings of every step (the ones its p is composed from).
export function chainCsv(exp, results) {
  const word = { pass: "passed", stop: "stopped", wait: "waiting" };
  const head = ["input", "tags", ...results.flatMap(r => [`${stepLabel(r.def)} outcome`, `${stepLabel(r.def)} p`])];
  const lines = exp.rows.map(row => [inputText(row.input), (row.tags || []).join(";"), ...results.flatMap(r => {
    const o = r.outcome[row.key];
    return o ? [word[o.state], num4(o.p)] : ["did not reach", ""];
  })]);
  lines.push([], ["step", "variant", "wording"],
    ...results.flatMap(r => r.def.columns.filter(c => !c.hidden).map(c => [stepLabel(r.def), vname(c.key), wording(c.instructions)])));
  return "﻿" + [head, ...lines].map(l => l.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

// Same shape as the server plan's `requests`: visible cells with no answer for `model`.
export function missingRequests(rowKeys, columns, cells, model) {
  const visible = columns.filter(c => !c.hidden);
  return rowKeys.map(row => ({ row, columns: visible.filter(c => !cells?.[row]?.[c.key]?.[model]).map(c => c.key) }))
    .filter(r => r.columns.length);
}

// ---------- JSON library helpers (pure) ----------

// One readable line for a JSON record: the first non-empty text found depth-first, with its key.
export function recordSummary(fields, max = 80) {
  const find = (v, key) => {
    if (typeof v === "string") return v.trim() ? [key, v] : null;
    if (Array.isArray(v)) { for (const x of v) { const r = find(x, key); if (r) return r; } return null; }
    if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { const r = find(x, k); if (r) return r; }
    return null;
  };
  const hit = find(fields, null);
  const s = (hit ? (hit[0] ? `${hit[0]}: ${hit[1]}` : hit[1]) : JSON.stringify(fields)).replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// `id`, or `id_2`, `id_3`… whichever is not in `taken`.
export function freeId(id, taken) {
  if (!taken.has(id)) return id;
  for (let n = 2; ; n++) if (!taken.has(`${id}_${n}`)) return `${id}_${n}`;
}

// Score levels are text or (per the Jev docs) an object such as {description, examples}.
// levelText: short label for display; levelToEdit / levelFromEdit: the editor's text form and back.
export const levelText = l => (typeof l === "string" ? l
  : typeof l?.description === "string" && l.description.trim() ? l.description : JSON.stringify(l));
export const levelToEdit = l => (typeof l === "string" ? l : JSON.stringify(l));
export function levelFromEdit(s) {
  const t = String(s ?? "").trim();
  if (!t) return { error: "empty level" };
  if (!t.startsWith("{")) return { value: t };  // "[ниже нормы]" stays text
  let v;
  try { v = JSON.parse(t); } catch (err) { return { error: "not valid JSON: " + err.message }; }
  return v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length ? { value: v }
    : { error: "must be a non-empty JSON object" };
}

// "name → value" rows for editing an object: kind text (string), list (strings, one per line)
// or json (any other value, so numbers, booleans and nested objects keep their type).
const isStrList = v => Array.isArray(v) && v.every(x => typeof x === "string");
export const kvRows = obj => Object.entries(obj || {}).map(([key, v]) =>
  typeof v === "string" ? { key, kind: "text", value: v }
  : isStrList(v) ? { key, kind: "list", value: v.join("\n") }
  : { key, kind: "json", value: JSON.stringify(v, null, 2) });
export function kvObject(rows) {
  const out = {};
  for (const [i, r] of rows.entries()) {
    const key = r.key.trim(), raw = r.value.replace(/\r/g, "");
    if (!key && !raw.trim()) continue;
    if (!key) return { error: `row ${i + 1}: the name is missing` };
    if (Object.hasOwn(out, key)) return { error: `\`${key}\` appears twice` };
    if (r.kind === "list") out[key] = raw.split("\n").map(s => s.trim()).filter(Boolean);
    else if (r.kind === "json") {
      try { out[key] = JSON.parse(raw); } catch (err) { return { error: `\`${key}\`: not valid JSON: ${err.message}` }; }
    } else out[key] = raw;
  }
  return Object.keys(out).length ? { value: out } : { error: "add at least one field" };
}
// Score level editor state: {mode: "text" | "fields", text, rows}.
export const levelToEditor = l => (typeof l === "string" ? { mode: "text", text: l, rows: [] }
  : l && typeof l === "object" && !Array.isArray(l) && Object.keys(l).length ? { mode: "fields", text: "", rows: kvRows(l) }
  : { mode: "text", text: JSON.stringify(l), rows: [] });
export const levelFromEditor = st => (st.mode === "fields" ? kvObject(st.rows) : levelFromEdit(st.text));

const canon = v => (v === undefined ? null : Array.isArray(v) ? v.map(canon)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v);
const sameCriteria = (a, b) => JSON.stringify(canon(a ?? null)) === JSON.stringify(canon(b ?? null));

// Which questions of a library file can become variants of `exp` ({type, criteria, columns}).
// questions: {id: {wire, valid, errors}} from the library analysis. An experiment without variants
// adopts the type and criteria of the first usable question.
export function matchQuestions(exp, questions) {
  const usable = q => q.valid !== false && ["noul", "choice", "score"].includes(q.wire.type);
  let { type, criteria } = exp;
  if (!exp.columns.length) {
    const first = Object.values(questions).find(usable);
    if (first) ({ type, criteria } = first.wire);
  }
  const columns = [], skipped = [];
  for (const [id, q] of Object.entries(questions)) {
    const w = q.wire;
    if (w.type === "box") skipped.push({ id, reason: "Box is single-run only" });
    else if (q.valid === false) skipped.push({ id, reason: "invalid: " + (q.errors || []).join("; ") });
    else if (w.type !== type) skipped.push({ id, reason: `other type (${w.type})` });
    else if (!sameCriteria(w.criteria, criteria)) skipped.push({ id, reason: "other criteria" });
    else columns.push({ instructions: w.instructions });
  }
  return { type, criteria: criteria ?? null, columns, skipped };
}
