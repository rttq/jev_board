# Contract: HTTP API changes (experiment steps)

This is a delta on `specs/001-jev-classification-gui/contracts/http-api.md`. Routes not listed are unchanged. There is no new route.

## Experiment document

Every response that returns `experiment` (GET, POST, PUT, duplicate, from-runs) now includes `steps`:

```json
{"experiment": {"id": 7, "name": "…", "type": "noul", "criteria": null, "rows": […], "columns": [{"key": "c1", …}],
                "view": {…, "gate": {"min_level": null, "pass_options": null, "review_passes": false},
                         "step_name": null, "collapsed": false},
                "views": {},
                "steps": [{"key": "s1", "type": "score", "criteria": ["off", "partial", "full"],
                           "columns": [{"key": "c3", …}], "labels": {"r1": 2}, "view": {…}, "views": {}}]},
 "cells": {"r1": {"c1": {…}, "c3": {"jev-1.14.0": {"answer": {…}, "run_id": 31}}}},
 "run_costs": {…}, "models": […], "cost": {…}}
```

- An old experiment returns `"steps": []`.
- `cells` covers the columns of **every** step. Column keys are unique across the experiment, so the shape is unchanged. If two steps hold the same question (same hash), both keys get the same cell.
- `run_costs[id].questions` maps each run question to its column key(s) by hash, as before.
- `cost` stays experiment-wide.

## `POST /api/experiments`, `PUT /api/experiments/{id}`

Body: as before, plus an optional `steps: [Step]` (see data-model.md). `PUT` remains a full-document replace. Omitting `steps` keeps the old ones.

| Case | Response |
|------|----------|
| step `type` not noul/choice/score | `400 "step N: type must be noul, choice or score"` |
| invalid step criteria | `400 "step N: <validate_questions message>"` |
| step variant without wording | `400 "step N: variant M has no wording"` |
| duplicate column key across steps | `400 "variant key cK is used twice"` |
| invalid step label | `400 "step N: label X is not valid for {type}"` |
| answered step changes type/criteria | `409 "Step N: type and criteria are fixed once answers exist. Duplicate the experiment to change them."` |
| answered column (any step) changes wording | `409` (the existing message) |

Here N is the 1-based position in the chain: the first stored step is "step 2".

Warnings (`200`, in `warnings`): `"step N: variant M repeats an earlier wording and was merged"`.

## `POST /api/experiments/{id}/duplicate`

Copies `steps` with the rest of the document.

## `GET /api/experiments`

Each item gains `steps: ["noul", "score", "choice"]`, the type of every step in order, with step 1 first. `columns` becomes the variant count across all steps.

## `GET /api/experiments/{id}/plan?model=…&step=…&rows=…`

| Param | Default | Meaning |
|-------|---------|---------|
| `model` | prefs default | Unchanged |
| `step` | *(empty)* = step 1 | The key of a stored step (`s1`, `s2`, …). Unknown key → `404 "step not found"` |
| `rows` | *(empty)* = all rows | Comma-separated row keys. Only these rows are planned. Unknown keys are ignored |

The response shape is unchanged: `{model, resolved_model, requests: [{row, columns}], estimated_tokens, estimated_cost_usd}`. `requests` lists only the given rows and the step's visible columns. The estimate uses that step's wording lengths (`_wire(step, col)`).

The server **never evaluates gates**. The browser sends the rows that reach the step.

## `POST /api/runs`

Unchanged. A step's cells are run with `experiment_id` set and `questions: {colKey: {type: step.type, instructions, criteria: step.criteria}}`.
