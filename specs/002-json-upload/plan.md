# Implementation Plan: JSON Library (inputs and questions)

**Branch**: `002-json-upload` | **Date**: 2026-11-14 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/002-json-upload/spec.md`

## Summary

A read-only library of prepared JSON files under `data/json/`, split into `inputs/` (an object, or a list of objects) and `questions/` (`{id: {type, instructions, criteria}}`). Four buttons open one in-app picker dialog:
- **Run view**: Load JSON (Input panel) and Load questions (Questions panel).
- **Experiment Setup**: the same two buttons.

The picker lists the folder and previews the selected file. Input files show a field tree with copyable paths, types, samples and presence counts. Question files show one card per question with its validity. The picker then loads the file into the existing draft or experiment structures.

Technical approach: a new stdlib module `jevbench/library.py` does listing, path containment, strict parsing and analysis (line/column errors, BOM, duplicate keys, big integers, NaN) and reuses `jev.validate_questions`. Three routes expose it. The browser side is one new module `static/library.js` (the dialog), small hooks in `app.js` and `experiments.js`, and three pure helpers in `metrics.js`. Nothing new is stored in SQLite.

## Technical Context

**Language/Version**: Python ≥ 3.11 (server); vanilla ES2022 modules + CSS (page). Unchanged from 001

**Primary Dependencies**: None added. Stdlib `json`, `pathlib`, `os`/`subprocess` (reveal folder); existing `typesafe-sdk` untouched

**Storage**: Read-only files in `<data_dir>/json/{inputs,questions}/`; no schema change. Loaded content goes into the existing run draft and experiment documents

**Testing**: `python -m unittest` (new `TestLibrary` in `tests/test_core.py`, fixture files written to a temp data dir); `node --test` (new cases in `tests/metrics.test.mjs`); agent browser checks per [quickstart.md](quickstart.md)

**Target Platform**: Desktop (Windows primary; macOS/Linux), modern browser

**Project Type**: Local web app (existing package)

**Performance Goals**: List and preview a 1 MB file in < 1 s (SC-002); picker interactions request-free after the analysis arrives

**Constraints**: Never read outside the library roots or write to them; 1 MB per file; offline; no color-only status; keyboard-complete dialog

**Scale/Scope**: Tens to hundreds of files; ≤ 1 MB each (≈ thousands of records); 3 routes, 1 Python module, 1 JS module

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is still the unfilled template, so no ratified gates exist. **Result: PASS (no gates defined).** The implicit defaults from 001 hold:
- **Simplicity**: no new dependency, no new table, reuse of `saveDoc`, `fromWire`, `validate_questions` and `<dialog>`.
- **Testability**: parsing and analysis in one Python module, and pure JS helpers covered by Node.
- **Trust-boundary safety**: the containment check on every path, and a read-only library.

*Post-design re-check*: PASS. The design adds one Python module, one JS module and three routes, all within 001's structure.

## Project Structure

### Documentation (this feature)

```text
specs/002-json-upload/
├── spec.md              # clarified (Q1: separate input/question files; Q2: list → rows / pick one)
├── plan.md              # this file
├── research.md          # R1–R10
├── data-model.md        # analysis shapes, validation rules, mappings
├── quickstart.md        # example files, checks
├── contracts/
│   ├── http-api.md      # /api/library routes
│   └── ui.md            # picker dialog, entry points, load actions
├── checklists/requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
jevbench/
├── library.py           # NEW: roots(), list_files(), resolve(), analyze(), reveal(); strict JSON load, field tree, question checks
├── server.py            # + 3 routes: GET /api/library/{kind}, GET …/file?path=, POST …/reveal
└── static/
    ├── library.js       # NEW: openLibrary(place, onLoad): dialog, list, preview tabs, record selector, lastFile memory
    ├── app.js           # + Load JSON / Load questions buttons in the Run view; loadQuestions(wire, mode); fromWire reused
    ├── experiments.js   # + both buttons in Setup; rows via saveDoc; variants via matchQuestions → saveDoc; row label via recordSummary
    ├── metrics.js       # + recordSummary(fields), matchQuestions(exp, questions), freeId(id, taken)
    └── style.css        # + picker layout, tree indentation, tags
tests/
├── test_core.py         # + TestLibrary
└── metrics.test.mjs     # + 3 helpers
```

**Structure Decision**: One Python module owns everything that touches the disk or decides validity, so the trust boundary and every rule live in one tested place. The dialog gets its own JS module because both views use it and `app.js` is already 640 lines. The pure helpers go in `metrics.js` because Node already tests it without a DOM.

## Key Design Decisions (see [research.md](research.md))

1. **Server-side strict parsing** (R1): line/column errors, duplicate keys, big integers, NaN rejection and BOM handling come from stdlib hooks. The browser never re-parses a library file.
2. **Kind by folder** (R3): `inputs/` and `questions/`. The only content heuristic is a warning when an input file looks like questions.
3. **Containment on every path** (R4): resolve, then `is_relative_to(root)`. Links that point out are neither listed nor read.
4. **In-app `<dialog>`** (R2): gives focus trap and Escape for free, and is the only way to show a preview.
5. **Reuse existing write paths** (R7): experiment rows and variants go through `saveDoc` → `PUT /api/experiments/{id}`, so validation, merging repeats and the answered-wording lock stay in one place.
6. **No cache** (R9): read per request, re-read on confirm.

## Complexity Tracking

No violations to justify.

| Deliberate simplification | Ceiling | Upgrade when |
|---------------------------|---------|--------------|
| Whole file parsed and sent per preview | 1 MB / a few thousand records | Larger files are needed (stream, paginate records) |
| Big integers warned, not kept exact | Values beyond 2^53 are rounded in the browser | Exact IDs as numbers matter (send them as strings, or use a custom transport) |
| Record selector capped at 200 matches | Very large lists need a search | Browsing thousands of records is common (virtual list) |
| Criteria compared canonically (sorted keys) | Choice option order is not compared | Option order turns out to change Jev's answers |
| No "save to library" | Files are made outside the app | Users want to save current inputs or questions from the app |
