# Contract: local HTTP API (browser ↔ jevbench server)

Base URL `http://127.0.0.1:<port>`. JSON bodies (UTF-8). Errors return `{"error": "<message>", "field": "<optional path>"}` with an HTTP status.

## Static

`GET /` → `index.html`; `GET /static/*` → `app.js`, `metrics.js`, `style.css`.

## `GET /api/status`

```json
{"key_present": true, "key_hint": "ab12", "data_dir": "...", "notice": null,
 "server_started_at": "2026-11-13T10:00:00Z",
 "models": ["jev-latest", "jev-preview", "jev-1.14.0", "jev-1.13.0"]}
```

## Runs

### `POST /api/runs`: run and record

```json
{
  "input": {"kind": "text", "text": "A round red fruit with a crisp, sweet bite"},
  "image_base64": null,
  "model": "jev-latest",
  "experiment_id": null,
  "questions": {
    "c1": {"type": "noul", "instructions": "Is `text` describing an apple?"},
    "c2": {"type": "noul", "instructions": "Does `text` describe an apple?"}
  }
}
```

State: `{"text": …}` for `kind=text`, `fields` for `kind=json`, plus `"image"` when an image is attached. A grid run is this same call, once per row, with `experiment_id` set and the row's missing column keys as question IDs.

- `200` → the stored run with `answers` attached as `{question_id: answer}`, plus `input_hash` and a `question_hash` per question.
- `200` with `"status": "error"` → the Jev call failed (auth, `max_tokens_exceeded`, 422, network, retries exhausted). Recorded with `cost_usd: null`.
- `400` → local validation failed. Not recorded. `503` → no API key. Not recorded.

### `GET /api/runs`

Query: `type`, `model`, `status`, `tag`, `experiment_id`, `q` (substring of input, questions, note), `from`, `to`, `ids`, `limit` (≤ 500, default 50), `offset`. Returns `{"total": N, "runs": [...]}`, newest first.

### `GET|PATCH|DELETE /api/runs/{id}`

PATCH `{note, tags}` only. DELETE → `204` (answers cascade).

## Experiments

### `GET /api/experiments` → `[{id, name, type, rows: n, columns: n, cost_usd, updated_at}]`

### `POST /api/experiments`

Body: `{name, type, criteria, rows: [{input, label?, tags?}], columns: [{instructions, weight?}]}`. The server assigns keys and hashes and returns the full experiment. Import problems → `400` with `{"error": "...", "rows": [{"index": 3, "error": "label 'maybe' is not yes/no"}]}`.

### `POST /api/experiments/from-runs`

Body: `{name, run_ids: [...] | filter: {...same as GET /api/runs}, type}`. The server collects the distinct inputs (rows) and the distinct question wordings of `type` with identical criteria (columns). Returns the experiment plus `{"skipped": {"other_types": 4, "other_criteria": 1}}`. No Jev request is made.

### `GET /api/experiments/{id}`

Returns the full experiment (see data-model) **plus its cells**:

```json
{"experiment": {...},
 "cells": {"r1": {"c1": {"jev-1.14.0": {"answer": {...}, "run_id": 12}}}},
 "run_costs": {"12": {"cost_usd": 0.0000049, "input_tokens": 118, "questions": {"c1": 52, "c2": 55}}},
 "models": ["jev-1.14.0"],
 "cost": {"cost_usd": 0.00021, "runs": 40, "unknown_cost_runs": 0}}
```

`cells` holds the latest `ok` answer per (row, column, model), found by hash. `run_costs[...].questions` gives the instruction lengths used for the "≈" column cost share.

### `PUT /api/experiments/{id}`

Full-document replace of `name, criteria, rows, columns, view, views`. The server recomputes hashes and assigns keys to new rows and columns.

- `409` if it changes the `instructions` of a column that has answers, or changes `type`/`criteria` once answers exist (the response says to add a new column or duplicate the experiment).
- View-only changes (thresholds, sort, filters…) also go through PUT. The browser debounces them (≈ 500 ms), and they never trigger a Jev request.

### `GET /api/experiments/{id}/plan?model=jev-latest`

Lists what a "Run missing" would send: `{"requests": [{"row": "r3", "columns": ["c4"]}], "estimated_tokens": 1820, "estimated_cost_usd": 0.0000764}`. Estimate = ceil(chars/4) per request, or the average actual tokens per request of earlier runs in this experiment when there are any.

### `POST /api/experiments/{id}/duplicate` · `DELETE /api/experiments/{id}`

Delete removes the experiment only. Its runs stay in History, with `experiment_id` cleared.

## Totals, export, prefs, images

- `GET /api/totals` → `{"session": {...}, "all_time": {...}}`, each `{runs, cost_usd, unknown_cost_runs}`.
- `GET /api/export?format=csv|jsonl&<run filters>`: runs. The CSV has one row per (run × question): `run_id, created_at, experiment_id, model_used, status, input_tokens, cost_usd, question_id, type, instructions, result, confidence, probabilities, input_text, tags, note, error`.
- Matrix export is generated **in the browser** from the current view (what you see is what you export): CSV rows = inputs with `input, label, tags, <variant values…>, composite, spread`, then a blank line and a metrics block per column.
- `GET|PUT /api/prefs`, `POST /api/prefs/reset`.
- `GET /api/images/{sha}`.
