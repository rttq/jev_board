---

description: "Task list for JSON Library (inputs and questions)"
---

# Tasks: JSON Library (inputs and questions)

**Input**: Design documents from `specs/002-json-upload/`

**Prerequisites**: plan.md, spec.md (clarified), research.md (R1–R10), data-model.md, contracts/ (http-api.md, ui.md), quickstart.md

**Tests**: Included, because plan.md and quickstart.md require them, and SC-003 calls for a test set of at least 20 files. As in 001, they go only into the two existing files: `tests/test_core.py` (new `TestLibrary` class, fixtures written to a temp data dir) and `tests/metrics.test.mjs` (new cases). Each story adds its cases there.

**Organization**: Grouped by user story in spec priority order: US1, US2 (P1), then US3, US4, US5 (P2). Parsing is the base of every story, so strict reading is foundational. US5 adds the remaining checks and the full fixture set.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1–US5 from spec.md
- Most tasks touch `jevbench/library.py`, `jevbench/static/library.js` or `jevbench/static/app.js`, so `[P]` is used only where the files really differ

## Path Conventions

Existing package at repo root: `jevbench/` (server + `jevbench/static/` page) and `tests/`. See plan.md → Project Structure. The library root is `<data_dir>/json/{inputs,questions}/`, where `data_dir` is `ctx["data_dir"]` in `jevbench/server.py`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create the new files and the dialog element

- [X] T001 Create `jevbench/library.py` with a module docstring ("Read-only JSON library: listing, path containment, strict parsing, analysis") and the constants `KINDS = ("inputs", "questions")` and `MAX_BYTES = 1_048_576`
- [X] T002 [P] Create `jevbench/static/library.js` exporting a stub `openLibrary(place, onLoad)`, where `place` ∈ `run-input`, `run-questions`, `exp-input`, `exp-questions`. It imports `h`, `api`, `confirmDialog` from `./app.js`
- [X] T003 [P] Add `<dialog id="lib" class="lib" aria-labelledby="lib-title"></dialog>` next to the existing `<dialog id="dlg">` in `jevbench/static/index.html`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Folder listing, safe paths, strict reading, the three routes, and the picker shell. Every story needs these.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [X] T004 In `jevbench/library.py`, implement `root(data_dir, kind)`. It raises `ValueError` for an unknown kind, creates both `<data_dir>/json/inputs` and `<data_dir>/json/questions` with `mkdir(parents=True, exist_ok=True)`, and returns the kind's `Path`
- [X] T005 In `jevbench/library.py`, implement `resolve(data_dir, kind, rel)`. It rejects an empty path, an absolute path, a drive letter, or a path whose `(root / rel).resolve()` is not `is_relative_to(root.resolve())`, raising `ValueError("path must stay inside the library folder")`. It also rejects a suffix other than `.json` (case-insensitive) the same way. It returns the resolved `Path`, and raises `FileNotFoundError` when the path is not a regular file (research R4)
- [X] T006 In `jevbench/library.py`, implement `list_files(data_dir, kind)` → `{kind, folder, files}`, per contracts/http-api.md. It uses `rglob("*.json")` (case-insensitive suffix check) and keeps only regular files whose resolved path stays inside the root. Each entry is `{path: posix relative, size, mtime: ISO local seconds, too_large: size > MAX_BYTES}`, sorted by `path.lower()`
- [X] T007 In `jevbench/library.py`, implement `load_strict(data: bytes)` → `(value, warnings)`, raising `LibraryError(message, line=None, col=None)` (a new exception class in the same file). It decodes with `utf-8-sig` and raises "file is empty" for blank text. It calls `json.loads` with `object_pairs_hook` (builds a dict and records duplicate keys), `parse_int` (keeps exact `int`) and `parse_constant` (raises). It maps `JSONDecodeError` to `LibraryError(e.msg, e.lineno, e.colno)`. US5 extends the hooks into full warnings
- [X] T008 In `jevbench/library.py`, implement `analyze(data_dir, kind, rel)`. It calls `resolve`, then `stat`. Above `MAX_BYTES` it returns `ok: false` with "file is X MB; the limit is 1 MB". Otherwise it reads the bytes and calls `load_strict`. It returns the analysis dict from data-model.md (`path, kind, size, mtime, ok, error, warnings, pretty`), where `pretty = json.dumps(value, indent=2, ensure_ascii=False)` and `error = {message, line, col}` on `LibraryError`. It then dispatches to `_inputs(value)` / `_questions(value)`, which are stubs here that return `{}` and are filled by US1 / US4
- [X] T009 In `jevbench/library.py`, implement `reveal(data_dir, kind)`. It calls `root`, then `os.startfile` on Windows, `subprocess.Popen(["open", p])` on macOS, or `["xdg-open", p]` otherwise, and returns `{folder}`. It lets `OSError` propagate (research R8)
- [X] T010 In `jevbench/server.py`, add handlers and routes per contracts/http-api.md:
  - `("GET", r"/api/library/(inputs|questions)", …)` → `list_files`.
  - `("GET", r"/api/library/(inputs|questions)/file", …)` reads `query["path"]`. It maps `ValueError` to `ApiError(400, msg, "path")` and `FileNotFoundError` to `ApiError(404, "file not found", "path")`.
  - `("POST", r"/api/library/(inputs|questions)/reveal", …)` maps `OSError` to `ApiError(500, f"could not open the folder: {e}")`.

  Import `library` next to `jev, store`, and check how existing handlers read `query` (`parse_qs` lists) before writing these
- [X] T011 [P] In `tests/test_core.py`, add `class TestLibrary(Base)`, with a helper `write(kind, rel, data: bytes|str)` that writes into the temp data dir (Base's `data_dir`). Add tests for:
  - listing creates both folders, lists nested `.json` only, sorts, and flags `too_large`;
  - `resolve` rejects `../x.json`, an absolute path, `x.txt`, and a symlink pointing outside (skip with `unittest.skip` if `os.symlink` raises on Windows);
  - a syntax error returns `ok: false` with `line`/`col`;
  - a BOM file loads;
  - the routes return 400/404 through `server.dispatch` (or however existing tests call routes)
- [X] T012 In `jevbench/static/library.js`, implement the dialog shell per contracts/ui.md:
  - It fetches `GET /api/library/{kind}` and renders the header (folder path, **Open folder** → `POST …/reveal` with the error shown inline, **Refresh**) and a `role="listbox"` file list. Each entry shows path, size and text tags `TOO LARGE (limit 1 MB)` / `INVALID` (INVALID is added after its analysis is fetched), and the empty state is "No JSON files in this folder yet".
  - Selecting a file (click or Up/Down) fetches `…/file?path=`; the last request wins.
  - The preview area has a warnings list, a tab bar (Raw always present: `<pre>` of `pretty`) and an error box ("message · line L, column C").
  - The footer has Cancel and a confirm button, disabled with a `title` when `ok` is false. Confirm re-fetches the file, shows "the file was removed" on 404, and otherwise calls `onLoad(analysis, extra)` and closes.
  - `lastFile[place]` is kept in module memory and preselected.
  - Open with `showModal()`. Focus goes to the list. On close, focus returns to `document.activeElement` captured at open.
- [X] T013 [P] In `jevbench/static/style.css`, add the picker layout: two columns (list | preview) that stack below 700px, list item selected state, and tree indentation via `--depth`. Reuse the existing tag classes for `TOO LARGE`, `INVALID`, `PARTIAL`, `VALID`, and theme variables only (dark mode works through them)

**Checkpoint**: The picker opens from a temporary call (`openLibrary("run-input", console.log)` in the console). It lists files, shows raw content and syntax errors with line/column, and refuses paths outside the folder.

---

## Phase 3: User Story 1 - Load a prepared input file into the Run view (Priority: P1) 🎯 MVP

**Goal**: Load JSON in the Run view's Input panel fills Fields (JSON) with the file's object, or with one picked record of a list file.

**Independent Test**: With one object file and one list file in `data/json/inputs/`, load each in the Run view (record 3 of the list) and confirm the Input panel shows exactly that object and a run sends it unchanged.

### Tests for User Story 1

- [X] T014 [P] [US1] In `tests/test_core.py` `TestLibrary`, add tests:
  - an object file → `inputs.shape == "object"`, 1 record, identical to the file (key order, Cyrillic, nested lists, null/bool/float/int types);
  - a list of 3 objects → `shape "list"`, 3 records in order;
  - `[]` → `ok: false` "the file holds no records";
  - `[{}, 5]` → `ok: false` naming item 2 as a number;
  - top-level `"text"` → `ok: false` "top level is a text…"
- [X] T015 [P] [US1] In `tests/metrics.test.mjs`, add `recordSummary` tests:
  - the first non-empty text is found depth-first with its key prefix (`{ticket:{priority:2, subject:"Refund"}}` → `subject: Refund`);
  - the result is cut to 80 characters with `…`;
  - with no text, compact JSON is returned;
  - `{}` → `{}`

### Implementation for User Story 1

- [X] T016 [US1] In `jevbench/library.py`, implement `_inputs(value)` → `(inputs_dict, warnings)`. An object gives 1 record and a non-empty list of objects gives n records; every other shape raises `LibraryError` with the data-model.md messages. Type names use `text`, `number`, `boolean`, `null`, `list`, `object`. Add the warning "record N has no fields" for `{}`. Set `fields: []` and `depth: 0` for now (US2 fills them)
- [X] T017 [P] [US1] In `jevbench/static/metrics.js`, add `export function recordSummary(fields)` per research R10. Keep it pure and DOM-free
- [X] T018 [US1] In `jevbench/static/library.js`, add the record selector for `place === "run-input"` with `shape === "list"`:
  - a search `<input>` (matches the record number, or text in `recordSummary`) and a `<select>` of matching `#n · summary`, capped at 200 with a "refine the search" note;
  - the confirm label is "Load record #n" (or "Load" for object files);
  - `extra = {index}` is passed to `onLoad`
- [X] T019 [US1] In `jevbench/static/app.js` `inputPanel`, add a **Load JSON** button next to "Attach image" that calls `openLibrary("run-input", onLoad)`. `onLoad`:
  - asks `confirmDialog("Replace the input?", "The current input is replaced by the file.", "Replace")` when `draft.text.trim()` (text mode) or `draft.fields` differs from the default `{"text": ""}` stub (JSON mode);
  - then sets `draft.kind = "json"`, `draft.fields = JSON.stringify(records[index], null, 2)` and `draft.errors = {}`, and rerenders;
  - if the record has a top-level `image` key and `draft.image` is set, shows a non-blocking hint that the attached image replaces that field. Check `jev.build_state` in `jevbench/jev.py` first to confirm which value wins, and word the hint to match

**Checkpoint**: US1 works on its own: files load into the Run view and run unchanged.

---

## Phase 4: User Story 2 - See what an input file contains before using it (Priority: P1)

**Goal**: The Structure tab shows every field's path, type, sample and presence count, with one-click path copy.

**Independent Test**: Select a nested list file. Every field appears with the correct path, type, sample and count, and the copy control copies e.g. `ticket.subject`.

### Tests for User Story 2

- [X] T020 [P] [US2] In `tests/test_core.py` `TestLibrary`, add field-tree tests:
  - `{"ticket":{"subject":"Refund","priority":2,"tags":["billing"]}}` gives exactly the four descriptors in contracts/http-api.md (paths, types, samples, `items {n:1, type:"text"}`);
  - in a 3-record list missing `priority` in one, `count == 2` for `ticket.priority`;
  - `messages[].author` comes from a list of objects;
  - a value that is a number in one record and text in another gives `type: "mixed"` with `types`;
  - `depth` is 3 for the ticket example

### Implementation for User Story 2

- [X] T021 [US2] In `jevbench/library.py`, implement the field walk used by `_inputs`:
  - walk each record depth-first and keep an ordered dict `path → descriptor`;
  - descend into list items with `path + "[]"`;
  - `count` = records containing the path (count once per record);
  - `sample` = first scalar seen;
  - `items` = `{n, type}` from the first list seen, where `type` is the single item type or `mixed`;
  - also compute `depth`. Fill `inputs.fields` and `inputs.depth`
- [X] T022 [US2] In `jevbench/static/library.js`, add the **Structure** tab for `kind === "inputs"`, the default tab when `ok`:
  - the summary line "shape · N records · F fields · depth D";
  - rows indented by path depth, showing the path tail, type ("list of text (1)" for lists), sample (one line, CSS ellipsis, with a "show all" toggle for long text), and `count/N` tagged `PARTIAL` when `count < N`;
  - a **⧉** button (`aria-label="Copy path ticket.subject"`) that calls `navigator.clipboard.writeText(path)` and announces "Copied <path>" in an `aria-live="polite"` region;
  - when there are more than 200 descriptors, objects render as collapsed `<details>`

**Checkpoint**: US1 and US2 both work. The MVP is complete: load inputs and understand their structure.

---

## Phase 5: User Story 3 - Add input files to an experiment (Priority: P2)

**Goal**: Load JSON in experiment Setup appends one row per record, and JSON rows show a readable label in the matrix.

**Independent Test**: Load a 25-object list file into an experiment. 25 rows are added, labelled with summaries, and the matrix run sends each object unchanged.

### Tests for User Story 3

- [X] T023 [P] [US3] In `tests/test_core.py` `TestLibrary`, add a test that creates an experiment through the existing store API with rows `[{input: {kind: "json", fields: r}} for r in records]` taken from `library.analyze` on a list fixture. The stored rows must equal the records, and a repeated record must merge with the existing warning. This guards the mapping in data-model.md

### Implementation for User Story 3

- [X] T024 [US3] In `jevbench/static/experiments.js` Setup "Add inputs" row, add a **Load JSON** button next to "Import .txt / .csv" that calls `openLibrary("exp-input", onLoad)`. `onLoad`:
  - records `before = S.exp.rows.length`;
  - calls `saveDoc({ rows: [...S.exp.rows, ...records.map(f => ({ input: { kind: "json", fields: f } }))] })`;
  - on success sets `S.setupMsg` to "N rows added" (N = new length − before) plus " · M merged as repeats" (M = records.length − N) when M > 0. If `S.exp.reference` is set and any record has a top-level `reference` key, it adds "rows with their own `reference` field keep it; the shared reference is not used for them" (a row's field wins, per `jev.with_reference`);
  - finally calls `drawAll()`
- [X] T025 [US3] In `jevbench/static/experiments.js`, find where the matrix renders a row's input cell (the `input` string from `applyView` in `metrics.js`). For rows whose `row.input.kind === "json"`, show `recordSummary(row.input.fields)` with `title` = compact JSON. Text rows and sorting/search (which use `inputText`) are unchanged

**Checkpoint**: Experiments take JSON inputs from the library. US1–US3 work independently.

---

## Phase 6: User Story 4 - Load prepared questions (Priority: P2)

**Goal**: Question files preview as cards, load into the Run view (replace or add), and become experiment variants when type and criteria match.

**Independent Test**: Load the quickstart `triage.json` into the Run view (3 questions identical to the file). Load it into a billing/tech/sales Choice experiment: 1 variant is added and 2 are skipped with reasons.

### Tests for User Story 4

- [X] T026 [P] [US4] In `tests/test_core.py` `TestLibrary`, add question-file tests:
  - the quickstart `triage.json` → `ok`, 3 entries in file order, `wire` identical to the file, all `valid`;
  - a Choice with one option → `valid: false` with the `validate_questions` message, while the file stays `ok`;
  - a Box question → `valid: true` with the note "needs an image in the Run view; skipped in experiments";
  - a top-level list → `ok: false`;
  - a question lacking `instructions` → `ok: false` naming its ID;
  - `{"type": "noul", "instructions": "x"}` (unwrapped) → `ok: false` with the expected shape in the message;
  - an unknown type → `ok: false`
- [X] T027 [P] [US4] In `tests/metrics.test.mjs`, add tests:
  - `freeId("urgency", new Set(["urgency"])) === "urgency_2"`, and `_3` when `_2` is taken too;
  - `matchQuestions(exp, questions)` for:
    - an empty experiment (no columns): adopts the type and criteria of the first Noul/Choice/Score question and takes all matching ones;
    - a Choice experiment: keeps the same options in another key order and skips another type ("other type") and other options ("other criteria");
    - Box always skipped ("Box is single-run only");
    - Noul criteria `undefined` vs `null` treated as equal

### Implementation for User Story 4

- [X] T028 [US4] In `jevbench/library.py`, implement `_questions(value)` → `(questions_dict, warnings)`:
  - the structural checks from data-model.md raise `LibraryError`. Detect an unwrapped question by top-level `type` + `instructions` keys, and require `type` in `jev.TYPES` (check the constant's name in `jevbench/jev.py`);
  - per question, `errors = [e["error"] for e in jev.validate_questions({qid: wire}, True, "jev-latest")]`, with `valid = not errors`;
  - `notes` gets the Box note.

  Also add the US5 heuristic hook point: `_inputs` warns "looks like a question file; move it to questions/" when every top-level value is a dict with `type` and `instructions`
- [X] T029 [P] [US4] In `jevbench/static/metrics.js`, add:
  - `export function freeId(id, taken)`;
  - `export function matchQuestions(exp, questions)` → `{ type, criteria, columns: [{ instructions }], skipped: [{ id, reason }] }`. `exp` is `{type, criteria, columns}`, and `questions` is the `{id: {wire}}` map from the analysis. The canonical comparison sorts object keys recursively and keeps list order, and treats `null` and `undefined` criteria as equal. Type and criteria are adopted only when `exp.columns.length === 0`
- [X] T030 [US4] In `jevbench/static/library.js`, add the **Questions** tab for `kind === "questions"`: one card per question with the ID, a type tag, the wording (pretty-printed JSON when it is not a string), the criteria (Choice: option — description; Score: numbered levels; Noul: yes means / no means), a `VALID` or `INVALID` tag with errors, and notes. For `place === "exp-questions"`, take an `exp` passed through `openLibrary(place, onLoad, { exp })` and show "Will be skipped" with reasons from `matchQuestions`. Confirm labels per contracts/ui.md ("Load n questions" / "Add k variants"), with confirm disabled when k = 0
- [X] T031 [US4] In `jevbench/static/app.js`:
  - add `export function choiceDialog(title, body, buttons)`, which resolves with the clicked button's value, or `null` on Cancel/Escape. Build it on `#dlg` like `confirmDialog`, and make `confirmDialog` call it so there is one implementation;
  - add a **Load questions** button in the Questions panel header that calls `openLibrary("run-questions", onLoad)`. `onLoad`: when any question has wording, ask `choiceDialog("Load questions", "…", [["replace","Replace"],["add","Add"]])`. Replace sets `draft.questions = Object.entries(qs).map(([id, q]) => fromWire(id, q.wire))`. Add appends the same, renaming with `freeId` against the existing IDs, and lists the renames in a hint. Then set `draft.focus` to the first loaded ID, clear `draft.errors` and rerender. Invalid questions load as they are, and the editor's own validation shows on Run
- [X] T032 [US4] In `jevbench/static/experiments.js` Setup, add a **Load questions** button next to the add-variant button that calls `openLibrary("exp-questions", onLoad, { exp: S.exp })`. `onLoad`:
  - runs `const m = matchQuestions(S.exp, qs)`;
  - calls `saveDoc({ columns: [...S.exp.columns, ...m.columns], ...(S.exp.columns.length ? {} : { type: m.type, criteria: m.criteria }) })`;
  - on success sets `S.setupMsg` to "k variants added" plus "· skipped: id (reason), …" and any merge warnings that `saveDoc` already shows;
  - then calls `drawAll()`. Check that `saveDoc`'s 409/400 path (answered-wording lock, criteria change after answers) surfaces in `S.setupErr` as it does for typed variants

**Checkpoint**: Question files work in both places. US1–US4 work independently.

---

## Phase 7: User Story 5 - Trust that files are read correctly (Priority: P2)

**Goal**: Every rule in data-model.md is enforced with plain messages, and the SC-003 fixture set (at least 20 files) passes.

**Independent Test**: Run `TestLibrary`. Every fixture either loads byte-for-byte equal in value or is rejected with the expected message and location.

### Tests for User Story 5

- [X] T033 [P] [US5] In `tests/test_core.py` `TestLibrary`, add a table-driven test over at least 20 fixtures (including those from earlier tasks), each with its expected `ok`, message substring, line/col and warning substrings:
  - encoding: UTF-8 BOM ok; UTF-16 LE and BE with BOM → "UTF-16"; invalid UTF-8 byte → "not UTF-8" with its position;
  - content: Cyrillic + emoji round trip; `NaN` / `Infinity` → "not valid JSON" with position; duplicate key → warning naming it;
  - numbers: `12345678901234567890` → warning with the rounded value; `1.5e300` ok; `-0` ok;
  - shape: 2000-deep nesting → "nested too deeply"; empty file, whitespace only; `{}` → warning; question-like input → warning;
  - size: a 1 MB + 1 byte file → `too_large` in the listing and `ok: false` in analysis

### Implementation for User Story 5

- [X] T034 [US5] In `jevbench/library.py` `load_strict`:
  - before decoding, check for the UTF-16 LE/BE and UTF-32 BOMs ("file is saved as UTF-16; save it as UTF-8");
  - map `UnicodeDecodeError` to "file is not UTF-8 (first bad byte at position N)";
  - make `parse_constant` raise `LibraryError` "NaN/Infinity is not valid JSON". Get the position by re-scanning the text for the constant outside strings. If that is not exact, use a regex over the decoded text and accept the first match;
  - catch `RecursionError` → "nested too deeply to read";
  - duplicate-key warnings once per key: "key `x` appears twice in one object; the last value is used";
  - `parse_int`: collect values with `abs(v) > 2**53` and warn with up to 5 of them, shown as "v is beyond 2^53 and will be rounded to float(v)" (format the float with `repr`)
- [X] T035 [US5] In `jevbench/static/library.js`, render `warnings` as a list above the tabs with a `⚠` text prefix (not color alone). Make sure `INVALID` tags in the file list come from fetched analyses. Files never selected show no tag, so analyses are not prefetched (research R9)

**Checkpoint**: All five stories are complete, and the validation rules are tested end to end.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [X] T036 [P] Add a "JSON library" section to `README.md`: the two folders, an example input file and question file (from quickstart.md), the 1 MB limit, and that the app never modifies the files
- [X] T037 Keyboard and accessibility pass on the picker in `jevbench/static/library.js`:
  - listbox `aria-activedescendant` with Up/Down/Home/End;
  - Enter confirms when enabled;
  - tabs are `role="tablist"` with arrow-key switching;
  - every status is a text tag;
  - focus returns to the opener on every close path (Cancel, ✕, Escape, confirm)
- [X] T038 Run `uv run python -m unittest discover -s tests` and `node --test "tests/*.test.mjs"`, and fix any failures
- [X] T039 Browser checks 1–10 from `specs/002-json-upload/quickstart.md` with the Playwright MCP tools against `--data-dir .checks/data --port 8799`, using the fixture files listed there. Capture light, dark and phone-width screenshots of the dialog to `.checks/`, and log pass/fail to `.checks/REPORT.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies
- **Foundational (Phase 2)**: Depends on Setup. Blocks all stories
- **US1 (Phase 3)**: Depends on Foundational
- **US2 (Phase 4)**: Depends on Foundational. Its Structure tab is most useful after US1's `_inputs`; T021 extends `_inputs` from T016, so do US1 first
- **US3 (Phase 5)**: Depends on Foundational and T016 (`_inputs` records) and T017 (`recordSummary`). Independent of US2
- **US4 (Phase 6)**: Depends on Foundational only
- **US5 (Phase 7)**: Depends on Foundational. T033 also reuses fixtures from T014, T020 and T026, so it runs best after them
- **Polish (Phase 8)**: Depends on all stories

### Within Each Story

- Tests are written alongside or before the implementation in the same story, and must pass at the checkpoint
- `library.py` changes come before `library.js` changes, which come before the view hooks (`app.js` / `experiments.js`)

### Parallel Opportunities

- T002 and T003 in parallel with T001
- T011 (tests) and T013 (CSS) in parallel with T012 (dialog shell)
- In each story, the `tests/*` task and the `metrics.js` task are `[P]` against the `library.py` / `library.js` tasks
- After Foundational, US4 (questions) can proceed in parallel with US1–US3 (inputs): they touch different functions (`_questions` and `_inputs`), but the same files, so coordinate the edits

---

## Parallel Example: User Story 4

```text
Task: "T026 [US4] question-file tests in tests/test_core.py"
Task: "T027 [US4] freeId / matchQuestions tests in tests/metrics.test.mjs"
Task: "T029 [US4] freeId and matchQuestions in jevbench/static/metrics.js"
# then, sequentially:
Task: "T028 [US4] _questions in jevbench/library.py"
Task: "T030 [US4] Questions tab in jevbench/static/library.js"
Task: "T031 [US4] Run view Load questions in jevbench/static/app.js"
Task: "T032 [US4] Experiment Load questions in jevbench/static/experiments.js"
```

---

## Implementation Strategy

### MVP First (US1 + US2)

1. Phase 1 Setup, then Phase 2 Foundational (the picker lists, reads and rejects safely)
2. Phase 3 US1: load an input into the Run view
3. Phase 4 US2: the structure preview, which is the reason the user asked for the feature
4. **Stop and validate**: quickstart browser checks 1–6

### Incremental Delivery

1. MVP (US1 + US2) → inputs in the Run view, with the structure visible
2. US3 → inputs in experiments
3. US4 → question files in both places
4. US5 → the full validation suite (most rules already block correctly from Phase 2; this adds the precise messages and the 20-file proof)
5. Polish → README, keyboard pass, all checks green
