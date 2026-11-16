# Research: Experiment Steps

No `NEEDS CLARIFICATION` remained in the Technical Context. These are the design decisions, made after reading `jevbench/store.py`, `jevbench/server.py`, `jevbench/static/experiments.js` and `jevbench/static/metrics.js`.

## R1 — Linear chain, not a node graph

- **Decision**: An ordered list of steps. Every row that passes step N goes to step N+1.
- **Rationale**: All requested flows (noul→score→noul, noul→noul, noul→score→choice) are chains. A graph needs a canvas editor, edges, cycle checks and a routing language, and serves only branching, which nobody asked for. The user chose linear.
- **Alternatives**: A node graph, kept as the upgrade path. A step would get `next: {pass: key, review: key, stop: key}` (or one per Choice option), and `chain()` becomes a topological walk.

## R2 — Where steps are stored

- **Decision**: Step 1 stays in the experiment's top-level fields (`type`, `criteria`, `columns`, `rows[].label`, `view`, `views`). Steps 2..N are stored as a JSON list in a new column `experiments.steps` (default `'[]'`). It is added in place for old DBs, the same way `reference` was. A pure `allSteps(exp)` in `metrics.js` returns a uniform list of every step for the rest of the browser code.
- **Rationale**: There is no data migration, and old experiments are byte-identical until edited (SC-005). The server lock, `experiment_from_runs`, History links and exports for step 1 keep working unchanged.
- **Alternatives**: Moving step 1 into `steps[0]` as well. That is more uniform, but it needs a migration and touches every reader of `exp.type` and `exp.columns`, on both server and page.

## R3 — Variant keys unique across all steps

- **Decision**: `_normalize` assigns missing column keys with `_next_key` over the columns of **all** steps, and rejects duplicates across steps with a 400. So step 2's variants are `c3`, `c4`, …
- **Rationale**: `cells` is `{rowKey: {colKey: {model: …}}}`. With unique keys, one map serves every step. `runRow`'s `questions: {colKey: wire}`, `costShare(runCost, colKey)` and "Open in History" need no change.
- **Alternatives**: Cells per step (`step_cells`). That is a new response shape and a new lookup in every grid function.

## R4 — Gate computed only in the browser

- **Decision**: `chain(exp, cells, models)` in `metrics.js` decides each row's outcome. The server never evaluates gates. `GET /api/experiments/{id}/plan` gains `step` (step key; default step 1) and `rows` (comma-separated row keys; default all rows).
- **Rationale**: The gate depends on view state (thresholds, weights, hidden variants, model in view, gate settings) that changes live and is saved with a delay. With one implementation, the funnel, grids and Run counts can't disagree. The server still decides what is missing for the rows it is given.
- **Alternatives**: Gate logic in Python too. Two copies would drift.

## R5 — Pass likelihood

- **Decision**: Per answered cell:
  - Noul: `answer.noul`.
  - Score: Σ `answer.probabilities[l]` for `l ≥ min_level`.
  - Choice: Σ `answer.probabilities[o]` for `o ∈ pass_options`.

  Per row: a weighted mean over the step's **visible** variants, with weights from `view.weights_override[key] ?? col.weight ?? 1` (the same weights as the composite). A row is **waiting** unless every visible variant has an answer for the gate model. The model is `view.model` unless it is `null` or `"compare"`, in which case it is `models[0]`. The outcome uses the step's `view.threshold`:
  - `p ≥ high` → pass;
  - `p < low` → stop;
  - otherwise review → pass if `gate.review_passes`, else stop.
- **Rationale**: One rule for all three types, using values Jev already returns. For Noul, and for Choice with the focus option only, `p` equals the existing composite, so the step's yes/review/no bands and its gate agree. The all-answered rule stops a row from passing on a partial composite.
- **Alternatives**:
  - Score gating on the rounded composite level. It has no meaningful review band.
  - Choice gating on the argmax being in the set. It ignores confidence.
  - Composite over answered cells only. It lets rows pass early.

## R6 — Gate, name and collapsed state in the step's view

- **Decision**: The view gains `gate: {min_level: int|null, pass_options: [str]|null, review_passes: false}`, `step_name: str|null` and `collapsed: false`. `null` means default: `ceil((nLevels-1)/2)` for Score, and `[focus option]` for Choice. Saved-view restore and "Reset view" keep the current `step_name` and `collapsed`.
- **Rationale**: Gate changes must be free and live, like thresholds (FR-014). The view is exactly that path: a debounced PUT, never locked, no reload. Every step already has a view, so step 1 needs no new top-level field.
- **Alternatives**: A separate `gate` field per step, plus a new step-1 field. That means more fields with the same save semantics.

## R7 — Run counts in the browser, plan at confirm

- **Decision**: `missingRequests(rowKeys, columns, cells, model)` (pure) gives each step's "Run missing (n)" count. `model` is the plan's `resolved_model`, fetched once per Run-with change. The server plan (with `step` and `rows`) is fetched when the user clicks Run, for the confirm dialog and the exact requests.
- **Rationale**: Moving step 1's threshold changes step 2..N's counts live. Fetching N plans after every slider move would be slow and racy.
- **Alternatives**: Refetching every step's plan on every change.

## R8 — Removing steps

- **Decision**: Steps 2..N can be removed (with confirm). Step 1 cannot. Removal is a structural `saveDoc({steps: filtered})`. Later steps then take rows from the step before.
- **Rationale**: Step 1 owns the inputs, the reference and the existing type/criteria lock. Promoting step 2 into step 1 would trip that lock (a type change while answers exist) and needs a special case.
- **Alternatives**: Allow removing step 1 by promoting step 2, with a lock exemption.

## R9 — Per-step lock

- **Decision**: `update_experiment` applies the existing rules to every step, matched by step key:
  - a step whose old columns have answers for the experiment's rows cannot change type or criteria → 409 "Step N: type and criteria are fixed once answers exist…";
  - an answered column (any step, by key) cannot change wording → 409.

  New steps and new columns are free.
- **Rationale**: This is the same identity rule as today. A cell is input × question.

## R10 — Run chain

- **Decision**: Run chain starts with one confirm:
  - step 1 shows its exact plan;
  - each later step shows a plan for the rows **not stopped at any earlier step** (passed or waiting), labelled "at most".

  It then loops: for each step, recompute `chain()`, fetch the plan for the arriving rows, run it with the existing worker pool, `refreshCells()`, and move on. Rows that fail stay waiting and are not sent on.
- **Rationale**: This reuses `runRequests`. The upper bound is honest, since a waiting row could still pass.
- **Alternatives**: A per-step confirm, which is more clicks; or no estimate for later steps, which hides the cost.
