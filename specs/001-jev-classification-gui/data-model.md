# Data Model: Jev Classification Workbench

Storage: SQLite file `<data-dir>/jevbench.db` (default `<project>/data/`, gitignored). Images: `<data-dir>/images/<sha256>.<png|jpg>`.

Core idea: **cells are found by content, not by links.** Every stored answer carries `input_hash` and `question_hash`. A matrix cell `(row, column, model)` is the latest successful answer whose hashes match that row's input and that column's question. So a matrix built from History, a matrix run from the dashboard, and an ad-hoc single run with the same text and wording all fill the same cell with no extra bookkeeping.

`hash(x)` = SHA-256 of canonical JSON (`sort_keys`, no whitespace), first 16 hex chars.

- `input_hash = hash({"kind", "text" | "fields", "image_sha"})`
- `question_hash = hash({"type", "instructions", "criteria"})` (the question ID is excluded)

## Table `runs`

One row per request sent or attempted.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | |
| `created_at` | TEXT | ISO-8601 UTC |
| `experiment_id` | INTEGER NULL | set when launched from an experiment (cost attribution, History filter) |
| `input` | TEXT (JSON) | `{"kind": "text", "text": …}` or `{"kind": "json", "fields": {…}}` |
| `input_hash` | TEXT | see above |
| `image_sha` | TEXT NULL | |
| `questions` | TEXT (JSON) | `{question_id: {type, instructions, criteria?}}` exactly as sent |
| `model_requested` | TEXT | |
| `model_used` | TEXT NULL | e.g. `jev-1.14.0` |
| `status` | TEXT | `ok` \| `error` |
| `error` | TEXT NULL | |
| `input_tokens` | INTEGER NULL | |
| `price_per_mtok` | REAL | price used for this row |
| `cost_usd` | REAL NULL | `input_tokens × price_per_mtok / 1e6`; null if tokens are null or status is error |
| `duration_ms` | INTEGER | |
| `request_id` | TEXT NULL | |
| `note` | TEXT | `''` |
| `tags` | TEXT | comma-joined, `''` |

Indexes: `created_at`, `experiment_id`, `input_hash`.

## Table `answers`

One row per (run, question). Inserted with an `ok` run.

| Column | Type | Notes |
|--------|------|-------|
| `run_id` | INTEGER FK → runs ON DELETE CASCADE | |
| `question_id` | TEXT | ID used in that request |
| `question_hash` | TEXT | |
| `input_hash` | TEXT | copied from the run, for a single-table lookup |
| `model_used` | TEXT | copied from the run |
| `type` | TEXT | `noul` \| `choice` \| `score` \| `box` |
| `answer` | TEXT (JSON) | `answer.model_dump(mode="json")` verbatim |
| `created_at` | TEXT | copied from the run |

PK `(run_id, question_id)`. Index `(input_hash, question_hash, model_used, created_at)`.

### Answer shapes (verbatim from the SDK)

| Type | Fields |
|------|--------|
| noul | `{type, noul}` |
| choice | `{type, choice, probabilities: {option: p}, confidence}` |
| score | `{type, score, legend: {"0": level, …}, probabilities: {"0": p, …}, confidence}`, where levels are 0-based and `score` is a float position |
| box | `{type, box: {top, bottom, left, right}, confidence}` |

## Table `experiments`

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | |
| `name` | TEXT | unique |
| `type` | TEXT | `noul` \| `choice` \| `score` (no Box in v1) |
| `criteria` | TEXT (JSON) NULL | shared by all columns: Choice options map, Score levels array, optional Noul clarification |
| `reference` | TEXT NULL | optional shared text sent with every row as the state field `reference` (a text row becomes `{"reference", "text"}`; a JSON row's own `reference` wins). It is part of each row's `input_hash`, so changing it starts fresh cells |
| `rows` | TEXT (JSON) | `[Row]`, in display order |
| `columns` | TEXT (JSON) | `[Column]`, in display order |
| `view` | TEXT (JSON) | current `View` |
| `views` | TEXT (JSON) | `{name: View}` saved named views |
| `created_at`, `updated_at` | TEXT | |

The whole experiment is read and written as one JSON document. That is fine for one user and ≤ ~1k rows.

```jsonc
// Row
{"key": "r7", "input": {"kind": "text", "text": "Green sour crisp fruit"},
 "input_hash": "…", "label": "yes" /* or option / level index / null */, "tags": ["green"]}

// Column (wording variant)
{"key": "c3", "instructions": "Does `text` describe an apple?", "question_hash": "…",
 "weight": 1, "threshold": null /* or {"low": .4, "high": .85} */, "hidden": false}

// View
{"threshold": {"low": 0.5, "high": 0.8},
 "focus_option": "apple",                 // Choice only
 "sort": {"by": "spread", "dir": "desc"}, // by: column key | "composite" | "spread" | "label" | "input"
 "filters": {"labeled": null, "misclassified": false, "review_only": false,
             "spread_min": null, "tags": [], "text": ""},
 "pivot": false, "overlay": "value",      // value | cost
 "model": "jev-1.14.0",                   // model version shown; "compare" = side-by-side groups
 "weights_override": null}                // null = use column weights
```

### Validation and invariants

- `type` is fixed once any column has answers. To change it, duplicate the experiment.
- `criteria` is fixed once any answer exists. Changing it would change every `question_hash`, so it is also done by duplicating.
- A column's `instructions` are immutable once matching answers exist. "Edit" creates a new column (`key` = next free, old one optionally `hidden`). Enforced on the server: a PUT that changes `instructions` on a column with answers returns 409.
- Row and column keys are unique and never reused.
- Labels: Noul `"yes" | "no"`. Choice is one of the option keys. Score is a level index `0…N-1`. Otherwise `null`. Invalid values are rejected at import with per-row errors.
- Duplicate `input_hash` among rows, or duplicate `question_hash` among columns, triggers a warning and is merged on confirm.
- Question validation (all types): non-empty `instructions`; Choice ≥ 2 options; Score ≥ 2 levels; Box requires an image and a model other than `jev-1.13.*`. Image: PNG/JPEG magic bytes, ≤ 20 MiB.

## Derived (computed in the browser, `static/metrics.js`)

Given `cells[row][col] = answer | null` for the selected model:

- **value(answer)**: Noul → `noul`. Choice → `probabilities[focus_option]`, with `won = (choice === focus_option)`. Score → `score / (N-1)`, nearest level `round(score)`.
- **band(v, t)**: `v ≥ t.high → yes`, `v < t.low → no`, otherwise `review`. Uses the column's own `threshold` if set, else the view's.
- **spread(row)**: `max − min` of the values in visible columns. Needs ≥ 2 values; otherwise `—`.
- **composite(row)**: `Σ wᵢvᵢ / Σ wᵢ` over visible columns with a value. Null when `Σw = 0`.
- **column stats**: mean, counts per band, **agreement** (the share of rows where all visible columns have the same band).
- **label metrics** (labeled rows only, `n` reported). For Noul and Choice, the truth is `label == yes` (Noul) or `label == focus_option` (Choice):
  - accuracy = correct / decided (review excluded); review rate = review / n
  - confusion: TP, TN, FP, FN, review
  - best threshold = the single cut `t` among the unique values that maximizes accuracy (`low = high = t`)
  - Brier = mean((v − truth)²)
  - Score: MAE = mean(|score − label|) in levels; accuracy = round(score) == label
- **cost**: row cost = the `cost_usd` of the run that produced that row's cells. Column share ≈ row cost × len(column instructions) / Σ len(instructions in that request), marked "≈". Cost per correct = experiment cost / correct decided rows.

## Table `prefs`

Single row `(id=1, data JSON)`. Missing keys fall back to defaults.

```json
{"theme": "system", "text_scale": 1.0, "prob_format": "percent", "prob_decimals": 0,
 "default_model": "jev-latest", "price_per_mtok": 0.042, "concurrency": 4}
```

## Type guide cards

Static content in `app.js`, four entries `{type, asks, returns, use_when, pitfall, diagram_svg}`.
