import { test } from "node:test";
import assert from "node:assert/strict";
import { cellValue, band, spread, columnStats, composite, agreement, costShare, applyView, transpose,
         labelMetrics, bestThreshold, isMiss, matrixCsv,
         recordSummary, freeId, matchQuestions, levelText, levelToEdit, levelFromEdit,
         kvRows, kvObject, levelToEditor, levelFromEditor,
         allSteps, gateFor, passLikelihood, chain, stepExp, missingRequests, stepLabel, chainCsv, reachable }
  from "../jev_board/static/metrics.js";

test("name → value rows: object round trip, kinds, errors", () => {
  const obj = { answer: "a", tags: ["x", "y"], n: 2, flag: true, nested: { a: 1 }, nums: [1, 2], empty: [] };
  const rows = kvRows(obj);
  assert.deepEqual(rows.map(r => r.kind), ["text", "list", "json", "json", "json", "json", "list"]);
  assert.equal(rows[1].value, "x\ny");
  assert.deepEqual(kvObject(rows).value, obj);
  assert.deepEqual(kvObject([{ key: "a", kind: "text", value: "1" }, { key: " ", kind: "text", value: "" },
                             { key: "l", kind: "list", value: " p \n\n q " }]).value, { a: "1", l: ["p", "q"] });
  assert.match(kvObject([{ key: "", kind: "text", value: "v" }]).error, /row 1/);
  assert.match(kvObject([{ key: "a", kind: "text", value: "1" }, { key: "a", kind: "text", value: "2" }]).error, /`a`/);
  assert.match(kvObject([{ key: "j", kind: "json", value: "{oops" }]).error, /`j`.*JSON/);
  assert.ok(kvObject([{ key: "", kind: "text", value: "" }]).error);
  const lvl = { description: "d", examples: ["x"] };
  assert.equal(levelToEditor("calm").mode, "text");
  assert.equal(levelToEditor(lvl).mode, "fields");
  assert.equal(levelToEditor(lvl).rows.length, 2);
  assert.deepEqual(levelFromEditor(levelToEditor(lvl)).value, lvl);
  assert.deepEqual(levelFromEditor(levelToEditor("calm")).value, "calm");
  assert.ok(levelFromEditor({ mode: "text", text: "  ", rows: [] }).error);
});

test("Score levels: text or object, edited as JSON text", () => {
  const obj = { description: "d", examples: ["x", "y"] };
  assert.equal(levelToEdit("calm"), "calm");
  assert.equal(levelToEdit({ description: "d" }), JSON.stringify({ description: "d" }));
  assert.deepEqual(levelFromEdit(" calm "), { value: "calm" });
  assert.deepEqual(levelFromEdit('{"description":"d"}'), { value: { description: "d" } });
  assert.deepEqual(levelFromEdit(levelToEdit(obj)).value, obj);
  for (const bad of ["{oops", "{}", "  "]) assert.ok(levelFromEdit(bad).error, bad);
  assert.deepEqual(levelFromEdit("[ниже нормы]"), { value: "[ниже нормы]" });
  assert.equal(levelText("calm"), "calm");
  assert.equal(levelText(obj), "d");
  assert.equal(levelText({ examples: ["x"] }), JSON.stringify({ examples: ["x"] }));
});

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

test("matrixCsv: one row per visible input, values, composite, spread, label, then a metrics block", () => {
  const lab = { ...exp, rows: exp.rows.map(r => (r.key === "r2" ? { ...r, label: "no", input: { kind: "text", text: 'a "red", thing' } } : r)) };
  const out = applyView(lab, cells, runCosts, view, [M]);
  const csv = matrixCsv(out, lab);
  assert.ok(csv.startsWith("\ufeff"));
  const lines = csv.slice(1).trimEnd().split("\r\n");
  assert.equal(lines[0], "input,label,tags,v1: aaaa,v2: aaaaaaaaaaaa,composite,spread");
  assert.equal(lines[1], '"a ""red"", thing",no,,0.2,0.25,0.225,0.05');  // quoted, sorted by input
  assert.equal(lines[2], "b green,yes,g,0.62,0.95,0.785,0.33");
  assert.equal(lines[3], "c none,,,,,,");
  assert.equal(lines[4], "");
  assert.equal(lines[5], "metric,,,v1,v2,composite,");
  const row = name => lines.find(l => l.startsWith(name + ",")).split(",");
  assert.deepEqual(row("n").slice(3, 6), ["2", "2", "2"]);
  assert.deepEqual(row("accuracy").slice(3, 5), ["1", "1"]);  // r1 c1 is review → excluded; the rest correct
  assert.ok(row("best_threshold") && row("brier"));
});

test("recordSummary: first text depth-first, cut to 80, else compact JSON", () => {
  assert.equal(recordSummary({ ticket: { priority: 2, subject: "Refund" } }), "subject: Refund");
  assert.equal(recordSummary({ a: [" ", { b: "x\n y" }] }), "b: x y");
  const long = recordSummary({ t: "w".repeat(200) });
  assert.equal(long.length, 80);
  assert.ok(long.endsWith("…"));
  assert.equal(recordSummary({ n: 1, ok: true }), '{"n":1,"ok":true}');
  assert.equal(recordSummary({}), "{}");
});

test("freeId adds the first free suffix", () => {
  assert.equal(freeId("urgency", new Set()), "urgency");
  assert.equal(freeId("urgency", new Set(["urgency"])), "urgency_2");
  assert.equal(freeId("urgency", new Set(["urgency", "urgency_2"])), "urgency_3");
});

const Q = (wire, valid = true) => ({ wire, valid, errors: valid ? [] : ["bad"] });
const ABC = { a: null, b: "bee", c: null };
const QS = {
  n1: Q({ type: "noul", instructions: "Yes?" }),
  c1: Q({ type: "choice", instructions: "Which?", criteria: ABC }),
  c2: Q({ type: "choice", instructions: "Pick one", criteria: { c: null, b: "bee", a: null } }),
  c3: Q({ type: "choice", instructions: "Other", criteria: { x: null, y: null } }),
  bx: Q({ type: "box", instructions: "Where?" }),
};

test("matchQuestions: matching experiment keeps same criteria in any key order", () => {
  const m = matchQuestions({ type: "choice", criteria: ABC, columns: [{ key: "c1" }] }, QS);
  assert.deepEqual(m.columns, [{ instructions: "Which?" }, { instructions: "Pick one" }]);
  assert.deepEqual(m.skipped.map(s => [s.id, s.reason]), [
    ["n1", "other type (noul)"], ["c3", "other criteria"], ["bx", "Box is single-run only"]]);
});

test("matchQuestions: empty experiment adopts the first usable question", () => {
  const m = matchQuestions({ type: "noul", criteria: null, columns: [] },
                           { bx: QS.bx, bad: Q({ type: "choice", instructions: "?", criteria: { a: null } }, false), c1: QS.c1, c2: QS.c2 });
  assert.equal(m.type, "choice");
  assert.deepEqual(m.criteria, ABC);
  assert.equal(m.columns.length, 2);
  assert.deepEqual(m.skipped.map(s => s.id), ["bx", "bad"]);
});

test("matchQuestions: Noul with no criteria matches undefined or null", () => {
  const m = matchQuestions({ type: "noul", criteria: null, columns: [{}] },
                           { a: Q({ type: "noul", instructions: "A?" }), b: Q({ type: "noul", instructions: "B?", criteria: null }) });
  assert.equal(m.columns.length, 2);
});

// ---------- experiment steps ----------
const VIEW = { threshold: { low: 0.5, high: 0.8 }, filters: {}, sort: { by: "input", dir: "asc" }, gate: {} };
const row = (key, label = null) => ({ key, input: { kind: "text", text: key }, label, tags: [] });
const col = (key, extra = {}) => ({ key, instructions: key, weight: 1, hidden: false, ...extra });
const noulCell = v => ({ m1: { answer: { noul: v }, run_id: 1 } });
function twoStep(over = {}, stepOver = {}) {
  return { type: "noul", criteria: null, rows: [row("r1", "yes"), row("r2"), row("r3"), row("r4")],
           columns: [col("c1")], view: structuredClone(VIEW), views: {}, ...over,
           steps: [{ key: "s1", type: "noul", criteria: null, columns: [col("c2")], labels: { r1: "no" },
                     view: structuredClone(VIEW), views: {}, ...stepOver }] };
}
const CELLS = { r1: { c1: noulCell(0.93) }, r2: { c1: noulCell(0.65) }, r3: { c1: noulCell(0.2) } };

test("allSteps: step 1 from the top level (key s0, labels from rows), then stored steps", () => {
  const d = allSteps(twoStep());
  assert.deepEqual(d.map(x => [x.key, x.index, x.type]), [["s0", 0, "noul"], ["s1", 1, "noul"]]);
  assert.deepEqual(d[0].labels, { r1: "yes", r2: null, r3: null, r4: null });
  assert.deepEqual(d[1].labels, { r1: "no" });
});

test("stepExp: only arrived rows, with that step's labels; applyView sees just them", () => {
  const e = twoStep(), d = allSteps(e)[1];
  const se = stepExp(e, d, ["r1", "r3"]);
  assert.deepEqual(se.rows.map(r => [r.key, r.label]), [["r1", "no"], ["r3", null]]);
  assert.deepEqual(se.columns.map(c => c.key), ["c2"]);
  assert.equal(e.rows[0].label, "yes");  // the experiment's own rows are untouched
  const res = applyView(se, {}, {}, se.view, ["m1"]);
  assert.deepEqual(res.rows.map(r => r.key), ["r1", "r3"]);
});

test("missingRequests: visible columns without a cell for the model; answered rows left out", () => {
  const cols = [col("c1"), col("c2"), col("c9", { hidden: true })];
  const cells = { r1: { c1: noulCell(0.9), c2: noulCell(0.9) }, r2: { c1: noulCell(0.9) } };
  assert.deepEqual(missingRequests(["r1", "r2", "r3"], cols, cells, "m1"),
                   [{ row: "r2", columns: ["c2"] }, { row: "r3", columns: ["c1", "c2"] }]);
  assert.deepEqual(missingRequests(["r1"], cols, cells, "other").map(r => r.columns), [["c1", "c2"]]);
});

test("chain: Noul gate passes yes, stops no and review, waits until answered", () => {
  const [s1, s2] = chain(twoStep(), CELLS, ["m1"]);
  assert.deepEqual(Object.fromEntries(Object.entries(s1.outcome).map(([k, o]) => [k, o.state])),
                   { r1: "pass", r2: "stop", r3: "stop", r4: "wait" });
  assert.equal(s1.outcome.r2.band, "review");
  assert.deepEqual(s1.counts, { entered: 4, passed: 1, stopped: 2, waiting: 1 });
  assert.deepEqual(s2.arrived, ["r1"]);
  assert.deepEqual(s2.counts, { entered: 1, passed: 0, stopped: 0, waiting: 1 });  // r1 not answered at step 2 yet
  for (const s of [s1, s2]) assert.equal(s.counts.entered, s.counts.passed + s.counts.stopped + s.counts.waiting);
});

test("chain: review toggle and thresholds re-filter later steps; filters and sort never gate", () => {
  const e = twoStep();
  e.view.gate.review_passes = true;
  assert.deepEqual(chain(e, CELLS, ["m1"])[1].arrived, ["r1", "r2"]);
  const f = twoStep();
  f.view.threshold = { low: 0.5, high: 0.6 };
  assert.deepEqual(chain(f, CELLS, ["m1"])[1].arrived, ["r1", "r2"]);
  const g = twoStep();
  g.view.filters = { text: "r3", labeled: "unlabeled" }; g.view.sort = { by: "composite", dir: "desc" };
  assert.deepEqual(chain(g, CELLS, ["m1"])[1].arrived, ["r1"]);
});

test("chain: hidden variants and weights shape p; compare uses the latest model; no visible variant waits", () => {
  const cells = { r1: { c1: noulCell(0.9), c9: noulCell(0.1) } };
  const e = twoStep({ columns: [col("c1"), col("c9", { hidden: true })], rows: [row("r1")] });
  assert.equal(chain(e, cells, ["m1"])[0].outcome.r1.p, 0.9);
  e.columns[1].hidden = false;
  assert.equal(chain(e, cells, ["m1"])[0].outcome.r1.p, 0.5);
  e.view.weights_override = { c9: 0 };
  assert.equal(chain(e, cells, ["m1"])[0].outcome.r1.p, 0.9);
  e.view.model = "compare";  // c9 has no m2 answer, so it must be hidden for r1 to be judged on m2
  e.columns[1].hidden = true;
  assert.equal(chain(e, { r1: { c1: { m2: { answer: { noul: 0.2 } }, m1: { answer: { noul: 0.9 } } } } },
                     ["m2", "m1"])[0].outcome.r1.p, 0.2);
  const none = twoStep({ columns: [col("c1", { hidden: true })] });
  assert.deepEqual(chain(none, CELLS, ["m1"])[0].counts, { entered: 4, passed: 0, stopped: 0, waiting: 4 });
});

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);
const SCORE_ANS = { score: 1.43, probabilities: { 0: 0.0, 1: 0.57, 2: 0.43 }, legend: { 0: "a", 1: "b", 2: "c" } };
const CHOICE_ANS = { choice: "apple", probabilities: { apple: 0.91, pear: 0.06, tomato: 0.03 } };

test("passLikelihood: Score sums levels at or above the minimum; Choice sums the passing options", () => {
  near(passLikelihood(SCORE_ANS, "score", { minLevel: 1 }), 1.0);
  near(passLikelihood(SCORE_ANS, "score", { minLevel: 2 }), 0.43);
  near(passLikelihood(CHOICE_ANS, "choice", { passOptions: ["apple"] }), 0.91);
  near(passLikelihood(CHOICE_ANS, "choice", { passOptions: ["pear", "tomato"] }), 0.09);
  assert.equal(passLikelihood(CHOICE_ANS, "choice", { passOptions: [] }), 0);
  assert.equal(passLikelihood(null, "noul", {}), null);
});

test("gateFor: defaults to the middle level (rounded up) and the focus option", () => {
  const lv = n => gateFor({ type: "score", criteria: Array.from({ length: n }, (_, i) => `l${i}`), view: {} }).minLevel;
  assert.deepEqual([lv(3), lv(4), lv(5)], [1, 2, 2]);
  const crit = { apple: null, pear: null, tomato: null };
  assert.deepEqual(gateFor({ type: "choice", criteria: crit, view: {} }).passOptions, ["apple"]);
  assert.deepEqual(gateFor({ type: "choice", criteria: crit, view: { focus_option: "pear" } }).passOptions, ["pear"]);
  assert.deepEqual(gateFor({ type: "choice", criteria: crit, view: { gate: { pass_options: [] } } }).passOptions, []);
  assert.equal(gateFor({ type: "score", criteria: ["a", "b", "c"], view: { gate: { min_level: 0 } } }).minLevel, 0);
});

test("chain: noul → score → choice with per-type gates and review", () => {
  const e = { type: "noul", criteria: null, rows: [row("r1")], columns: [col("c1")], view: structuredClone(VIEW),
    steps: [{ key: "s1", type: "score", criteria: ["a", "b", "c"], columns: [col("c2")], labels: {},
              view: { ...structuredClone(VIEW), gate: { min_level: 2 } } },
            { key: "s2", type: "choice", criteria: { apple: null, pear: null, tomato: null }, columns: [col("c3")], labels: {},
              view: { ...structuredClone(VIEW), gate: { pass_options: ["pear", "tomato"] } } }] };
  const cells = { r1: { c1: noulCell(0.93), c2: { m1: { answer: SCORE_ANS } }, c3: { m1: { answer: CHOICE_ANS } } } };
  let res = chain(e, cells, ["m1"]);
  assert.equal(res[1].outcome.r1.state, "stop");  // P(level ≥ 2) = 0.43 < low 0.5
  e.steps[0].view.threshold = { low: 0.4, high: 0.8 };
  res = chain(e, cells, ["m1"]);
  assert.deepEqual([res[1].outcome.r1.band, res[1].outcome.r1.state], ["review", "stop"]);
  e.steps[0].view.gate.review_passes = true;
  res = chain(e, cells, ["m1"]);
  assert.equal(res[1].outcome.r1.state, "pass");
  assert.equal(res[2].outcome.r1.state, "stop");  // P(pear or tomato) = 0.09
  e.steps[1].view.gate.pass_options = [];
  assert.equal(chain(e, cells, ["m1"])[2].counts.passed, 0);
  e.steps[0].view.gate.min_level = 0;
  e.steps[0].view.gate.review_passes = false;
  assert.equal(chain(e, cells, ["m1"])[1].outcome.r1.state, "pass");  // every level counts → p = 1
});

test("chainCsv: one line per input, outcome and p per step, 'did not reach' after a stop", () => {
  const e = twoStep();
  e.rows[2].input.text = 'Red, "round" veg';
  e.steps[0].view.step_name = "edible";
  const csv = chainCsv(e, chain(e, CELLS, ["m1"]));
  const lines = csv.replace(/^\uFEFF/, "").trim().split(/\r\n/);
  assert.equal(lines[0], "input,tags,Step 1 · Noul outcome,Step 1 · Noul p,edible outcome,edible p");
  assert.equal(lines.length, 1 + e.rows.length + 4);
  assert.deepEqual(lines.slice(-4), ["", "step,variant,wording", "Step 1 · Noul,v1,c1", "edible,v2,c2"]);
  assert.equal(lines[1], "r1,,passed,0.93,waiting,");
  assert.equal(lines[3], '"Red, ""round"" veg",,stopped,0.2,did not reach,');
  assert.equal(lines[4], "r4,,waiting,,did not reach,");
  assert.equal(stepLabel(allSteps(e)[0]), "Step 1 · Noul");
});

test("reachable: everything at step 1; rows stopped earlier drop out; waiting rows stay in", () => {
  const e = twoStep(), res = chain(e, CELLS, ["m1"]);
  assert.deepEqual(reachable(e, res, 0), ["r1", "r2", "r3", "r4"]);
  assert.deepEqual(reachable(e, res, 1), ["r1", "r4"]);  // r2 (review) and r3 stopped; r4 waits at step 1
  e.steps.push({ key: "s2", type: "noul", criteria: null, columns: [col("c3")], labels: {}, view: structuredClone(VIEW) });
  assert.deepEqual(reachable(e, chain(e, CELLS, ["m1"]), 2), ["r1", "r4"]);  // r1 waits at step 2, so it may still go on
});

test("chain + applyView stay fast: 5 steps × 1,000 rows well under the 1 s redraw budget (SC-003)", () => {
  const n = 1000, rows = Array.from({ length: n }, (_, i) => row(`r${i}`));
  const step = k => ({ key: `s${k}`, type: "noul", criteria: null, columns: [col(`c${k}a`), col(`c${k}b`)], labels: {}, view: structuredClone(VIEW) });
  const e = { type: "noul", criteria: null, rows, columns: [col("c0a"), col("c0b")], view: { ...structuredClone(VIEW), threshold: { low: 0.1, high: 0.2 } },
              steps: [1, 2, 3, 4].map(step) };
  for (const s of e.steps) s.view.threshold = { low: 0.1, high: 0.2 };
  const cells = {};
  rows.forEach((r, i) => { cells[r.key] = {}; for (const k of [0, 1, 2, 3, 4]) for (const x of "ab") cells[r.key][`c${k}${x}`] = noulCell(((i * 7 + k) % 10) / 10); });
  const t0 = performance.now();
  const res = chain(e, cells, ["m1"]);
  for (const r of res) applyView(stepExp(e, r.def, r.arrived), cells, {}, r.def.view, ["m1"]);
  const ms = performance.now() - t0;
  assert.ok(res[4].arrived.length > 0, "rows reach the last step");
  assert.ok(ms < 300, `took ${ms.toFixed(0)} ms`);
});
