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
  let rows = exp.rows.map(r => {
    const values = {};
    for (const c of columns) {
      const cell = cells?.[r.key]?.[c.col.key]?.[c.model];
      const cv = cell && cellValue(cell.answer, exp.type, { focus, nLevels });
      values[c.key] = cv ? { ...cv, band: band(cv.v, c.t), runId: cell.run_id, answer: cell.answer, model: c.model } : null;
    }
    const vs = columns.map(c => values[c.key]?.v ?? null);
    const comp = composite(vs, columns.map(c => c.w));
    return { key: r.key, row: r, input: inputText(r.input), label: r.label ?? null, tags: r.tags || [], values,
             composite: comp, compositeBand: comp == null ? null : band(comp, view.threshold), spread: spread(vs),
             runIds: [...new Set(Object.values(values).filter(Boolean).map(x => x.runId))] };
  });
  rows = rows.filter(r =>
    (f.labeled == null || (f.labeled === "labeled") === (r.label != null)) &&
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
  for (const c of columns) c.stats = columnStats(rows.map(r => r.values[c.key]?.v ?? null), c.t);
  return {
    rows, columns, focus, model, nLevels,
    compositeStats: columnStats(rows.map(r => r.composite), view.threshold),
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
