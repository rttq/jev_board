import { test } from "node:test";
import assert from "node:assert/strict";
import { cellValue, band, spread, columnStats, composite, agreement, costShare, applyView, transpose,
         labelMetrics, bestThreshold, isMiss }
  from "../jevbench/static/metrics.js";

const T = { low: 0.5, high: 0.8 };

test("cellValue for each type", () => {
  assert.deepEqual(cellValue({ noul: 0.93 }, "noul"), { v: 0.93 });
  const ch = { choice: "pear", probabilities: { apple: 0.31, pear: 0.6 } };
  assert.deepEqual(cellValue(ch, "choice", { focus: "apple" }), { v: 0.31, won: false, choice: "pear" });
  assert.equal(cellValue(ch, "choice", { focus: "pear" }).won, true);
  const sc = cellValue({ score: 1.43, legend: { 0: "a", 1: "b", 2: "c" } }, "score", { nLevels: 3 });
  assert.equal(sc.v, 0.715);
  assert.equal(sc.level, 1);
  assert.equal(cellValue(null, "noul"), null);
});

test("band edges: >= high is yes, < low is no", () => {
  assert.equal(band(0.8, T), "yes");
  assert.equal(band(0.5, T), "review");
  assert.equal(band(0.4999, T), "no");
});

test("spread needs two values", () => {
  assert.equal(spread([]), null);
  assert.equal(spread([0.4, null]), null);
  assert.ok(Math.abs(spread([0.2, 0.9, 0.5]) - 0.7) < 1e-12);
});

test("columnStats counts bands", () => {
  assert.deepEqual(columnStats([0.9, 0.6, 0.1, null], T), { n: 3, mean: 1.6 / 3, yes: 1, review: 1, no: 1 });
});

test("composite weights", () => {
  assert.equal(composite([0.2, 0.6, 1], [1, 1, 0]), 0.4);
  assert.equal(composite([0.2, 0.6], [0, 0]), null);
  assert.equal(composite([null, 0.6], [1, 1]), 0.6);
});

test("agreement", () => {
  assert.equal(agreement([["yes", "yes"], ["yes", "no"], ["no"]]), 0.5);
});

// ---- applyView on a small synthetic experiment ----
const M = "jev-1.14.0";
const exp = {
  type: "noul", criteria: null,
  rows: [{ key: "r1", input: { kind: "text", text: "b green" }, label: "yes", tags: ["g"] },
         { key: "r2", input: { kind: "text", text: "a red" }, label: null, tags: [] },
         { key: "r3", input: { kind: "text", text: "c none" }, label: null, tags: [] }],
  columns: [{ key: "c1", instructions: "aaaa", weight: 1 }, { key: "c2", instructions: "aaaaaaaaaaaa", weight: 1 },
            { key: "c3", instructions: "x", weight: 1, hidden: true }],
};
const cell = (v, run) => ({ [M]: { answer: { noul: v }, run_id: run } });
const cells = { r1: { c1: cell(0.62, 1), c2: cell(0.95, 1) }, r2: { c1: cell(0.2, 2), c2: cell(0.25, 2) } };
const runCosts = { 1: { cost_usd: 0.00001, questions: { c1: 4, c2: 12 } }, 2: { cost_usd: 0.00002, questions: { c1: 4, c2: 12 } } };
const view = { threshold: T, sort: { by: "input", dir: "asc" }, filters: {}, model: null };

test("applyView basics: hidden column excluded, sort, empties", () => {
  const out = applyView(exp, cells, runCosts, view, [M]);
  assert.deepEqual(out.columns.map(c => c.key), ["c1", "c2"]);
  assert.deepEqual(out.rows.map(r => r.key), ["r2", "r1", "r3"]);
  assert.equal(out.rows[1].values.c1.band, "review");
  assert.equal(out.rows[2].values.c1, null);
  assert.equal(out.rows[2].spread, null);
});

test("weights and per-column threshold override", () => {
  const out = applyView(exp, cells, runCosts, { ...view, weights_override: { c2: 0 } }, [M]);
  assert.equal(out.rows.find(r => r.key === "r1").composite, 0.62);
  const exp2 = { ...exp, columns: [{ ...exp.columns[0], threshold: { low: 0.1, high: 0.6 } }, exp.columns[1]] };
  const o2 = applyView(exp2, cells, runCosts, view, [M]);
  const r1 = o2.rows.find(r => r.key === "r1");
  assert.equal(r1.values.c1.band, "yes");  // overridden column
  assert.equal(r1.values.c2.band, "yes");
  assert.equal(o2.rows.find(r => r.key === "r2").values.c2.band, "no"); // other column still uses the view threshold
});

test("sort by spread desc and spread_min filter", () => {
  const out = applyView(exp, cells, runCosts, { ...view, sort: { by: "spread", dir: "desc" } }, [M]);
  assert.deepEqual(out.rows.map(r => r.key), ["r1", "r2", "r3"]);
  const f = applyView(exp, cells, runCosts, { ...view, filters: { spread_min: 0.1 } }, [M]);
  assert.deepEqual(f.rows.map(r => r.key), ["r1"]);
  const l = applyView(exp, cells, runCosts, { ...view, filters: { labeled: "labeled" } }, [M]);
  assert.deepEqual(l.rows.map(r => r.key), ["r1"]);
});

test("pivot preserves every value", () => {
  const out = applyView(exp, cells, runCosts, view, [M]);
  const p = transpose(out);
  for (const r of out.rows) for (const c of out.columns)
    assert.equal(p.rows.find(x => x.key === c.key).values[r.key], r.values[c.key]);
});

test("cost shares of a row sum to the row cost", () => {
  const rc = runCosts[1];
  assert.ok(Math.abs(costShare(rc, "c1") + costShare(rc, "c2") - rc.cost_usd) < 1e-15);
  assert.equal(costShare({ cost_usd: null, questions: { c1: 1 } }, "c1"), null);
});

test("applyView on 500 x 10 under 50 ms", () => {
  const big = { type: "noul", criteria: null, rows: [], columns: [] };
  const bc = {};
  for (let c = 0; c < 10; c++) big.columns.push({ key: "c" + c, instructions: "q" + c, weight: 1 });
  for (let r = 0; r < 500; r++) {
    big.rows.push({ key: "r" + r, input: { kind: "text", text: "t" + r }, tags: [] });
    bc["r" + r] = Object.fromEntries(big.columns.map((c, i) => [c.key, cell(((r * 7 + i * 13) % 100) / 100, r)]));
  }
  applyView(big, bc, {}, view, [M]); // warm-up
  const t0 = performance.now();
  applyView(big, bc, {}, { ...view, sort: { by: "spread", dir: "desc" } }, [M]);
  assert.ok(performance.now() - t0 < 50, `took ${performance.now() - t0} ms`);
});

// ---- US5: labels ----
test("labelMetrics: unlabeled ignored, confusion, review excluded from accuracy, Brier", () => {
  const pts = [{ v: 0.9, label: "yes" }, { v: 0.85, label: "no" }, { v: 0.6, label: "yes" }, { v: 0.2, label: "no" },
               { v: 0.1, label: "yes" }, { v: 0.95, label: null }, { v: null, label: "yes" }];
  const m = labelMetrics(pts, "noul", T);
  assert.equal(m.n, 5);
  assert.deepEqual([m.tp, m.fp, m.tn, m.fn, m.review], [1, 1, 1, 1, 1]);
  assert.equal(m.accuracy, 0.5);  // 2 correct of 4 decided
  assert.equal(m.reviewRate, 0.2);
  const brier = ((0.9 - 1) ** 2 + 0.85 ** 2 + (0.6 - 1) ** 2 + 0.2 ** 2 + (0.1 - 1) ** 2) / 5;
  assert.ok(Math.abs(m.brier - brier) < 1e-12);
  assert.equal(labelMetrics([{ v: 0.9, label: null }], "noul", T), null);
});

test("labelMetrics: Choice truth is label === focus", () => {
  const m = labelMetrics([{ v: 0.9, label: "apple" }, { v: 0.9, label: "pear" }], "choice", T, { focus: "apple" });
  assert.deepEqual([m.tp, m.fp], [1, 1]);
});

test("labelMetrics: Score accuracy by nearest level and MAE in levels", () => {
  // 5 levels → k = 4; scores 3.04, 1.75, 0.04 vs labels 1, 2, 0
  const m = labelMetrics([{ v: 3.04 / 4, label: 1 }, { v: 1.75 / 4, label: 2 }, { v: 0.04 / 4, label: 0 }], "score", T, { nLevels: 5 });
  assert.equal(m.n, 3);
  assert.ok(Math.abs(m.accuracy - 2 / 3) < 1e-12);
  assert.ok(Math.abs(m.mae - (2.04 + 0.25 + 0.04) / 3) < 1e-12);
  assert.equal(bestThreshold([{ v: 0.5, label: 1 }], "score"), null);
});

test("bestThreshold: best cut, ties closest to 0.5, all-no candidate", () => {
  const sep = [{ v: 0.2, label: "no" }, { v: 0.3, label: "no" }, { v: 0.7, label: "yes" }, { v: 0.9, label: "yes" }];
  assert.deepEqual(bestThreshold(sep, "noul"), { t: 0.7, accuracy: 1 });  // 0.7 is the only perfect value cut
  const tie = [{ v: 0.1, label: "no" }, { v: 0.45, label: "yes" }, { v: 0.6, label: "no" }, { v: 0.9, label: "yes" }];
  // t=0.45 and t=0.9 both give 3/4; 0.45 is closer to 0.5
  assert.deepEqual(bestThreshold(tie, "noul"), { t: 0.45, accuracy: 0.75 });
  assert.deepEqual(bestThreshold([{ v: 0.3, label: "no" }, { v: 0.6, label: "no" }], "noul"), { t: 1, accuracy: 1 });
});

test("isMiss and the misclassified filter", () => {
  assert.equal(isMiss(0.6, "no", "noul", T), false);  // review is not a miss
  assert.equal(isMiss(0.9, "no", "noul", T), true);
  assert.equal(isMiss(0.9, null, "noul", T), false);
  const out = applyView(exp, cells, runCosts, view, [M]);
  const r1 = out.rows.find(r => r.key === "r1");   // label yes: c1 0.62 review, c2 0.95 yes
  assert.equal(r1.values.c1.miss, false);
  assert.equal(r1.values.c2.miss, false);
  assert.equal(out.columns[0].metrics.n, 1);
  assert.equal(out.columns[0].metrics.review, 1);
  const lab = { ...exp, rows: exp.rows.map(r => (r.key === "r2" ? { ...r, label: "yes" } : r)) };  // r2 is 0.2/0.25 → miss
  const f = applyView(lab, cells, runCosts, { ...view, filters: { misclassified: true } }, [M]);
  assert.deepEqual(f.rows.map(r => r.key), ["r2"]);
  assert.equal(f.compositeMetrics.n, 1);
});
