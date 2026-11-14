---

description: "Task list for Jev Classification Workbench"
---

# Tasks: Jev Classification Workbench (local GUI)

**Input**: Design documents from `specs/001-jev-classification-gui/`

**Prerequisites**: plan.md, spec.md (rev 2), research.md, data-model.md, contracts/ (cli.md, http-api.md, ui.md), quickstart.md

**Tests**: Included, because plan.md and research.md (R9, R12) require them. They are kept to exactly two files: `tests/test_core.py` (stdlib `unittest`, fake Jev client, no API key) and `tests/metrics.test.mjs` (`node --test`, no dependencies). Each story adds its cases to those files.

**Organization**: Grouped by user story. Phase order follows spec priority. Within P2, US8 (History) comes before US6 because US6's entry point is the History list.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1–US9 from spec.md
- Many tasks touch the same files (`jevbench/store.py`, `jevbench/static/app.js`), so `[P]` is used only where the files really differ

## Path Conventions

Single Python package at repo root: `jevbench/` (server + `jevbench/static/` page), `tests/`. See plan.md → Project Structure.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization

- [X] T001 Create `pyproject.toml` at repo root: `name = "jevbench"`, `requires-python = ">=3.11"`, `dependencies = ["typesafe-sdk"]`, `[project.scripts] jevbench = "jevbench.__main__:main"`, hatchling build backend, and include `jevbench/static/*` as package data
- [X] T002 [P] Create the package skeleton: empty `jevbench/__init__.py`, `jevbench/__main__.py`, `jevbench/server.py`, `jevbench/jev.py`, `jevbench/store.py`, `jevbench/static/index.html`, `jevbench/static/app.js`, `jevbench/static/metrics.js`, `jevbench/static/style.css`, `tests/test_core.py`, `tests/metrics.test.mjs`
- [X] T003 [P] Create `.gitignore` at repo root with `.venv/`, `__pycache__/`, `*.pyc`, `dist/`, `build/`, `.checks/`
- [X] T004 Run `uv sync`, then confirm the installed SDK surface with a one-off `uv run python -c` script: `TypeSafeClient`, `Noul`/`Choice`/`Score`/`Box` (or dict questions with `type`), `Image.from_base64`, `response.model`, `response.usage.input_tokens`, `response.request_id`, `answer.model_dump(mode="json")`, `client.models.list()`, and the exception class names in `typesafe_sdk`. Write the confirmed names as a short comment block at the top of `jevbench/jev.py`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Storage, the Jev wrapper, the HTTP server, CLI launch and the page shell. Every story needs these.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [X] T005 Implement `open_db(data_dir) -> (conn, notice)` in `jevbench/store.py`: create `data_dir` and `data_dir/images/`; schema for `runs`, `answers`, `experiments`, `prefs` with all columns and indexes from data-model.md; `PRAGMA foreign_keys=ON`, `journal_mode=WAL`; `check_same_thread=False` with one module-level `threading.Lock` around writes (`# ponytail: global write lock, fine for one local user`). On `sqlite3.DatabaseError` at open or schema check, rename the file to `jevbench.db.broken-<UTC timestamp>`, create a fresh DB, and return a notice string
- [X] T006 Implement `get_prefs(conn)`, `put_prefs(conn, partial) -> prefs` and `reset_prefs(conn)` in `jevbench/store.py`. Defaults: `theme=system, text_scale=1.0, prob_format=percent, prob_decimals=0, default_model=jev-latest, price_per_mtok=0.042, concurrency=4`. Merge partial updates, ignore unknown keys, clamp `text_scale` to 0.85–1.5, `prob_decimals` to 0–4, `concurrency` to 1–8, `price_per_mtok` to ≥ 0
- [X] T007 [P] Implement `canon_hash(obj) -> str` (SHA-256 of `json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`, first 16 hex chars), `input_hash(input, image_sha)` and `question_hash(q)` (over `type`, `instructions` and `criteria` only, never the ID) in `jevbench/jev.py`
- [X] T008 [P] Implement `validate_questions(questions, has_image, model) -> list[{"field", "error"}]` and `validate_image(b64) -> (bytes, ext) | error` in `jevbench/jev.py`. Rules from data-model.md: ID regex `^[A-Za-z0-9_\-]{1,64}$`; type in noul/choice/score/box; non-empty instructions; Choice criteria object with ≥ 2 keys; Score criteria list with ≥ 2 non-empty items; Box needs an image and a model not starting `jev-1.13`; image PNG/JPEG magic bytes and ≤ 20 MiB decoded
- [X] T009 Implement `build_state(input, image)` (`{"text": …}` for `kind=text`, `fields` for `kind=json`, plus `"image": Image` when present), `call_jev(client, model, state, questions) -> dict` and `cost_usd(tokens, price)` in `jevbench/jev.py`. `call_jev` returns `{status, model_used, answers: {id: model_dump(mode="json")}, input_tokens, request_id, duration_ms, error}`. It catches the SDK exceptions and maps them to readable messages (401 → "API key rejected", 400 `max_tokens_exceeded` → "input too long for the model", 422 → the detail, connection or timeout → "network error", after the SDK's own retries). `cost_usd` returns `None` when tokens are `None`
- [X] T010 Implement `insert_run(conn, run) -> id` (one transaction: the `runs` row, plus one `answers` row per answer with `question_hash`, `input_hash`, `model_used`, `type`, `created_at` when status is ok) and `get_run(conn, id)` (JSON fields parsed, `answers` attached as `{question_id: answer}`) in `jevbench/store.py`
- [X] T011 Implement the HTTP layer in `jevbench/server.py`: a `ThreadingHTTPServer` subclass bound to `127.0.0.1`; a handler with a route table `[(method, compiled_regex, fn)]`; `read_json()` / `send_json(status, obj)` / `send_error(status, msg, field=None)` matching the http-api.md error shape; static serving from `jevbench/static/` (`/` → `index.html`, `/static/<name>` with content type by extension, path traversal rejected); `GET /api/images/{sha}` from `data_dir/images`. Route handlers are plain functions `fn(ctx, params, body)` returning `(status, obj)`, so tests can call them without sockets
- [X] T012 Implement `main()` in `jevbench/__main__.py` per contracts/cli.md: argparse `--port 8765`, `--data-dir <project>/data`, `--no-browser`. API key from `TYPESAFE_API_KEY`, else from `.env` in the project root (real env vars win). Build `ctx = {conn, client|None, data_dir, notice, started_at, key_hint}`. If the port is busy, print "port N in use, try --port" and exit 1. Print the three startup lines, open the browser unless `--no-browser`, and `serve_forever` until Ctrl+C (exit 0)
- [X] T013 Implement `GET /api/status` and `GET|PUT /api/prefs` + `POST /api/prefs/reset` in `jevbench/server.py`. Status: `key_present`, `key_hint` (last 4), `data_dir`, `notice`, `server_started_at`, and `models` = static `["jev-latest", "jev-preview", "jev-1.14.0", "jev-1.13.0"]` merged once with `client.models.list()` (best effort, cached, errors ignored)
- [X] T014 [P] Write the page shell in `jevbench/static/index.html` (header with nav Run · Experiments · History · Settings, a totals slot, a `<main id="view">`, one `<dialog id="dlg">`, setup banner slot; `<script type="module" src="/static/app.js">`) and base styles in `jevbench/static/style.css` (color tokens on `:root` with dark overrides under `[data-theme=dark]` and `@media (prefers-color-scheme: dark)` for `system`; `--text-scale` on `html { font-size }`; neutral, low-chrome look; visible `:focus-visible`; `@media (prefers-reduced-motion)` disables transitions)
- [X] T015 Implement the app core in `jevbench/static/app.js`: hash router (`#/run`, `#/experiments`, `#/experiments/<id>`, `#/history`, `#/settings`); `api(method, path, body)` fetch helper that throws `{status, error, field}`; startup loads `/api/status` + `/api/prefs`, applies `data-theme` and `--text-scale`, shows the setup banner when `key_present` is false and the `notice` when set; `fmtProb(p)` honoring `prob_format` and `prob_decimals`; `fmtUSD(x)` (enough significant digits to be non-zero, "unknown" for null)
- [X] T016 Add foundational tests in `tests/test_core.py`: a `FakeClient` whose `system_one()` returns canned objects shaped like SDK responses for all 4 types (with `model`, `usage.input_tokens`, `request_id`, and answers having `model_dump`) and can raise configured errors. Tests: `question_hash` ignores the ID and changes with wording or criteria; `validate_questions` rejects each rule from T008; `cost_usd(118, 0.042)` = `4.956e-06` and `cost_usd(None, …)` is `None`; `insert_run`/`get_run` round-trips answers; prefs clamping; corrupt-DB recovery (write garbage bytes to `jevbench.db`, `open_db` returns a notice and a working DB, and the `.broken-*` file exists)
- [X] T017 Add an opt-in live contract test class `LiveSmoke` to `tests/test_core.py`, decorated `@unittest.skipUnless(os.environ.get("TYPESAFE_API_KEY") and os.environ.get("JEVBENCH_LIVE") == "1", ...)`. It makes one real `call_jev` on `jev-latest` with a short text and one Noul + one Choice + one Score. Assert `status == "ok"`, `model_used.startswith("jev-")`, `input_tokens` is an int > 0, and each answer dump has the keys the app reads (noul: `noul`; choice: `choice, probabilities, confidence`; score: `score, legend, probabilities, confidence`, with legend keys `"0"…`). Then assert the `FakeClient` canned answers have **the same key sets** as the live ones, so the fakes cannot drift from the real API. Cost is a fraction of a cent per run

**Checkpoint**: `uv run jevbench` serves an empty shell with status and prefs, and `uv run python -m unittest discover -s tests` passes

---

## Phase 3: User Story 1 - Test one proposition against one input (Priority: P1) 🎯 MVP

**Goal**: Compose an input with one or more questions of any text type, run it, and see typed results with model version and cost. Every run is recorded.

**Independent Test**: With a key, run Noul ``Is `text` describing an apple?`` on an apple description. You see P(yes), `jev-1.14.0`, tokens and cost. With no key, you see a setup message and nothing is recorded.

- [X] T018 [US1] Implement the `POST /api/runs` handler in `jevbench/server.py`. Steps: parse the body per http-api.md; `validate_questions` + `validate_image`, returning 400 with `field` and not recording; no client → 503 and not recording; store the image as `images/<sha256>.<ext>` if present; `build_state` → `call_jev` → `cost_usd` with the current `price_per_mtok` (error status → cost `None`); `insert_run` with `experiment_id`, `input_hash`, `price_per_mtok`; return `get_run(...)` plus `question_hash` per question
- [X] T019 [US1] Implement `GET /api/runs/{id}` in `jevbench/server.py` (404 when missing)
- [X] T020 [US1] Add tests in `tests/test_core.py` that call the `POST /api/runs` handler function directly with `FakeClient`: an ok run is recorded with answers and cost; an SDK error is recorded with `status=error` and `cost_usd=None`; a validation failure returns 400 and records nothing; a missing client returns 503 and records nothing; a mixed Noul + Choice + Score run makes exactly one `system_one` call
- [X] T021 [US1] Build the Run view editor in `jevbench/static/app.js`: input panel with a Text / Fields (JSON textarea, parsed on run) toggle and an image attach (PNG/JPEG → base64); question list with add/remove, auto IDs `q1…`, type select (Noul default from prefs), instructions textarea, and per-type criteria editors (Choice: rows of option key + optional description; Score: ordered level rows with up/down; Noul: optional clarification); model select from `/api/status` models (default from prefs). Client-side validation mirrors T008, with messages next to fields. Run button and `Ctrl+Enter`; disabled with a reason when the key is missing. Export the criteria editors as reusable functions (they are reused in T039)
- [X] T022 [US1] Implement single-run result renderers in `jevbench/static/app.js` per contracts/ui.md: Noul (P(yes) bar, value, YES/REVIEW/NO text tag at 0.5/0.8); Choice (chosen option, all options as bars sorted by probability, confidence); Score (horizontal level scale with a position marker, per-level bars, confidence, "split" hint when the top 2 levels are non-adjacent and each ≥ 0.25); footer with `model_used · input_tokens tok · cost · duration`; error state showing the run's `error`
- [X] T023 [P] [US1] Add result styles in `jevbench/static/style.css`: `.bar` (track + fill width from `--v`), `.scale` with ticks and marker, `.tag-yes/.tag-review/.tag-no` (text tags whose color is secondary to the label), result card layout
- [X] T024 [US1] Browser check of US1 with the Playwright MCP tools: start `uv run jevbench --no-browser --port 8799 --data-dir .checks/data` in the background, then navigate to `http://127.0.0.1:8799/#/run`. Run quickstart step 1 (Noul, then Noul + Choice + Score in one run); assert the result card shows a value, `jev-`, tokens and a cost; assert `browser_console_messages` has no errors. Screenshot light theme, dark theme and 390px width to `.checks/us1-*.png`. Restart without a key and assert the setup banner shows and Run is disabled. Append pass/fail lines to `.checks/REPORT.md`

**Checkpoint**: US1 is usable end to end. This is the MVP.

---

## Phase 4: User Story 2 - Read the type guide and choose a type (Priority: P1)

**Goal**: A short guide card per type next to the editor, plus a compare-all dialog. Works offline.

**Independent Test**: With no key and no network, open Run. Switching type shows that type's card; "Compare types" shows 4 cards; Box with no image disables Run and shows the reason.

- [X] T025 [US2] Add a `GUIDE` constant to `jevbench/static/app.js`: 4 entries `{type, asks, returns, use_when, pitfall, diagram_svg}` with the exact text from the contracts/ui.md "Guide card content" table, and one small inline SVG diagram each (Noul: a 0–1 bar with a marker; Choice: 3 bars, one highlighted; Score: an ordered scale with a marker between ticks; Box: a frame with a rectangle). Each card has ≤ ~60 words
- [X] T026 [US2] In `jevbench/static/app.js`, render the focused question's card beside the Run editor (it updates on type change or question focus), add a "Compare types" button that opens `#dlg` with all 4 cards, and when Box is selected with no image, show the reason on the disabled Run button (`title` + visible text)
- [X] T027 [P] [US2] Add guide card and compare-dialog styles in `jevbench/static/style.css` (4 columns on wide screens, stacked under 720px, diagrams inherit `currentColor`)

**Checkpoint**: US1 + US2 work independently

---

## Phase 5: User Story 3 - Design and run a wording-variants matrix (Priority: P1)

**Goal**: Experiments with inputs × wording variants of one type, run one request per row, shown as a heatmap with spread.

**Independent Test**: Create an experiment with 10 inputs × 3 Noul variants, confirm the estimate, and see a filled 10 × 3 heatmap with per-row spread. Add a 4th variant: only 10 cells are requested.

- [X] T028 [P] [US3] Implement pure exports in `jevbench/static/metrics.js`: `cellValue(answer, type, {focus, nLevels})` → `{v, won?, level?}` (Noul `noul`; Choice `probabilities[focus]` and `won = choice === focus`; Score `score/(nLevels-1)` and `level = Math.round(score)`); `band(v, {low, high})` → `"yes" | "review" | "no"`; `spread(values)` (null if < 2 values); `columnStats(values, t)` → `{mean, yes, review, no}`
- [X] T029 [P] [US3] Write tests in `tests/metrics.test.mjs` (`node:test` + `node:assert`): `cellValue` for all three types including Choice `won=false` and Score normalization (score 1.43 of 3 levels → 0.715, level 1); `band` at exactly `low` and `high` (≥ high is yes, < low is no); `spread` with 0, 1 and 3 values; `columnStats` counts
- [X] T030 [US3] Implement experiments in `jevbench/store.py`: `create_experiment(conn, body)` (assign row keys `r1…` and column keys `c1…`, compute `input_hash`/`question_hash` via `jev.py`, default `weight=1`, `threshold=None`, `hidden=False`, default view from data-model.md, validate type ∈ noul/choice/score, criteria shape, labels per type (per-row errors list → 400), duplicate input or wording warnings returned in `warnings`); `list_experiments` (with `cost_usd` = sum of runs where `experiment_id` matches); `get_experiment`; `update_experiment(conn, id, doc)` (recompute hashes, assign keys to new rows and columns, never reuse keys, raise a 409 error if an answered column's `instructions` change or if `type`/`criteria` change once any answer matches); `duplicate_experiment`; `delete_experiment` (set `runs.experiment_id = NULL`)
- [X] T031 [US3] Implement `experiment_cells(conn, exp)` in `jevbench/store.py`. Query `answers JOIN runs` where `status='ok'`, `input_hash IN (rows)` and `question_hash IN (columns)`; keep the latest per `(row_key, col_key, model_used)`. Return `cells`, `run_costs` (`cost_usd`, `input_tokens`, and `questions: {col_key: len(instructions)}` from that run's sent questions), `models`, and `cost` (`cost_usd`, `runs` and `unknown_cost_runs` over runs with this `experiment_id`), shaped exactly as in http-api.md
- [X] T032 [US3] Implement `experiment_plan(conn, exp, model, price)` in `jevbench/store.py`: per row, the visible column keys with no ok cell for the resolved model (resolve an alias to the latest `model_used` seen for it in runs, else treat it as "no cells yet"); `estimated_tokens` = the average actual `input_tokens` per request over this experiment's ok runs if any, else `ceil(chars(state + questions)/4)` per request; `estimated_cost_usd`
- [X] T033 [US3] Add routes in `jevbench/server.py`: `GET/POST /api/experiments`, `GET/PUT/DELETE /api/experiments/{id}`, `POST /api/experiments/{id}/duplicate`, `GET /api/experiments/{id}/plan?model=`. `GET /{id}` returns `{experiment, cells, run_costs, models, cost}`, and the 409 from T030 maps to HTTP 409 with a message saying to add a new column or duplicate the experiment
- [X] T034 [US3] Add tests in `tests/test_core.py`: create assigns keys and hashes; a row run via the `POST /api/runs` handler with `experiment_id` fills cells; an **ad-hoc run** (no `experiment_id`) with the same text and wording also fills the cell; with two answers, the latest wins; PUT changing an answered column's wording raises 409 while adding a new column works; `experiment_plan` lists only missing cells after adding a 4th column; invalid label import returns per-row errors
- [X] T035 [US3] Build the Experiments list view in `jevbench/static/app.js` (`#/experiments`): a table of name, type, rows × columns, cost and updated, with New, Duplicate, Delete (confirm) and click-to-open (`#/experiments/<id>`)
- [X] T036 [US3] Build the experiment editor in `jevbench/static/app.js`: name, type (locked once answers exist), shared criteria using the T021 editors (locked once answers exist, with "Duplicate to change"), rows panel (paste one input per line; import `.txt` (lines) or `.csv` with `input,label,tags` headers; show server per-row errors), columns panel ("+ variant", "Duplicate & edit"; editing an answered column's wording creates a new column and offers to hide the old one). Saves via PUT
- [X] T037 [US3] Render the matrix grid in `jevbench/static/app.js` per contracts/ui.md: sticky header with variant key, weight placeholder and wording; cells `fmtProb(v)` + band tag + heat background via `--v`; Choice cell `↯option` marker when `won` is false; Score cell nearest level name; `·` for empty, `!` for failed (error on hover/focus); spread column; footer mean and yes/review/no counts (from `columnStats`). Render rows in pages of 200 with "show more"
- [X] T038 [US3] Implement the grid runner in `jevbench/static/app.js`: "Run missing (N)" → `GET /plan` → a confirm dialog with request count and estimated cost → POST `/api/runs` per row (row's missing columns as questions with IDs = column keys, `experiment_id` set), at most `prefs.concurrency` in flight; fill cells as each returns; on `status=error`, mark the row with the error and a Retry button that re-sends just that row; refresh the experiment cost when done
- [X] T039 [US3] Implement the cell side panel in `jevbench/static/app.js`: clicking or pressing Enter on a cell shows the full answer (all probabilities, confidence, legend), run id, model, row cost and "Open in History" (`#/history?ids=<run_id>`)
- [X] T040 [P] [US3] Add grid styles in `jevbench/static/style.css`: a one-hue sequential heat scale via `color-mix(in oklab, var(--heat-hi) calc(var(--v)*100%), var(--heat-lo))` for light and dark tokens; sticky header and first column; cell focus ring; misclassified outline class `.miss` (used in US5); compact numeric font with `font-variant-numeric: tabular-nums`

**Checkpoint**: Matrices can be designed, run and read. US1–US3 work independently

---

## Phase 6: User Story 4 - Reshape the analysis live without re-running (Priority: P1)

**Goal**: Threshold, weights/composite, pivot/sort/filter, cost overlay and named views, all with zero requests.

**Independent Test**: On a filled grid, move the threshold, set weights, sort by spread, pivot and toggle cost. History has no new runs and the cost is unchanged. Save view "strict 0.9", restart, switch to it: everything is restored.

- [X] T041 [US4] Add pure exports to `jevbench/static/metrics.js`: `composite(values, weights)` (weighted mean over present values, null when Σw = 0); `agreement(rowBands)` (share of rows where all visible columns share a band); `costShare(runCost, lens, colKey)`; and `applyView(exp, cells, runCosts, view)` → `{rows: [{key, input, label, values: {col: {v, band, won, level, runId}}, composite, spread}], columns: [{key, stats}], compositeStats}`. `applyView` applies the model selection, hidden columns, per-column threshold override, weights (`view.weights_override` or column weights), filters (labeled/unlabeled, review only, `spread_min`, tags, text), sort (`by` column/composite/spread/label/input, `dir`), and pivot (transpose rows and columns)
- [X] T042 [US4] Add tests in `tests/metrics.test.mjs`: weights 1,1,0 → composite = mean of the first two; all weights 0 → null; per-column override changes only that column's bands; sort by spread desc; `spread_min` filter; pivot preserves every value; cost shares of a row sum to the row cost; `applyView` on a synthetic 500 × 10 grid finishes in < 50 ms
- [X] T043 [US4] Build the dashboard toolbar in `jevbench/static/app.js`: a two-handle threshold (two `<input type=range>` with numeric fields, low < high enforced); a per-column header menu (override threshold, hide); a per-column weight field (0–5, step 0.5); sort select + direction; filters (labeled select, review only, spread ≥, tag select, text); a hidden-columns list; Pivot toggle; Values/Cost toggle (cells show row cost and tokens, headers "≈ share"); Model select including "compare" (column groups per model); Focus option select (Choice). Every control re-renders from `applyView` with **no fetch**
- [X] T044 [US4] Implement view persistence in `jevbench/static/app.js`: debounce (500 ms) a PUT of `view` on every control change; a views dropdown with "Save view…", rename and delete that writes `views[name]`; switching a view replaces `view` and re-renders; "Reset view" restores the default view
- [X] T045 [US4] Show the dashboard header summary in `jevbench/static/app.js`: name · type · rows × variants · model · experiment cost; in Cost mode, total cost and cost per row
- [X] T046 [US4] Browser check of US2–US4 with the Playwright MCP tools (same server setup as the US1 check): guide card changes with type, Compare dialog shows 4 cards, Box with no image disables Run (step 2). Create the 10 × 3 "apple-wording" experiment, confirm the estimate, wait for all cells, add a 4th variant and assert the plan shows exactly 10 requests (step 3). Record `GET /api/runs` `total` and `GET /api/totals`, then move the threshold, set a weight to 0, sort by spread, pivot, toggle Cost, and assert both values are **unchanged** (step 4). Save view "strict 0.9", restart the server, reload and switch to it; assert the controls are restored. Screenshot the grid (values, cost overlay, pivot) to `.checks/us4-*.png`. Append results to `.checks/REPORT.md`

**Checkpoint**: The dashboard is fully adaptable. US1–US4 (all P1) are done

---

## Phase 7: User Story 5 - Labels and accuracy (Priority: P2)

**Goal**: Optional expected answers per row, with live accuracy, confusion, best threshold and calibration per column and composite.

**Independent Test**: Label 6 of 10 rows; metrics say `n=6`. Changing a label updates metrics instantly with no request. "use" applies the best threshold.

- [X] T047 [US5] Add pure exports to `jevbench/static/metrics.js`: `labelMetrics(points, type, t)` where `points = [{v, label, focus?, score?}]` over labeled rows. It returns `{n, accuracy, reviewRate, tp, tn, fp, fn, review, brier | mae}`: truth = `label==="yes"` (Noul) or `label===focus` (Choice); accuracy is over decided rows; Score uses `round(score)===label` and MAE in levels. Also `bestThreshold(points, type)`: evaluate accuracy at each unique value as `low=high=t`, ties broken by the value closest to 0.5. Wire both into `applyView` (per column and composite, plus `miss: true` on misclassified cells, and a `misclassified` filter)
- [X] T048 [US5] Add tests in `tests/metrics.test.mjs`: unlabeled rows ignored and `n` correct; confusion counts on a hand-made set; review excluded from accuracy; Brier on a known set; Score MAE and accuracy; `bestThreshold` tie-breaking; `misclassified` filter
- [X] T049 [US5] In `jevbench/static/app.js`, add a label column with an inline select per row (Noul yes/no/—, Choice options/—, Score levels/—), saved through the debounced PUT; footer rows `acc (n) · review`, `best thr · Brier|MAE` with a `[use]` button that sets the view threshold to `low=high=best`; `.miss` outline + "✕" glyph on misclassified cells; the "misclassified" filter; no-label mode hides those rows and shows `agreement` instead
- [X] T050 [US5] Add tests in `tests/test_core.py` for label validation in `create_experiment`/`update_experiment`: Noul accepts only yes/no/null, Choice only option keys, Score only `0…N-1`, with per-row error indexes

**Checkpoint**: Labeled experiments show which wording (or composite) decides best

---

## Phase 8: User Story 7 - See costs per task and in total (Priority: P2)

**Goal**: Session, experiment and all-time totals; an editable price.

**Independent Test**: 3 single runs and a 5 × 2 grid: the session total = the sum of runs, and the experiment total = the sum of its rows.

- [X] T051 [US7] Implement `totals(conn, session_start)` in `jevbench/store.py` → `{session, all_time}`, each `{runs, cost_usd, unknown_cost_runs}` (unknown = ok runs with null cost), and the `GET /api/totals` route in `jevbench/server.py`
- [X] T052 [US7] Add tests in `tests/test_core.py`: totals equal the sums; null-token runs are counted in `unknown_cost_runs` and excluded from the sum; changing `price_per_mtok` does not change the cost of existing runs
- [X] T053 [US7] In `jevbench/static/app.js`, show header totals (`session $… · N runs`, all-time on hover/expand, "N unknown" when > 0) refreshed after every run and grid row
- [X] T054 [US7] Build the Settings view in `jevbench/static/app.js` (`#/settings`): theme, text size, probability format + decimals, default model, price per Mtok (with a note that it applies to new runs only), parallelism, and "Reset to defaults" (confirm). It saves via `PUT /api/prefs` and applies theme and scale immediately

**Checkpoint**: Costs are visible everywhere

---

## Phase 9: User Story 8 - Collect, review and export task data (Priority: P2)

**Goal**: A History browser with filters, edit/delete, reopen in editor, run export (CSV/JSONL) and matrix export.

**Independent Test**: Make runs, restart, filter by experiment, and export runs CSV (one row per question) and a matrix CSV (as displayed + metrics).

- [X] T055 [US8] Implement `list_runs(conn, filters, limit, offset) -> {total, runs}` (filters `type` via an `EXISTS` on `answers.type` or the questions JSON, plus `model`, `status`, `tag`, `experiment_id`, `q` LIKE over input/questions/note, `from`, `to`, `ids`; newest first; limit ≤ 500), `patch_run(conn, id, note, tags)` and `delete_run(conn, id)` in `jevbench/store.py`
- [X] T056 [US8] Implement `export_runs(conn, filters, fmt)` in `jevbench/store.py`. JSONL: one full run per line. CSV: one row per (run × question) with exactly the http-api.md columns, where `result` = noul / choice / score / `top,bottom,left,right` and `probabilities` = JSON text. Use the `csv` module with a UTF-8 BOM so Excel opens it correctly
- [X] T057 [US8] Add routes in `jevbench/server.py`: `GET /api/runs` (query params → filters), `PATCH /api/runs/{id}` (`note` and `tags` only), `DELETE /api/runs/{id}` → 204, `GET /api/export?format=csv|jsonl&…` with `Content-Disposition: attachment; filename=jevbench-<YYYY-MM-DD>.<ext>`
- [X] T058 [US8] Add tests in `tests/test_core.py`: each filter narrows correctly; PATCH ignores other fields; DELETE cascades answers; CSV has one row per question with the exact header; JSONL round-trips `get_run`
- [X] T059 [US8] Build the History view in `jevbench/static/app.js` (`#/history`, honoring `?ids=`): filter bar (type, model, status, experiment, tag, text, date range); paged list (50) with checkboxes; detail panel (input, questions, rendered answers via the T022 renderers, cost, note/tags editing, delete with confirm, "Open in editor" pre-filling the Run view); Export CSV / JSONL for the selection or the current filter
- [X] T060 [US8] Implement matrix export in `jevbench/static/app.js`: from the current `applyView` result, build CSV rows `input, label, tags, <visible variant values…>, composite, spread`, then a blank line and a metrics block per column (`mean, yes, review, no, n, accuracy, review_rate, best_threshold, brier|mae`), and download it as `<experiment>-<view>.csv` via a Blob (depends on T041 and T047)

**Checkpoint**: Data is collected, browsable and exportable

---

## Phase 10: User Story 6 - Build a matrix from saved History (Priority: P2)

**Goal**: Turn selected or filtered runs into an experiment at no cost.

**Independent Test**: 2 inputs × 3 wordings as single runs → History → select → Open as matrix (Noul) → a filled 2 × 3 grid with $0 added.

- [X] T061 [US6] Implement `experiment_from_runs(conn, name, run_ids | filters, type)` in `jevbench/store.py`. Collect the selected ok runs; rows = distinct inputs by `input_hash` (first-seen order); among that type's questions, pick the most common `criteria` and use the distinct `instructions` with that criteria as columns; return the created experiment plus `skipped: {other_types, other_criteria}`. It never calls Jev
- [X] T062 [US6] Add the route `POST /api/experiments/from-runs` in `jevbench/server.py`
- [X] T063 [US6] Add tests in `tests/test_core.py`: 6 runs (2 inputs × 3 Noul wordings) → a 2 × 3 experiment whose `experiment_cells` is fully filled; `FakeClient` call count unchanged; mixed types and criteria report correct `skipped` counts
- [X] T064 [US6] In `jevbench/static/app.js`, add a History "Open as matrix" action (selection or current filter) → a dialog with name + type (only types present in the selection, with counts) → POST → navigate to the new dashboard; show the skipped counts; the dashboard's "Run missing (N)" covers empty cells (depends on T059)
- [X] T065 [US6] Browser check of US5–US8 with the Playwright MCP tools: label 6 rows and assert the footer shows `n=6`; click `[use]` and assert the bands change; use the misclassified filter (step 5). Make 6 single runs, then History → select → Open as matrix and assert a filled 2 × 3 grid with all-time cost unchanged (step 6). Totals match (step 7). Restart and assert experiments, labels and views persist; export the runs CSV and the matrix CSV and assert their headers (step 8). Screenshots to `.checks/us6-*.png`. Append results to `.checks/REPORT.md`

**Checkpoint**: All P2 stories are done

---

## Phase 11: User Story 9 - Box on an image (Priority: P3)

**Goal**: Single-run Box with an overlay and a one-click presence check.

**Independent Test**: An apple photo with Box ``the apple in `image` `` shows a rectangle on the image; "Add presence check" adds a Noul.

- [X] T066 [US9] In `jevbench/static/app.js`, enable Box in the Run view type select only when the selected model does not start with `jev-1.13` (aliases allowed); add a Box result renderer (the attached image, or `/api/images/<sha>` in History, with an absolutely positioned `<svg viewBox="0 0 100 100" preserveAspectRatio="none">` rect from `left/top/right/bottom × 100`, plus confidence); an "Add presence check" button that appends a Noul ``Is there <instructions target> in `image`?``
- [X] T067 [US9] Add tests in `tests/test_core.py`: a Box run with an image stores the image file and the answer, and Box is rejected without an image or on `jev-1.13.0`
- [X] T068 [P] [US9] Add Box overlay styles in `jevbench/static/style.css` (relative image wrapper, rect stroke from an accent token, no fill)

**Checkpoint**: All user stories are complete

---

## Phase 12: Polish & Cross-Cutting Concerns

- [X] T069 Keyboard and accessibility pass in `jevbench/static/app.js` and `jevbench/static/style.css`: arrow-key cell navigation in the grid with roving tabindex, Enter opens the cell panel; global `Ctrl+N` (new run or experiment, depending on view) and `Ctrl+H` (History); `aria-label`s on icon-only buttons and band tags; contrast check of light and dark tokens (≥ 4.5:1 for text)
- [X] T070 Offline handling in `jevbench/static/app.js`: a network failure on `/api/runs` shows "offline / cannot reach server" without breaking the view; the guide, History and dashboard analysis keep working
- [X] T071 [P] Write a short `README.md` at repo root: what it is, the 3-line launch from quickstart.md, where data lives, and the two test commands
- [ ] T072 Final verification: run `uv run python -m unittest discover -s tests`, `node --test "tests/*.test.mjs"`, and the live smoke `JEVBENCH_LIVE=1 uv run python -m unittest tests.test_core.LiveSmoke`. Then, with the Playwright MCP tools, re-run the US1, US4 and US6 browser checks on a fresh `.checks/data` and add quickstart step 9 (attach a small PNG, Box, assert an SVG rect is visible inside the image bounds, click "Add presence check" and assert a Noul was added). Fix any failure; summarize `.checks/REPORT.md` in the PR description

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)** → **Foundational (Phase 2)** → user story phases → **Polish**
- Foundational blocks all stories

### User Story Dependencies

| Story | Depends on | Notes |
|-------|-----------|-------|
| US1 (P1) | Foundational | MVP |
| US2 (P1) | Foundational | Card beside the US1 editor. Works with no API |
| US3 (P1) | Foundational; reuses the US1 criteria editors (T021) and the run endpoint (T018) | |
| US4 (P1) | US3 | Controls act on the grid |
| US5 (P2) | US4 (`applyView`) | |
| US7 (P2) | Foundational | Independent of the matrix |
| US8 (P2) | US1 (runs exist); T060 needs T041 + T047 | |
| US6 (P2) | US3 (experiments, cells); UI T064 needs US8 T059 | Backend T061–T063 only needs US3 |
| US9 (P3) | US1 | |

### Within Each Story

- Pure logic + its tests (`metrics.js`, `store.py`) → routes → UI
- The tests in `test_core.py` / `metrics.test.mjs` for a story should pass before the story's UI task is closed

### Parallel Opportunities

- Setup: T002, T003
- Foundational: T007 + T008 (`jev.py` helpers) in parallel with T014 (html/css); T005–T006 (`store.py`) in parallel with T007–T009
- US1: T023 (css) alongside T021–T022
- US3: T028 + T029 (metrics.js + test) in parallel with T030–T034 (store/server/test_core); T040 (css) anytime in the phase
- US7 can be built in parallel with US3–US5 (different store functions, header/settings UI)
- US9 backend test T067 and css T068 in parallel

---

## Parallel Example: User Story 3

```bash
# Frontend pure logic and backend experiments at the same time:
Task: "T028 Implement cellValue/band/spread/columnStats in jevbench/static/metrics.js"
Task: "T029 Tests for those in tests/metrics.test.mjs"
Task: "T030 Implement experiments CRUD + invariants in jevbench/store.py"
Task: "T040 Grid heat-scale styles in jevbench/static/style.css"
```

---

## Implementation Strategy

### MVP First (US1)

1. Phase 1 → Phase 2 → Phase 3 (US1)
2. **Stop and validate**: quickstart step 1. You can already test propositions and see cost

### Incremental Delivery

1. + US2 → the guide
2. + US3 → matrices (the main analysis value)
3. + US4 → live adaptation. **All P1 stories are done here**, so this is the point to demo
4. + US5 labels → + US7 cost totals → + US8 History/export → + US6 History→matrix
5. + US9 Box → Polish

### Notes

- Commit after each task or checkpoint (`/speckit-git-commit`)
- Never add a dependency beyond `typesafe-sdk`. Charts are divs and SVG, tests are stdlib and `node:test`
- Deliberate ceilings are already listed in plan.md → Complexity Tracking. Mark them in code with `# ponytail:` comments where they occur (write lock, LIKE search, chars/4 estimate, cost share)
