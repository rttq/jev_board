---

description: "Task list for Experiment Steps (linear chain with gates)"
---

# Tasks: Experiment Steps (linear chain with gates)

**Input**: Design documents from `specs/003-experiment-steps/`

**Prerequisites**: plan.md, spec.md, research.md (R1–R10), data-model.md, contracts/ (http-api.md, ui.md), quickstart.md

**Tests**: Included, because plan.md names them. As in 001/002, they go only into the two existing files: `tests/test_core.py` (new `class TestSteps(Base)`) and `tests/metrics.test.mjs` (new cases). Use the `FakeJev` canned answers listed at the end of quickstart.md.

**Organization**: Phases 1–2 hold the storage, the pure gate math and a no-visible-change refactor of `experiments.js` into per-step contexts. Each story then adds UI on top: US1 (P1), US2 and US3 (P2), US4 and US5 (P3).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1–US5 from spec.md
- Most UI tasks touch `jevbench/static/experiments.js`, so `[P]` marks only tasks in other files

## Path Conventions

Existing package at repo root: `jevbench/` (server: `store.py`, `server.py`; page: `jevbench/static/`) and `tests/`. Terms used below:
- **Step 1** is the experiment's top-level `type`, `criteria`, `columns`, `rows[].label`, `view` and `views`.
- **Steps 2..N** are `experiment.steps[]`.
- In the browser, `allSteps(exp)` gives a uniform list. Step 1's key there is `"s0"`.
- `all_cols(e)` (Python) = `e["columns"] + [c for s in e["steps"] for c in s["columns"]]`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Add the new column and the view defaults

- [X] T001 In `jevbench/store.py`:
  - add `steps TEXT NOT NULL DEFAULT '[]'` to the `experiments` table in `SCHEMA`;
  - in `_connect`, read `PRAGMA table_info(experiments)` once into a set of column names. Keep the existing `reference` check, and add `ALTER TABLE experiments ADD COLUMN steps TEXT NOT NULL DEFAULT '[]'` when `steps` is missing.
- [X] T002 In `jevbench/store.py`, extend `DEFAULT_VIEW` with `"gate": {"min_level": None, "pass_options": None, "review_passes": False}, "step_name": None, "collapsed": False`
- [X] T003 [P] In `jevbench/static/experiments.js`, extend `DEFAULT_VIEW` the same way: `gate: { min_level: null, pass_options: null, review_passes: false }, step_name: null, collapsed: false`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Storage and validation of steps, the browser gate math, and per-step rendering, with no visible change for existing experiments

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

### Server storage

- [X] T004 In `jevbench/store.py`, extract two helpers from `_normalize`, with no change in behavior:
  - `_check_criteria(t, criteria, where="")`: the `EXP_TYPES` check and the `jev.validate_questions` probe. It raises `ExpError(400, where + message)`.
  - `_columns(q, cols, where, warnings)`: returns the normalized column dicts (wording required, `weight`, `threshold`, `hidden`, `question_hash = jev.question_hash(_wire(q, col))`). It merges repeats within the list with the warning `where + "variant i repeats an earlier wording and was merged"`. It does **not** assign keys.

  Step 1 calls both with `where=""`, so every existing message stays identical
- [X] T005 In `jevbench/store.py` `_normalize`, after rows are normalized and keyed, normalize `body.get("steps", old.get("steps", []))` per data-model.md → Step. Use `where = f"step {n + 2}: "` and:
  - type and criteria via `_check_criteria`;
  - columns via `_columns`;
  - `labels` = the given labels whose key is an existing row key, each checked with `_label_ok(type, criteria, v)` (else `ExpError(400, where + f"label {v!r} is not valid for {type}")`);
  - `view = {**DEFAULT_VIEW, **(s.get("view") or {})}`;
  - `views = s.get("views") or {}`;
  - `key = s.get("key")`.

  Then assign keys:
  - steps missing a key get `_next_key(steps, "s")`;
  - collect step 1's columns plus every step's columns into one list. If an explicit key appears twice, raise `ExpError(400, f"variant key {k} is used twice")`. Fill missing keys in that order with `_next_key(all_columns, "c")`, replacing the current per-list column key loop.

  Add `steps` to the returned `exp`
- [X] T006 In `jevbench/store.py`:
  - make `_exp_dict` also parse `steps`, with `None` → `[]`;
  - make `_save` write `json.dumps(exp.get("steps", []))` in both the INSERT and the UPDATE column lists;
  - confirm `duplicate_experiment` (`{**e, "name": name}`) and `experiment_from_runs` need no change (they get `steps` / `[]` automatically).
- [X] T007 In `jevbench/store.py` `update_experiment`, apply the per-step lock from research.md R9. First compute `answered = _answered(conn, [r["input_hash"] for r in old["rows"]], [c["question_hash"] for c in all_cols(old)])`. Then:
  1. Step 1 keeps its current check, now restricted to `any(c["question_hash"] in answered for c in old["columns"])`, so answers in later steps never lock step 1.
  2. For each new step whose key exists in `old["steps"]`: if any of that old step's column hashes are answered and its `type` or `criteria` changed, raise `ExpError(409, f"Step {pos}: type and criteria are fixed once answers exist. Duplicate the experiment to change them.")`.
  3. The wording check loops over `all_cols(old)` and `all_cols(exp)` by key.

  Add `all_cols` as a module-level helper
- [X] T008 In `jevbench/store.py` `experiment_cells`:
  - build `by_q` as `{question_hash: [col keys]}` over `all_cols(exp)`;
  - set each answer into `cells[row][key][model]` for every key in the list;
  - in `run_costs`, set `lens[key]` for every key in `by_q.get(hash, ["_" + qid])`;
  - add `# ponytail: a question shared by two steps splits its run cost over both keys; per-step cost if anyone needs it exact`.
- [X] T009 In `jevbench/store.py`, change `experiment_plan(conn, exp, model, price)` to `experiment_plan(conn, exp, model, price, step=None, rows=None)`:
  - `q = exp` when `step` is falsy. Otherwise `q` is the stored step with that key, or raise `ExpError(404, "step not found")`.
  - `visible = [c for c in q["columns"] if not c["hidden"]]`.
  - Iterate `exp["rows"]`, filtered to `set(rows)` when `rows` is given.
  - Build the chars estimate with `_wire(q, c)`.

  In `jevbench/server.py` `h_plan_exp`:
  - read `step = (query.get("step") or [""])[0] or None`;
  - read `rows = [k for k in (query.get("rows") or [""])[0].split(",") if k] or None`;
  - call through `_exp_call`;
  - add `# ponytail: rows in the query string, ~8k keys per URL; POST body if experiments grow past that`.
- [X] T010 [P] In `tests/test_core.py`, add `class TestSteps(Base)` with helpers `exp(fake=None, **over)` (as in `TestExperiments.exp`) and `put(e, fake=None, **over)` (a `PUT /api/experiments/{id}` with `{**e, **over}` that returns `(status, out)`). Tests:
  - (a) An old DB gains the column. Create `experiments.sqlite`-style tables by hand without `steps` (copy the 001 `CREATE TABLE experiments` without the column into a fresh file in `self.data`, insert one row). Then `store.open_db`, GET it, and assert `steps == []`. First check how `open_db` names the DB file.
  - (b) PUT with `steps: [{"type": "score", "criteria": SCORE["criteria"], "columns": [{"instructions": "How sweet?"}]}]` → step key `s1`, column key `c3`, `question_hash == jev.question_hash({"type": "score", "instructions": "How sweet?", "criteria": SCORE["criteria"]})`, and `view["gate"] == {"min_level": None, "pass_options": None, "review_passes": False}`.
  - (c) A duplicate column key `c1` in a step → 400 "used twice". Step type `"box"` → 400 starting with "step 2:". A Score step label `5` → 400. A label for a removed row key is dropped.
  - (d) Lock:
    - `post_run` with `{"input": APPLE, "questions": {"c3": {...score wire...}}, "experiment_id": id}`;
    - a PUT changing the step's type → 409 containing "Step 2";
    - a PUT changing `c3`'s wording → 409;
    - adding a column to the step → 200;
    - removing the step → 200, with `run_count()` unchanged;
    - step 1's type can still change (answers only in step 2).
  - (e) Cells: after (d)'s run, GET has `cells["r1"]["c3"]`. A step whose column has step 1's exact type, criteria and wording shares the cell: both keys are filled from one run.
  - (f) Plan: `server.dispatch(ctx, "GET", f"/api/experiments/{id}/plan", {"step": ["s1"], "rows": ["r1"]}, None)` → `requests == [{"row": "r1", "columns": ["c3"]}]` before the run. `step=zz` → 404. With no `step`, the result equals the old step-1 plan.

### Browser gate math (pure, `metrics.js`)

- [X] T011 [P] In `jevbench/static/metrics.js`, export `allSteps(exp)`, `gateFor(def)` and `passLikelihood(answer, type, gate)` exactly as specified in data-model.md → Computed:
  - step 1 is `{key: "s0", index: 0, …, labels: Object.fromEntries(rows.map(r => [r.key, r.label ?? null]))}`;
  - the Score default is `Math.ceil((n - 1) / 2)`, with `n = criteria.length`;
  - the Choice default is `[view.focus_option ?? Object.keys(criteria || {})[0]]`;
  - Score probabilities are keyed by `String(level)`.
- [X] T012 In `jevbench/static/metrics.js`, export `chain(exp, cells, models)`, `stepExp(exp, def, arrived)` and `missingRequests(rowKeys, columns, cells, model)` exactly as in data-model.md:
  - reuse `band`;
  - weights are `view.weights_override?.[key] ?? col.weight ?? 1`;
  - the gate model is `view.model` unless it is null or `"compare"`, in which case it is `models[0]`;
  - `wait` when there is no visible column or a cell is missing;
  - do not read `view.filters` or `view.sort`;
  - `stepExp` filters through a `Set`.
- [X] T013 In `tests/metrics.test.mjs`, import the new helpers and test:
  - `allSteps` on a doc with one stored step: keys `s0`/`s1`, step-1 labels taken from rows;
  - `stepExp`: rows filtered to `arrived`, labels swapped to the step's, and `applyView(stepExp(...), …)` returns only arrived rows;
  - `missingRequests`: hidden columns skipped, fully answered rows left out, output shape `{row, columns}`.

  It can run in parallel with T010 once T011–T012 are done

### Per-step rendering (refactor, no visible change)

- [X] T014 In `jevbench/static/experiments.js`, add per-step UI state:
  - `S.ui = {}`, `S.resolved = null`, `S.chain = []`;
  - a helper `ui(key)` that lazily creates `{selected: null, limit: 200, newCol: "", hideAfter: null, crit, pendingType: null, rowErrors: {}, openSetup: false, lastResult: null}` (with `crit = critToEditor(def.type, def.criteria)`).

  In `load()`, merge `DEFAULT_VIEW` into every stored step's view (`s.view = { ...clone(DEFAULT_VIEW), ...s.view }`). Move `S.selected`, `S.limit`, `S.newCol`, `S.hideAfter`, `S.crit`, `S.pendingType` and `S.rowErrors` into `ui(key)`. Keep `S.newRows`, `S.newFields`, `S.setupErr`, `S.setupMsg` and `S.openSetup` page-level, as step 1 inputs. In `saveDoc`, replace the `S.crit = …` line with a refresh of `ui(d.key).crit` for every `allSteps(S.exp)` entry
- [X] T015 In `jevbench/static/experiments.js`, add the step context and the save helpers:
  - `stepCtxs()` maps `S.chain` to `{def, i, key, arrived, res, exp: stepExp(S.exp, def, arrived), ui: ui(key), el: root.querySelector("#step-" + key)}`;
  - `saveStep(st, patch)`: `st.i === 0 ? saveDoc(patch) : saveDoc({ steps: S.exp.steps.map(s => (s.key === st.key ? { ...s, ...patch } : s)) })`;
  - `setLabel(st, rowKey, val)`: step 1 writes `row.label`; others write `S.exp.steps[st.i - 1].labels`, deleting the key on `null`;
  - `wire(st, col)` uses `st.def.type` / `st.def.criteria`;
  - `hasAnswers(st) = st.def.columns.some(c => Object.values(S.cells).some(r => r[c.key]))`.
- [X] T016 In `jevbench/static/experiments.js`, make every matrix function take `st` and read the step instead of the globals. The functions are `setupPanel`, `toolbar`, `runBar`, `cellText`, `labelOptions`, `labelCell` (via `setLabel`), `accText`, `confText`, `calText`, `useThreshold`, `cellTd`, `markSelected` (scoped to `st.el`), `colHeader`, `exportMatrix`, `mainTable`, `pivotTable`, `drawPanel` and `addLibraryVariants`:
  - `S.exp.type/criteria/columns/view/views` → `st.exp.*` / `st.def.*`;
  - `S.selected/limit/newCol/hideAfter/crit/pendingType/rowErrors` → `st.ui.*`;
  - `lastResult` → `st.ui.lastResult`;
  - `addLibraryVariants(st, an)` uses `matchQuestions(st.exp, …)` and `saveStep`.

  `addLibraryRows`, `importFile`, `addFormInput` and the inputs and reference UI stay step 1 only
- [X] T017 In `jevbench/static/experiments.js`, change `drawAll` and `drawGrid` to per-step rendering.
  - `drawAll()` renders:
    - `#exp-summary`;
    - per step, `h("section", {class: "step", id: "step-" + key, "aria-labelledby": …}, setupPanel(st), toolbar(st), h("div", {class: "dash-layout"}, h("div", {class: "grid-wrap"}), h("aside", {class: "cell-panel", "aria-label": "Cell details"})))`;
    - an empty `h("div", {class: "stepbar"})`.
  - Rename `drawGrid` to `drawGrids()`. It sets `S.chain = chain(S.exp, S.cells, S.models)`, updates the summary, and for each `st` renders `applyView(st.exp, S.cells, S.run_costs, st.def.view, S.models)` into `st.el`'s `.grid-wrap`, then `rovingGrid` and `drawPanel(st)`.
  - `changed()` → `drawGrids(); saveViewSoon()`.
  - Step 1 keeps the ids `new-col`, `exp-ref`, `lib-exp-input` and `lib-exp-questions`. Later steps use `new-col-{key}` and `lib-exp-questions-{key}`.
  - In `jevbench/static/style.css`, change `#grid-wrap` → `.grid-wrap` (in `main:has(...)`) and `#cell-panel` → `.cell-panel`.
- [X] T018 In `jevbench/static/experiments.js`, make the runner per step:
  - `refreshPlan()` fetches step 1's plan only to set `S.resolved = plan.resolved_model`.
  - `runBar(st)` counts `missingRequests(st.arrived, st.def.columns, S.cells, S.resolved).length`, and its reasons use that count.
  - `runMissing(st)` GETs `/plan?model=…&step=${st.i ? st.key : ""}&rows=${st.i ? st.arrived.join(",") : ""}`. When the chain has ≥ 2 steps, it prefixes the confirm text with `Step ${st.i + 1}: `. It then calls `runRequests(st, requests)`.
  - `runRow(st, req)` uses `wire(st, c)` and `st.ui.rowErrors`. The Retry button passes `st`.
  - `S.running = {done, total, label}`.
  - Ctrl+Enter runs the step in `ev.target.closest("section.step")`, or step 1 when focus is outside any step.
- [X] T019 Verify there is no visible change:
  - `python -m unittest tests.test_core` and `node --test "tests/*.test.mjs"` pass;
  - quickstart.md check 1 in the browser on an existing experiment: same matrix, numbers, Run missing count, Export CSV, labels, saved views, Load JSON and Load questions.

  Fix any regression in `jevbench/static/experiments.js` before going on

**Checkpoint**: Steps can be stored and validated, and gates are computed, but nothing new is visible yet

---

## Phase 3: User Story 1 - Chain two steps and gate the inputs (Priority: P1) 🎯 MVP

**Goal**: **+ Add step** appends a step. Step 1 shows a Noul gate with the review toggle. Step 2 lists and runs only the passing rows. Threshold changes re-filter live. Steps after the first can be removed.

**Independent Test**: quickstart.md checks 2, 3, 4, 7, 8 and 12 (noul → noul over 10 inputs).

### Tests for User Story 1

- [X] T020 [P] [US1] In `tests/metrics.test.mjs`, test `chain()` on a 2-step doc. Step 1 is Noul with one column `c1`. Step 2 is Noul with one column `c2`. The step-1 cells are `r1 0.93`, `r2 0.65`, `r3 0.2`, and `r4` has none. Check:
  - step 1 states are pass / stop (review) / stop / wait, and step 2 `arrived == ["r1"]`;
  - with `review_passes: true`, step 2 receives `["r1", "r2"]`;
  - with `threshold.high = 0.6`, `r2` passes;
  - `view.filters.text` that hides `r1` leaves `arrived` unchanged;
  - a hidden column is ignored, and a weight change moves `p`;
  - with `view.model = "compare"`, the gate uses `models[0]`;
  - a step with no visible column → all `wait`;
  - at every step, `entered === passed + stopped + waiting`.

### Implementation for User Story 1

- [X] T021 [US1] In `jevbench/static/experiments.js`, fill `.stepbar` with a `+ Add step` button (`id="add-step"`), visible for every experiment. `addStep()`:
  1. `await saveDoc({ steps: [...S.exp.steps, { type: "noul", criteria: null, columns: [], labels: {}, view: {} }] })`;
  2. then `ui(newKey).openSetup = true`, `drawAll()`;
  3. `scrollIntoView` the new section and focus `#new-col-{key}`.
- [X] T022 [US1] In `jevbench/static/experiments.js`, make `setupPanel(st)` render a reduced panel for `st.i > 0`, per contracts/ui.md:
  - summary "Setup · question and variants";
  - the Question section: type select (disabled when `hasAnswers(st)`), criteria editor and **Save question** → `saveStep(st, {type, criteria})`;
  - the Add variant section: **+ variant** → `saveStep(st, {columns})`, and **Load questions** → `openLibrary("exp-questions", an => addLibraryVariants(st, an), {exp: {type, criteria, columns}})`;
  - no name, reference or inputs;
  - open when the step has no columns or `st.ui.openSetup`.
- [X] T023 [US1] In `jevbench/static/experiments.js`, add a step header at the top of each section, shown only when `S.chain.length >= 2`:
  - `h2#step-{key}-h` with the text `Step N · {view.step_name || TYPE_LABEL[type]}`;
  - the counts `{entered} in · {passed} passed · {stopped} stopped · {waiting} waiting` from `st.res.counts`;
  - `waiting for rows that pass step N-1` when `st.i > 0 && entered === 0`;
  - a **Remove** button for `st.i > 0`: `confirmDialog("Remove step?", "Step N and its setup will be removed. Its answers stay in History.", "Remove")` → `saveDoc({ steps: S.exp.steps.filter(s => s.key !== st.key) })`, then focus `#add-step`.
- [X] T024 [US1] In `jevbench/static/experiments.js` `toolbar(st)`, add a gate row when `S.chain.length >= 2`:
  - a `Gate` label;
  - a `review passes` checkbox bound to `st.def.view.gate.review_passes` → `changed()`;
  - the text `pass ≥ {high} · stop < {low}` from `st.def.view.threshold`;
  - `.hint` `role="status"` warnings "No visible variants: every row waits here." and "Comparing versions: the gate uses {S.models[0]}."
- [X] T025 [US1] In `jevbench/static/experiments.js` `mainTable(st)`, add a last `gate` column when `S.chain.length >= 2`. Each cell shows `st.res.outcome[r.key]` as text per contracts/ui.md (`passes 0.91`, `review → passes 0.63`, `stops 0.12`, `review → stops 0.63`, `waiting`), with class `gate-pass` / `gate-stop` / `gate-wait`. Extend `statRow` and the agreement `colspan` by one when it is shown. Leave `pivotTable` without it
- [X] T026 [US1] In `jevbench/static/experiments.js` `summary()`, show the chain `allSteps(S.exp).map(d => TYPE_LABEL[d.type]).join(" → ")` instead of `TYPE_LABEL[e.type]`. Count visible variants across all steps
- [X] T027 [P] [US1] In `jevbench/static/style.css`, add:
  - `.step` (top border and spacing between sections);
  - `.step-h` (header row: title, counts, buttons);
  - `.gate-pass`, `.gate-stop`, `.gate-wait` (text tags that differ by border style and weight as well as color);
  - `.stepbar` (bottom bar row).
- [X] T028 [US1] Run quickstart.md checks 2, 3, 4, 7, 8 and 12 (`specs/003-experiment-steps/quickstart.md`) in the browser. For check 3, use the Network panel to confirm that only debounced `PUT`s go out. Fix what fails in `jevbench/static/experiments.js`

**Checkpoint**: noul → noul and noul → score chains work end to end (MVP)

---

## Phase 4: User Story 2 - Gate on Score levels and Choice options (Priority: P2)

**Goal**: Score steps gate on P(level ≥ minimum) and Choice steps on P(option in the passing set), with defaults and warnings.

**Independent Test**: quickstart.md checks 5 and 6 (noul → score → choice).

### Tests for User Story 2

- [X] T029 [P] [US2] In `tests/metrics.test.mjs`, test:
  - `passLikelihood` for Score with `{0: 0, 1: 0.57, 2: 0.43}`: min 1 → 1.0, and min 2 → 0.43;
  - `passLikelihood` for Choice with `{apple: 0.91, pear: 0.06, tomato: 0.03}`: `{apple}` → 0.91, and `{pear, tomato}` → 0.09;
  - `gateFor` defaults: 3 levels → 1, 4 levels → 2, 5 levels → 2, and Choice `null` → `[focus_option]` or else the first key;
  - `chain()` over noul → score → choice: Score min 2 with `low 0.4` gives review, which passes only with `review_passes`; Choice `pass_options: []` → no row passes; Score `min_level: 0` → every judged row passes.

### Implementation for User Story 2

- [X] T030 [US2] In `jevbench/static/experiments.js` `toolbar(st)`, add to the gate row for Score steps a `Pass at level ≥` select:
  - options are `[i, \`${i} · ${levelText(level)}\`]` from `st.def.criteria`;
  - the selected value is `gateFor(st.def).minLevel`;
  - `onchange` → `st.def.view.gate.min_level = Number(v); changed()`.
- [X] T031 [US2] In `jevbench/static/experiments.js` `toolbar(st)`, add to the gate row for Choice steps `Passing options:` with one checkbox per key of `st.def.criteria`:
  - checked from `gateFor(st.def).passOptions`;
  - `onchange` writes the full array of checked keys to `st.def.view.gate.pass_options`, then `changed()`.
- [X] T032 [US2] In `jevbench/static/experiments.js` `toolbar(st)`, add the gate warnings (`.hint`, `role="status"`): "No option is marked as passing: no row can pass." when Choice `passOptions` is empty, and "Minimum level is the lowest: every judged row passes." when Score `minLevel === 0`
- [X] T033 [US2] Run quickstart.md checks 5 and 6 (`specs/003-experiment-steps/quickstart.md`) in the browser and fix what fails in `jevbench/static/experiments.js`

**Checkpoint**: noul → score → choice works with correct per-type gates

---

## Phase 5: User Story 3 - See the funnel (Priority: P2)

**Goal**: A funnel table under the last step, and a one-line-per-input chain CSV.

**Independent Test**: quickstart.md check 11. The funnel counts equal each step grid's unfiltered row count (SC-006).

### Tests for User Story 3

- [X] T034 [P] [US3] In `tests/metrics.test.mjs`, test `chainCsv`:
  - the header is `input,tags,<label> outcome,<label> p` per step;
  - there is one line per experiment row;
  - a row that stopped at step 1 shows `did not reach` at step 2;
  - `p` has 4 decimals or is empty for `wait`;
  - an input containing a comma and a quote is quoted;
  - `stepLabel` uses `step_name` when set.

### Implementation for User Story 3

- [X] T035 [US3] In `jevbench/static/metrics.js`, export:
  - `stepLabel(def)` = `def.view.step_name || \`Step ${def.index + 1} · ${def.type[0].toUpperCase() + def.type.slice(1)}\``;
  - `chainCsv(exp, results)` per data-model.md, reusing `csvCell` and `inputText`. Outcomes are `passed`, `stopped`, `waiting`, `did not reach`.
- [X] T036 [US3] In `jevbench/static/experiments.js`, add `drawFunnel()`, called at the end of `drawGrids()` when `S.chain.length >= 2`. It renders into `.stepbar` a `<table class="funnel">`: a column per step headed by `stepLabel(def)`, rows `in` / `passed` / `stopped` / `waiting`, and a caption `Passed the chain: {last step passed}`. It keeps the `+ Add step` button
- [X] T037 [US3] In `jevbench/static/experiments.js`, extract `download(filename, text)` from `exportMatrix`. Add an **Export chain CSV** button to `.stepbar`, shown when the chain has ≥ 2 steps, that calls `download(\`${safe(S.exp.name)}-chain.csv\`, chainCsv(S.exp, S.chain))`
- [X] T038 [P] [US3] In `jevbench/static/style.css`, add `.funnel`: a compact numeric table, right-aligned numbers, and a header row with step labels
- [X] T039 [US3] Run quickstart.md check 11 (`specs/003-experiment-steps/quickstart.md`) and the SC-006 count check (the funnel equals each grid's row count with no filters) in the browser. Fix what fails

**Checkpoint**: The chain's outcome is visible and exportable

---

## Phase 6: User Story 4 - Manage a chain (Priority: P3)

**Goal**: Rename and collapse steps, keep them across reloads, duplicate with steps, and show the chain in the list.

**Independent Test**: quickstart.md check 9, plus rename and collapse surviving a reload.

### Tests for User Story 4

- [X] T040 [P] [US4] In `tests/test_core.py` `TestSteps`, test:
  - `POST /api/experiments/{id}/duplicate` copies `steps` with the same keys, columns, `view.gate` and labels;
  - `GET /api/experiments` returns `steps == ["noul", "score"]` and `columns` counted across steps.

### Implementation for User Story 4

- [X] T041 [US4] In `jevbench/store.py` `list_experiments`, add `"steps": [e["type"], *(s["type"] for s in e["steps"])]` and set `"columns": len(all_cols(e))`. In `jevbench/static/experiments.js` `renderList`, render the Type cell as `(e.steps || [e.type]).map(t => TYPE_LABEL[t]).join(" → ")`
- [X] T042 [US4] In `jevbench/static/experiments.js`, add a **Rename** button to the step header: `prompt("Step name:", view.step_name || "")` → `st.def.view.step_name = v.trim() || null; drawAll(); saveViewSoon()`
- [X] T043 [US4] In `jevbench/static/experiments.js`, add a **Collapse/Expand** toggle (`aria-expanded`) to the step header that flips `st.def.view.collapsed`, then `drawAll(); saveViewSoon()`. A collapsed section renders only its header, and `drawGrids()` skips its grid. `chain()` still covers every step
- [X] T044 [US4] In `jevbench/static/experiments.js` `toolbar(st)`, change the saved-view code:
  - read and write `st.def.views`: step 1 assigns `S.exp.views`, and other steps assign `S.exp.steps[st.i - 1].views`;
  - add `const keep = v => ({ step_name: v.step_name, collapsed: v.collapsed })`;
  - restore becomes `{ ...clone(DEFAULT_VIEW), ...clone(saved), ...keep(v) }`, and Reset view becomes `{ ...clone(DEFAULT_VIEW), ...keep(v) }`;
  - the step view object must be replaced in place on `st.def`'s owner (`S.exp.view` or `S.exp.steps[i - 1].view`).
- [X] T045 [US4] Run quickstart.md check 9 (`specs/003-experiment-steps/quickstart.md`) in the browser. Also rename step 2, collapse step 1, reload, and confirm both are kept. Fix what fails

**Checkpoint**: Chains are comfortable to work with day to day

---

## Phase 7: User Story 5 - Run the whole chain (Priority: P3)

**Goal**: One **Run chain** action runs every step in order, with an honest upfront cost.

**Independent Test**: quickstart.md check 10.

### Tests for User Story 5

- [X] T046 [P] [US5] In `tests/metrics.test.mjs`, test `reachable(exp, results, i)`:
  - `i = 0` → all rows;
  - rows stopped at step 1 are excluded at steps 2 and 3;
  - rows waiting at step 1 are included at step 2.

### Implementation for User Story 5

- [X] T047 [US5] In `jevbench/static/metrics.js`, export `reachable(exp, results, i)` = `exp.rows.filter(r => results.slice(0, i).every(res => res.outcome[r.key]?.state !== "stop")).map(r => r.key)`
- [X] T048 [US5] In `jevbench/static/experiments.js`, add a **Run chain** button (`id="run-chain"`) to `.stepbar` when the chain has ≥ 2 steps. Disable it while running, with no API key, or when no step has `missingRequests(reachable(S.exp, S.chain, i), …)` work. `runChain()` works like this:
  1. Fetch each step's plan, with `rows` = all rows for step 1 and `reachable(S.exp, S.chain, i)` for later steps.
  2. Confirm `Step 1: {n} requests ≈ $x · Step 2: at most {n} requests ≈ $y · …`.
  3. For each step in order: run `drawGrids()` (recomputes `S.chain`), fetch the plan for `st.arrived`, call `runRequests(st, requests)` when it is non-empty, then `await refreshCells()`.
  4. Set `S.running.label = \`Step ${i + 1}\``, so the run bar shows `Step K: done/total`.

  Rows that fail stay without a cell, so they are `wait` and are not sent on. Their Retry stays in that step
- [X] T049 [US5] Run quickstart.md check 10 (`specs/003-experiment-steps/quickstart.md`) in the browser. Compare the funnel after Run chain with a step-by-step run on a duplicate. Fix what fails

**Checkpoint**: All stories are complete

---

## Phase 8: Polish & Cross-Cutting Concerns

- [X] T050 [P] In `README.md`, add an "Experiment steps" section. Cover the chain, `+ Add step`, the pass likelihood per type (Noul P(yes), Score P(level ≥ min), Choice P(option in set)), the step thresholds and review toggle, "filters don't gate", the funnel and chain CSV, Run chain, and that step 1 can't be removed
- [X] T051 [P] In `tests/metrics.test.mjs`, add a timing sanity test. Build 5 steps × 1,000 rows with cells, and assert that `chain()` plus 5 × `applyView(stepExp(...))` takes < 300 ms (SC-003 compute budget)
- [X] T052 In `jevbench/static/experiments.js`, do an accessibility and keyboard pass:
  - every id is unique per step;
  - the grid `aria-label` is `Results matrix, step N` when there are ≥ 2 steps, and the cell panel `aria-label` is `Cell details, step N`;
  - gate states are readable as text;
  - focus goes to the new step after Add, and to `#add-step` after Remove;
  - arrow keys stay inside one step's grid.
- [X] T053 Run the full check: `python -m unittest tests.test_core`, `node --test "tests/*.test.mjs"`, and quickstart.md checks 1–12 (`specs/003-experiment-steps/quickstart.md`) in the browser. Fix anything found

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: none.
- **Foundational (Phase 2)**: depends on Setup. It **blocks every story**. Inside it:
  - T004 → T005 → T006 → T007/T008/T009 (all in `store.py`, so sequential) → T010;
  - T011 → T012 → T013;
  - T014 → T015 → T016 → T017 → T018 → T019. T014 needs T011 (`allSteps`), and T017 needs T012 (`chain`, `stepExp`).
- **US1 (Phase 3)**: depends on Phase 2. It is the MVP.
- **US2 (Phase 4)**: depends on US1's gate row (T024).
- **US3 (Phase 5)**: depends on US1's `.stepbar` (T021).
- **US4 (Phase 6)**: depends on US1's step header (T023). T040 and T041 depend only on Phase 2.
- **US5 (Phase 7)**: depends on US1's `.stepbar` (T021) and the per-step runner (T018).
- **Polish (Phase 8)**: after the stories you ship.

US2, US3 and US4 are independent of each other once US1 is done. They only conflict by editing the same file, `experiments.js`, so run them one after another, or merge carefully.

### Within Each Story

Write the test task first (it may pass at once, because the gate math is foundational). Then do the UI tasks in order, then the browser check.

### Parallel Opportunities

- T002 ‖ T003 (`store.py` vs `experiments.js`).
- Server track (T004–T010) ‖ math track (T011–T013). The refactor track (T014+) starts once T011–T012 are done.
- T020, T029, T034, T046 and T051 (`tests/metrics.test.mjs`) ‖ UI tasks in `experiments.js`.
- T027 and T038 (`style.css`) ‖ `experiments.js` tasks.
- T040 and T041 (`test_core.py`, and `store.py` plus a one-line `renderList`) can start right after Phase 2.

---

## Parallel Example: Phase 2

```text
Track A (server):  T004 → T005 → T006 → T007 → T008 → T009 → T010   jevbench/store.py, jevbench/server.py, tests/test_core.py
Track B (math):    T011 → T012 → T013                                  jevbench/static/metrics.js, tests/metrics.test.mjs
Track C (page):    (after T012) T014 → … → T018                        jevbench/static/experiments.js, style.css
Join:              T019
```

## Parallel Example: User Story 1

```text
Task: "T020 [US1] chain() Noul cases in tests/metrics.test.mjs"
Task: "T027 [US1] .step/.step-h/.gate-*/.stepbar in jevbench/static/style.css"
then, in order, in jevbench/static/experiments.js: T021 → T022 → T023 → T024 → T025 → T026, then T028
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Phase 1 (T001–T003).
2. Phase 2 (T004–T019). Stop at T019 and confirm existing experiments are unchanged (SC-005).
3. Phase 3 (T020–T028). Stop and validate noul → noul and noul → score per quickstart.md.
4. Ship: this is the user's core request, a gated second step.

### Incremental Delivery

1. MVP (US1).
2. US2: Score and Choice gates, which enables noul → score → choice.
3. US3: funnel and chain CSV.
4. US4: rename, collapse, list chain, duplicate check.
5. US5: Run chain.

Each step keeps every earlier check passing. Re-run T019's check after each phase.

---

## Notes

- 53 tasks. Every one names its file(s). Browser checks name `specs/003-experiment-steps/quickstart.md`.
- Never evaluate a gate on the server (research.md R4). If a task seems to need it, pass `rows` instead.
- Keep step 1's existing error texts and ids identical. Old tests and SC-005 depend on them.
- Commit after each phase, or after each story checkpoint.
