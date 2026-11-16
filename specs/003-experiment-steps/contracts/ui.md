# Contract: UI (experiment steps)

This is a delta on `specs/001-jev-classification-gui/contracts/ui.md` (Experiment dashboard).

## Page layout (`#/experiments/{id}`)

```text
#exp-summary          name · chain "Noul → Score → Choice" · rows × variants · model · spent
┌ step section s0 ────────────────────────────────────────────────────────────┐
│ header (only when chain length ≥ 2): "Step 1 · {name|Type}" counts · ⋯      │
│ Setup panel        (step 1: today's panel unchanged: name, question, inputs,│
│                     reference, variants)                                    │
│ toolbar            (today's rows + gate row when chain length ≥ 2)          │
│ grid + cell panel  (rows = arrived rows; + "gate" column when length ≥ 2)   │
└─────────────────────────────────────────────────────────────────────────────┘
┌ step section s1 ─ header "Step 2 · …" [Rename] [Collapse] [Remove] ────────┐
│ Setup panel (question + variants only: type, criteria, "+ variant",         │
│              "Load questions")                                              │
│ toolbar + gate row │ grid + cell panel                                      │
└─────────────────────────────────────────────────────────────────────────────┘
… more steps …
Funnel   Step 1 100 → 40 passed · 55 stopped · 5 waiting │ Step 2 40 → … │ Passed the chain: 12
[+ Add step]   [Run chain]   [Export chain CSV]
```

- **A single-step experiment** renders exactly as today, plus the bottom bar with **+ Add step**. Run chain and Export chain only appear once there are ≥ 2 steps. There is no step header, gate row, gate column or funnel.
- Each step section is `<section class="step" id="step-{key}" aria-labelledby="step-{key}-h">`.
- **Collapse**: a toggle button in the header (`aria-expanded`). A collapsed step shows only its header, with counts. Its setup, toolbar and grid are not rendered. The state is saved in `view.collapsed`.
- **Rename**: `prompt()` sets `view.step_name`. An empty value resets it to the default. The name shows in the header, funnel and chain CSV.
- **Remove** (steps 2..N): `confirmDialog("Remove step?", "Step N and its setup will be removed. Its answers stay in History.", "Remove")`.

## Step header

`Step N · {step_name || TYPE_LABEL[type]}`, then the counts as text: `{entered} in · {passed} passed · {stopped} stopped · {waiting} waiting`. If the step has an earlier step and `entered = 0`, it shows `waiting for rows that pass step N-1`.

## Gate row (toolbar, chain length ≥ 2)

| Type | Controls |
|------|----------|
| Noul | (none extra) |
| Score | `Pass at level ≥ [select of levels "i · text"]` (default from `gateFor`) |
| Choice | `Passing options:` a checkbox per option (default: the focus option) |
| all | `[ ] review passes` checkbox; the text `pass ≥ {high} · stop < {low}` (the step's thresholds) |

- Changes write to `view.gate`, then `drawGrids()` + `saveViewSoon()`. There is never a request to Jev and never a reload.
- Warnings (`.hint`, `role="status"`):
  - "No option is marked as passing: no row can pass." (Choice, `pass_options = []`)
  - "Minimum level is the lowest: every judged row passes." (Score, `min_level = 0`)
  - "No visible variants: every row waits here." (no visible column)
  - "Comparing versions: the gate uses {models[0]}." (`view.model === "compare"`)

## Gate column (grid, chain length ≥ 2)

The last column of the main table. The text is always shown:

| state | text | class |
|-------|------|-------|
| pass (yes band) | `passes 0.91` | `gate-pass` |
| pass (review, review_passes) | `review → passes 0.63` | `gate-pass` |
| stop | `stops 0.12` or `review → stops 0.63` | `gate-stop` |
| wait | `waiting` | `gate-wait` |

It is not shown in the pivot table.

## Bottom bar

- **+ Add step** (`id="add-step"`, always visible): `saveDoc({steps: [...steps, {type: "noul", criteria: null, columns: [], labels: {}, view: {}}]})`. The new step's setup opens, and its variant box gets focus.
- **Funnel** (`<table class="funnel">`): one column per step with entered, passed, stopped and waiting, plus "Passed the chain: N". It updates on every `drawGrids()`.
- **Run chain** (`id="run-chain"`): disabled while running, with no API key, or with no missing cells anywhere in reach. The confirm text is `Step 1: {n} requests ≈ $x · Step 2: at most {n} requests ≈ $y · …`. Progress in the run bar reads `Step K: done/total`.
- **Export chain CSV**: downloads `chainCsv` as `{name}-chain.csv`.

## Per-step behavior (same controls as today, scoped to the step)

- **Run missing (n)**: `n = missingRequests(arrived, step columns, cells, resolvedModel).length`. Clicking it fetches the plan with `step` and `rows`, confirms with the step name, then runs.
- **Labels**: step 1 writes `row.label`. Other steps write `steps[i].labels[rowKey]`. Both are debounced view saves.
- **Load questions**: `matchQuestions(stepExp, …)`. An empty step adopts the file's type and criteria.
- **Export CSV** (matrix): only arrived rows.
- **Cell panel and selection**: per step. Arrow keys move inside that step's grid only.
- The **inputs, reference and experiment name** are edited only in step 1's Setup.

## Experiment list

The Type column shows `steps.map(TYPE_LABEL).join(" → ")`. For a single step it shows only that type, as today.

## Keyboard

Unchanged. Ctrl+Enter runs missing for the step that holds focus (step 1 when focus is outside any step).
