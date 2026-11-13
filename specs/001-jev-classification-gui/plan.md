# Implementation Plan: Jev Classification Workbench (local GUI)

**Branch**: `001-jev-classification-gui` | **Date**: 2026-11-13 (rev 2) | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/001-jev-classification-gui/spec.md`

## Summary

A local workbench for Jev's **four** question types (Noul, Choice, Score, Box; the brief assumed three). Its center is an **experiment dashboard**: a *wording variants × inputs* matrix. Its analysis adapts live: two-handle threshold bands, weighted composite of variants, pivot/sort/filter, cost overlay, optional labels with accuracy, confusion, best threshold and calibration, and saved named views. Matrices are designed and run (one request per row, all variants batched), or assembled from saved History at no cost. A single-run editor, type guide cards, per-run and total costs, and exportable History remain.

Technical approach: one terminal command starts a stdlib Python HTTP server on 127.0.0.1 that wraps the official `typesafe-sdk` and a SQLite file, and opens a static HTML/JS/CSS page. Cells are found by content hash (input × question wording × model). All analysis runs in the browser as pure functions over cells fetched once.

## Technical Context

**Language/Version**: Python ≥ 3.11 (3.13 installed) for the server; vanilla ES2022 modules + CSS for the page

**Primary Dependencies**: `typesafe-sdk`. Everything else is stdlib (`http.server`, `sqlite3`, `json`, `csv`, `hashlib`, `webbrowser`, `argparse`).

**Storage**: SQLite `~/.jevbench/jevbench.db` (tables `runs`, `answers`, `experiments`, `prefs`) + hash-named image files. See [data-model.md](data-model.md).

**Testing**: `python -m unittest` (`tests/test_core.py`, fake Jev client) + `node --test` (`tests/metrics.test.mjs`, Node 22 installed); manual UI pass via [quickstart.md](quickstart.md)

**Target Platform**: Desktop (Windows primary; macOS/Linux), modern browser

**Project Type**: Local web app (CLI-launched server + static page in one package)

**Performance Goals**: Single run in < 3 s. A 50 × 5 grid in < 1 min (4 parallel row requests). Live controls on 500 × 10 in < 0.2 s with zero requests.

**Constraints**: Localhost-only bind; the API key stays server-side; analysis, guide and History work offline; answered wording is immutable; never color-only encoding

**Scale/Scope**: 1 user; experiments ≤ ~1k rows × ~20 variants; 5 views; ~14 routes; 4 Python modules + 2 JS modules

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is still the unfilled template, so no ratified gates exist. **Result: PASS (no gates defined).** Implicit defaults are applied: simplicity (one dependency, no framework, no build), testability (one Python check and one JS check covering the money, data and analysis paths), and trust-boundary safety (localhost bind, server-side key, validation before calling Jev, server-enforced experiment invariants).

*Post-design re-check (rev 2)*: PASS. The dashboard adds one table and one JS module, no new dependency. Run `/speckit-constitution` to add real gates.

## Project Structure

### Documentation (this feature)

```text
specs/001-jev-classification-gui/
├── spec.md              # rev 2 (dashboard clarifications)
├── plan.md              # this file
├── research.md          # Phase 0 (R1–R13)
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/
│   ├── cli.md
│   ├── http-api.md
│   └── ui.md            # dashboard layout, controls, rendering
├── checklists/requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
pyproject.toml           # name=jevbench, deps=[typesafe-sdk], scripts: jevbench = "jevbench.__main__:main"
jevbench/
├── __init__.py
├── __main__.py          # argparse, key lookup, start server, open browser
├── server.py            # ThreadingHTTPServer, route table, static files, JSON helpers
├── jev.py               # validate questions, build state (+Image), call SDK, hashes, cost
├── store.py             # schema; runs+answers; experiments (invariants, from-runs, cells by hash, plan); totals; prefs; export; corrupt-DB recovery
└── static/
    ├── index.html
    ├── app.js           # views: Run, Experiments, Dashboard, History, Settings; guide content; grid runner
    ├── metrics.js       # pure: value, band, spread, composite, agreement, label metrics, best threshold, cost share
    └── style.css        # theme variables, heat scale, grid
tests/
├── test_core.py
└── metrics.test.mjs
```

**Structure Decision**: A single Python package with bundled static assets. `metrics.js` is split from `app.js` because it is the only frontend code with non-trivial logic, and keeping it pure lets Node test it without a browser.

## Key Design Decisions (see [research.md](research.md))

1. **Four types**. Box is single-run only and gated on model ≥ 1.14 and an attached image. Experiments use Noul, Choice or Score.
2. **One request per row** in grids. Variants are independent questions (Jev guarantees no cross-question context), so wording comparisons stay clean and the state is billed once per row (R6).
3. **Content-hash cells** (`input_hash × question_hash × model`). This gives History→matrix for free and lets ad-hoc runs fill matching cells (R11).
4. **Immutable answered wording**: an edit creates a new column, and the server returns 409 otherwise. Type and criteria are fixed after the first answer (duplicate the experiment to change them).
5. **Analysis in the browser** (`metrics.js`): every control is request-free and instant (R12). View state autosaves (debounced PUT), and named views are stored in the experiment document (R13).
6. **Cost** is computed locally from reported tokens × the stored price. Per-column cost is an estimate (usage is per request), and unknown tokens are never shown as 0.
7. **Display prefs trimmed** to theme, text size and number format. Adaptation lives in the analysis.

## Complexity Tracking

No violations to justify.

| Deliberate simplification | Ceiling | Upgrade when |
|---------------------------|---------|--------------|
| Stdlib `http.server` | Single user, localhost | Remote/multi-user is needed (move to ASGI) |
| Experiment as one JSON doc, full PUT | ~1k rows; last write wins across tabs | Experiments grow past that, or multi-tab editing matters (normalize rows/columns) |
| `LIKE` search in History | ~100k runs | It slows (SQLite FTS5) |
| chars/4 estimate before the first run | Rough first estimate | TypeSafe exposes token counting |
| Per-column cost by instruction-length share | Estimate, not billing truth | Exact per-variant cost matters (run one request per cell at higher cost) |
| Only the *variants × inputs* matrix | Other matrix kinds not in v1 | Types × intent or full confusion views are wanted (new view over the same cells) |
