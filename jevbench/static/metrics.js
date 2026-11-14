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

export function matrixCsv(result, exp, compare = false) {
  const vname = key => key.replace(/^c/, "v").replace(/@.*/, "");
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
