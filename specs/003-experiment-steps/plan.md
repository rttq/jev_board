# Implementation Plan: Experiment Steps (linear chain with gates)

**Branch**: `003-experiment-steps` | **Date**: 2026-11-16 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/003-experiment-steps/spec.md`

## Summary

An experiment becomes an ordered chain of steps. Each step is a full matrix (type, criteria, variants, view, labels). A row reaches step N+1 only if it passes step N's **gate**. The pass likelihood is P(yes) for Noul, P(level ≥ minimum) for Score, or P(option in the passing set) for Choice. It is combined across visible variants by weight and banded by the step's own low/high thresholds. Review passes only when the step's toggle is on.

Technical approach:
- **Step 1 stays exactly where it is** (the experiment's top-level `type`, `criteria`, `columns`, `rows[].label`, `view`).
- **Steps 2..N** go into one new JSON column, `experiments.steps`.
- **Variant keys stay unique across the whole experiment.** So the existing `cells` map, cost split, run call and History link work for every step unchanged.
- **The gate is computed only in the browser**, by a pure function in `metrics.js` that Node can test. The server never gates. It only gets an explicit row list when asked for a step's plan.
- `experiments.js` is refactored so every matrix function takes a **step context** instead of reading `S.exp`. A single-step experiment renders as today, plus a **+ Add step** button.

## Technical Context

**Language/Version**: Python ≥ 3.11 (server); vanilla ES2022 modules + CSS (page). Unchanged from 001/002

**Primary Dependencies**: None added

**Storage**: SQLite `experiments` table gains `steps TEXT NOT NULL DEFAULT '[]'` (added in place for old DBs, like `reference`). No other schema change. Answers and runs are untouched

**Testing**: `python -m unittest` (new `TestSteps(Base)` in `tests/test_core.py`); `node --test` (new cases in `tests/metrics.test.mjs`); agent browser checks per [quickstart.md](quickstart.md)

**Target Platform**: Desktop (Windows primary; macOS/Linux), modern browser

**Project Type**: Local web app (existing package)

**Performance Goals**: Any gate change re-filters 5 steps × 1,000 rows and redraws in < 1 s (SC-003), with 0 requests

**Constraints**: Existing experiments behave identically (SC-005). No request for rows that stopped or are waiting earlier (SC-002). Keyboard-complete, not color-only

**Scale/Scope**: ≤ ~10 steps, ≤ ~5,000 rows per experiment. One new column, no new route (the plan route gains two query params), no new module

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is still the unfilled template, so no ratified gates exist. **Result: PASS (no gates defined).** The implicit defaults from 001/002 hold:
- **Simplicity**: no new dependency, table, route or module. Step 1 is not migrated. The gate is one pure function.
- **Testability**: gate math, chain walking, missing-cell counting and the chain CSV are pure `metrics.js` helpers tested in Node. Storage rules are tested in `TestSteps`.
- **Trust-boundary safety**: the server validates every step (type, criteria, keys, labels) exactly as it does step 1, and keeps the answered-wording lock per step.

*Post-design re-check*: PASS. The design adds one column, pure helpers, two query params and a refactor inside one existing module.

## Project Structure

### Documentation (this feature)

```text
specs/003-experiment-steps/
├── spec.md              # user decisions: linear chain, full matrix per step, per-step review toggle
├── plan.md              # this file
├── research.md          # R1–R10
├── data-model.md        # Step, Gate, view additions, computed StepResult, validation rules
├── quickstart.md        # manual + agent checks
├── contracts/
│   ├── http-api.md      # experiment doc `steps`, plan `step`/`rows`, list `steps`
│   └── ui.md            # step sections, gate controls, funnel, + Add step, Run chain
├── checklists/requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
jev_board/
├── store.py             # + steps column (schema + in-place ALTER); _normalize validates steps (shared _columns helper);
│                        #   column keys unique across steps; per-step type/criteria/wording lock; cells over all steps;
│                        #   experiment_plan(step, rows); list_experiments → steps; DEFAULT_VIEW + gate/step_name/collapsed
├── server.py            # h_plan_exp reads `step` and `rows` query params
└── static/
    ├── metrics.js       # + allSteps, gateFor, passLikelihood, chain, stepExp, missingRequests, chainCsv
    ├── experiments.js   # refactor: per-step context; step sections; gate row; funnel; + Add step; remove/rename/collapse; Run chain
    └── style.css        # + .step sections, gate tags, .funnel
tests/
├── test_core.py         # + TestSteps
└── metrics.test.mjs     # + gate/chain helpers
```

**Structure Decision**: The math goes in `metrics.js` because Node already tests it without a DOM, and `applyView` lives there. Rendering stays in `experiments.js` because it is the only view that shows steps. No new module: a step is "a matrix", and the matrix code already exists. It only needs to stop reading the global `S.exp`.

## Key Design Decisions (see [research.md](research.md))

1. **Linear chain, not nodes** (R1). The upgrade path is per-band or per-option `next`, when branching is needed.
2. **Step 1 is not migrated** (R2). Steps 2..N live in `experiments.steps`. A uniform `allSteps(exp)` accessor hides the asymmetry from the rest of the code.
3. **Experiment-wide unique variant keys** (R3) keep one `cells` map for all steps.
4. **Browser-only gate** (R4): one implementation, so the funnel, the matrices and Run counts always agree. The server plan takes the row keys.
5. **Pass likelihood = summed probabilities** (R5), banded by the step's existing thresholds. A row is judged only when all its visible variants are answered.
6. **Gate, step name and collapsed state live in the step's `view`** (R6). They are view-only (debounced save, no lock), and name and collapsed survive saved-view restore and reset.
7. **Run counts are computed in the browser** (R7) with the resolved model. The server plan is fetched only at confirm time, for the exact requests and the estimate.
8. **Step 1 cannot be removed** (R8). It owns the inputs and its lock.

## Complexity Tracking

No violations to justify.

| Deliberate simplification | Ceiling | Upgrade when |
|---------------------------|---------|--------------|
| Linear chain only | No per-option routing | Branching is needed → `next` per band/option, i.e. nodes |
| Every gate change redraws every step grid | 5 × 200 visible rows per redraw | More steps or rows make redraws slow → redraw from the changed step onward |
| Plan `rows` sent as a comma-separated query param | ~8,000 row keys per URL | Experiments grow past that → POST body |
| One `models` list for the whole experiment | A step can't see "its own" latest model | Steps routinely run on different models → per-step model list |
| Same question in two steps shares a cell; its run cost share is split between both keys | Cost overlay double-counts that edge case | Users report wrong cost shares |
| Saved views only restore view fields; name and collapsed are kept aside | — | — |
