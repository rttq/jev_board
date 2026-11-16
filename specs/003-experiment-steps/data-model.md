# Data Model: Experiment Steps

Builds on the experiment document from `specs/001-jev-classification-gui/data-model.md`. Only additions are listed here.

## Stored

### Experiment (table `experiments`)

| Field | Change |
|-------|--------|
| `steps` | **NEW** `TEXT NOT NULL DEFAULT '[]'`: a JSON list of **Step** (steps 2..N, in order). Old DBs get it via `ALTER TABLE … ADD COLUMN` in `_connect` |
| `type`, `criteria`, `columns`, `rows[].label`, `view`, `views` | Unchanged. Together they *are* step 1 |
| `rows`, `reference`, `name` | Unchanged, and shared by every step |

### Step (an element of `experiments.steps`)

```json
{
  "key": "s1",
  "type": "score",
  "criteria": ["off", "partial", "full"],
  "columns": [{"key": "c3", "instructions": "…", "weight": 1, "threshold": null, "hidden": false, "question_hash": "…"}],
  "labels": {"r1": 2, "r4": 0},
  "view": { "...DEFAULT_VIEW": "…", "gate": {"min_level": null, "pass_options": null, "review_passes": false},
            "step_name": "quality", "collapsed": false },
  "views": {}
}
```

| Field | Rule |
|-------|------|
| `key` | Assigned by the server when missing (`_next_key(steps, "s")`). Stable across saves. Used to match old and new steps for the lock |
| `type` | One of `noul`, `choice`, `score` (`EXP_TYPES`) |
| `criteria` | Validated with `jev.validate_questions` via the same probe as step 1 |
| `columns` | The same normalization as step 1 (wording required, `weight`, `threshold`, `hidden`, `question_hash = question_hash(_wire(step, col))`). Repeats within a step are merged with a warning. **Keys are unique across the whole experiment** (step 1 + all steps): missing keys come from `_next_key(all columns, "c")`, and a duplicate key → 400 `variant key c3 is used twice` |
| `labels` | `{rowKey: label}`. Keys not in `rows` are dropped silently (the row was removed). Each label passes `_label_ok(step.type, step.criteria, label)`, else 400 `step N: label … is not valid for {type}` |
| `view` | Merged over `DEFAULT_VIEW` like step 1 |
| `views` | Saved views of this step. Default `{}` |

### View additions (every step, including step 1)

`DEFAULT_VIEW` (in both `store.py` and `experiments.js`) gains:

| Key | Default | Meaning |
|-----|---------|---------|
| `gate.min_level` | `null` | Score only. `null` → `ceil((nLevels - 1) / 2)` |
| `gate.pass_options` | `null` | Choice only. `null` → `[focus_option ?? first option]`. `[]` → nothing passes (warning) |
| `gate.review_passes` | `false` | Review band passes when `true` |
| `step_name` | `null` | Display name. `null` → "Step N · {Type}" |
| `collapsed` | `false` | The step section is collapsed |

Saved-view restore and "Reset view" keep the current `step_name` and `collapsed`.

## Lock rules (`update_experiment`)

- Step 1: unchanged.
- Step with key K that exists in the old document: if any of its **old** columns' `question_hash` is answered for the experiment's row `input_hash`es and its `type` or `criteria` changed → 409 `Step N: type and criteria are fixed once answers exist. Duplicate the experiment to change them.`
- Any column (any step) with a key present in the old document, whose wording changed while its old hash is answered → 409 (the existing message).
- Removing a step or a column is always allowed. Answers stay in `runs`/`answers`.

## Computed (browser only, `metrics.js`)

### `allSteps(exp)` → `StepDef[]`

`[{key: "s0", index: 0, type: exp.type, criteria: exp.criteria, columns: exp.columns, labels: {rowKey: row.label}, view: exp.view, views: exp.views}, ...exp.steps.map((s, i) => ({...s, index: i + 1}))]`

Step 1's key is the fixed string `"s0"`. Only the browser uses it. The server addresses step 1 by omitting `step`.

### `gateFor(def)` → `{minLevel, passOptions, reviewPasses}`

The defaults from the view additions above are resolved here.

### `passLikelihood(answer, type, gate)` → `number | null`

| type | value |
|------|-------|
| noul | `answer.noul` |
| score | Σ `answer.probabilities[String(l)]` for every level `l ≥ gate.minLevel` (missing keys count 0) |
| choice | Σ `answer.probabilities[o]` for every `o ∈ gate.passOptions` |

### `chain(exp, cells, models)` → `StepResult[]`

For each step, in order, starting with `arrived = exp.rows.map(r => r.key)`:

```text
StepResult = {
  def,                       // StepDef
  arrived: [rowKey],         // rows that reach this step
  outcome: {rowKey: {state: "pass" | "stop" | "wait", p: number | null, band: "yes" | "review" | "no" | null}},
  counts: {entered, passed, stopped, waiting}   // entered = passed + stopped + waiting
}
```

- Gate model: `def.view.model` unless `null` or `"compare"` → `models[0]`.
- Visible columns: `!col.hidden`, with weight `def.view.weights_override?.[key] ?? col.weight ?? 1`.
- `wait` when there is no visible column, or any visible column has no cell for the gate model.
- Otherwise `p` = weighted mean of `passLikelihood` and `band = band(p, def.view.threshold)`. `state` = pass for yes, stop for no, and for review pass if `reviewPasses`, else stop.
- The next step's `arrived` = rows with `state === "pass"`, in `exp.rows` order.
- **View filters and sort are never read here** (FR-013).

### `stepExp(exp, def, arrived)` → a pseudo-experiment for `applyView` / `matrixCsv` / `matchQuestions`

`{...exp, type: def.type, criteria: def.criteria, columns: def.columns, view: def.view, rows: exp.rows.filter(r => arrived.includes(r.key)).map(r => ({...r, label: def.labels[r.key] ?? null}))}`

`arrived` is checked through a `Set`.

### `missingRequests(rowKeys, columns, cells, model)` → `[{row, columns: [colKey]}]`

For every row in `rowKeys`, the visible columns with no cell for `model`. Rows with none are left out. The result has the same shape as the server plan's `requests`.

### `chainCsv(exp, results)` → CSV text

Header: `input, tags, {step label} outcome, {step label} p` for each step. One line per experiment row. Outcome values: `passed`, `stopped`, `waiting`, `did not reach`. `p` has 4 decimals or is empty. It uses the existing `csvCell` quoting and `inputText` for the input.

## Row outcome states

```text
step 1:  every row ─┬─ wait (not fully answered)
                    ├─ stop (no band, or review with review_passes off)
                    └─ pass ──► step 2: same split … ──► last step pass = "passed the chain"
rows that stop or wait at step N are "did not reach" at steps N+1..end
```
