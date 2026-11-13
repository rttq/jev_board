# Research: Jev Classification Workbench

All findings were checked against the live TypeSafe docs (docs.typesafe.ai) on 2026-11-13.

## R1. How many Jev question types are there?

- **Decision**: Support all **four**: Noul, Choice, Score, Box.
- **Rationale**: The Primitives and Models pages list four question types. Box was added in Jev 1.14 (released 2026-10-14) and only works on images. `jev-latest` currently resolves to `jev-1.14.0`.
- **Alternatives considered**: Only the three text types. Rejected: the user asked to have the count corrected, and Box costs little extra (one SVG overlay).

## R2. Language and Jev client

- **Decision**: Python ≥ 3.11 with the official `typesafe-sdk` package and its **sync** `TypeSafeClient`.
- **Rationale**: The official SDK already provides typed answers, `usage.input_tokens`, the answering `model`, and retries on 429/529 with backoff (covers the rate-limit edge case for free). It accepts questions as plain dicts with a `type` key, so the browser's question JSON can be passed through unchanged. The machine already has Python 3.13 and uv 0.6.
- **Alternatives considered**: JS SDK + Node (no reason to pick it over Python here). Calling the HTTP API directly from the browser (puts the API key in the page and needs CORS). Rejected.

## R3. GUI shell and terminal launch

- **Decision**: A local web page served by Python's stdlib `http.server.ThreadingHTTPServer`, bound to `127.0.0.1`. The `jevbench` command starts it and opens the browser with stdlib `webbrowser`. The frontend is one static HTML page with vanilla JS and CSS and no build step.
- **Rationale**: Covers "launch through a terminal" + GUI with zero extra dependencies. The API key stays in the Python process. CSS custom properties make deep theming native. Bars are `<div>` widths and the Box overlay is a single `<svg>`, so no chart library is needed.
- **Alternatives considered**:
  - FastAPI/Flask: an extra dependency for about 8 routes. Rejected.
  - Streamlit/Gradio: fast to start but fight "simple style with deep UX adaptation" (limited theming and layout control). Rejected.
  - Tkinter/Qt desktop app: harder theming and accessibility. Rejected.
  - React/Vite: needs a build step for one screen. Rejected.

## R4. Storage

- **Decision**: Stdlib `sqlite3`, one file `<data-dir>/jevbench.db`. Tables: `runs` and `prefs` (a single JSON row). Questions and answers are stored as JSON text inside the run row. Images are stored as files `<data-dir>/images/<sha256>.<ext>` and the run row keeps the hash.
- **Rationale**: Survives restarts, gives filtering and paging for thousands of runs, needs no server. JSON columns keep the raw answer at full fidelity (`answer.model_dump(mode="json")`). Hash-named image files avoid bloating the DB and deduplicate repeated images.
- **Default data dir**: `~/.jevbench/`, overridable with `--data-dir`.
- **Corrupt DB**: on open failure, rename it to `jevbench.db.broken-<timestamp>`, create a fresh one, and set a startup notice the UI shows.
- **Alternatives considered**: JSONL log file (no cheap filtering, and edits/deletes rewrite the file). Browser `localStorage` (lost if the port or origin changes, and invisible to export). Rejected.

## R5. Cost calculation

- **Decision**: `cost_usd = input_tokens × price_per_mtok / 1_000_000`, computed on the server when the run is recorded. The price used is stored on the run. The default is `0.042` (USD per million input tokens for Jev 1.13 and 1.14), editable in preferences. If `usage.input_tokens` is null, the cost is `null` and shown as "unknown".
- **Rationale**: The API returns tokens, not money. Output tokens are free per the Models page. Storing the price per run keeps old costs correct after a price edit.
- **Grid estimate**: `≈ ceil(chars/4)` per planned request × price, shown with a "~". Once the experiment has earlier runs, it uses their average actual tokens per request instead.
- **Alternatives considered**: A token-count endpoint does not exist. Rejected.

## R6. Grid execution (experiments)

- **Decision**: One request **per row** carrying all of that row's missing variants as separate questions. The browser orchestrates: it gets `/plan`, then POSTs `/api/runs` per row with `experiment_id`, at most N in parallel (default 4). The server has no job queue.
- **Rationale**: Jev evaluates the questions of a request independently ("one answer is not hidden context for another"), so batching variants does not contaminate wording comparisons. Batching is also what TypeSafe recommends (their parallel-questions cookbook measured 12× cheaper and faster than one request per question), because the state is billed once per request. 50 rows × 5 variants = 50 requests ≈ 13 s at 4 parallel, which meets SC-003.
- **Consequence**: Usage is reported per request, so per-column cost is an estimate (instruction-length share), labeled "≈".
- **Alternatives considered**: One request per cell (5× the state tokens, exact per-cell cost). Rejected as wasteful. A server-side job queue: no benefit for one user. Rejected.

## R11. Cell lookup by content hash

- **Decision**: Store an `answers` row per (run, question) with `input_hash` and `question_hash`. A matrix cell is the latest `ok` answer matching (row input hash, column question hash, model).
- **Rationale**: One mechanism serves designed grids, History-built matrices (FR-026, no cost) and ad-hoc runs that happen to match. Nothing has to be re-linked when experiments are duplicated or deleted. Making wording immutable once answered (edit = new column) keeps cells honest.
- **Alternatives considered**: Explicit run↔cell link table. Needs syncing on every edit or duplicate, and History→matrix would need a copy step. Rejected.

## R12. Where analysis is computed

- **Decision**: All metrics (bands, spread, composite, agreement, accuracy, confusion, best threshold, Brier, MAE, cost shares) are pure functions in `static/metrics.js` running in the browser over the cells the server returns once. Tested with `node --test` (Node 22 is installed).
- **Rationale**: Slider, weight, sort and filter changes must not hit Jev and should feel instant (SC-004: 500×10 in < 0.2 s, which is about 5k cells and trivial for JS). Keeping them pure makes them testable without a browser.
- **Best threshold**: sort the labeled values and evaluate accuracy at each unique cut, O(n log n). Ties go to the cut closest to 0.5.
- **Alternatives considered**: Server-side metrics endpoint. A round trip on every slider move, and Python plus JS duplication for the client-side band rendering. Rejected.

## R13. Experiment persistence

- **Decision**: An experiment is one JSON document per row in `experiments` (rows, columns, view, named views), saved by full PUT. View changes are debounced by about 500 ms.
- **Rationale**: Single user, ≤ ~1k rows (~200 KB). It is simpler than normalized row and column tables, and labels and weights are just fields. The server enforces the invariants (immutable answered wording, fixed type and criteria) on PUT.
- **Ceiling**: Concurrent edits from two tabs: last write wins. Acceptable for a local single-user tool.

## R7. Images

- **Decision**: The browser reads the file as base64 and the server builds `typesafe_sdk.Image.from_base64(...)` and places it in the state as `{"image": Image, ...}`. Questions refer to it as `` `image` ``. Only PNG and JPEG are accepted, validated by magic bytes on the server.
- **Rationale**: This matches the SDK's Assets API. The API detects the format from the bytes itself.

## R8. API key

- **Decision**: Read `TYPESAFE_API_KEY` from the environment (the SDK default). If it is unset, read the first line of `<data-dir>/api_key`. `/api/status` reports only `key_present` and the last 4 characters.
- **Rationale**: Meets FR-003 and FR-004 without a key-entry UI that would write the secret into the DB.

## R9. Testing

- **Decision**: One stdlib `unittest` file, `tests/test_core.py`, with a fake client. It covers cost math, null tokens, answer storage for all 4 types, hash-based cell lookup, History→matrix, the immutable-wording 409, run filters, CSV export, and corrupt-DB recovery. Plus `tests/metrics.test.mjs` (`node --test`, no dependencies) for band, spread, composite, agreement, accuracy, confusion, best threshold, Brier and MAE. The UI is verified manually with `quickstart.md`.
- **Rationale**: These are the smallest checks that fail if the money, data or analysis paths break. No pytest or JS test framework.

## R10. Accessibility and display preferences

- **Decision**: Display preferences are limited to theme, text size and number format (the user defined adaptation as analysis, not styling). They are applied as a `data-theme` attribute and CSS variables on `<html>`. Themes are light, dark, and system (`prefers-color-scheme`). Motion follows the OS `prefers-reduced-motion`. The heatmap uses one sequential hue with a text band tag. All controls are native `<button>`, `<input>`, `<select>`, and `<details>`, so they work by keyboard by default. Certainty levels are shown by a text label as well as color, never by color alone.
