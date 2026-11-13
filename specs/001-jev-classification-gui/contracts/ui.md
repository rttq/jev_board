# Contract: UI layout and behavior

One page with views **Run · Experiments · History · Settings**, plus a "Compare types" dialog. Neutral styling. The analysis controls are where adaptation happens.

## Experiment dashboard (the main analysis view)

```
┌ Experiment: apple-wording  · Noul · 10 rows × 3 variants · jev-1.14.0 ▾ · $0.00021 ───────────┐
│ Threshold  no ◀━━━━━━━●━━━━━━━●━━━━━▶ yes   low 0.50  high 0.80        [Values|Cost]  [Pivot]  │
│ Sort: spread ▾ desc   Filter: [labeled ▾] [☐ misclassified] [☐ review only] [spread ≥ __] [tag ▾]│
│ View: [current ▾] [Save view…]                                         [Run missing (0)] [Export]│
├────────────────────┬──────────┬──────────┬──────────┬───────────┬────────┬───────┤
│ input              │ v1 w=1   │ v2 w=1   │ v3 w=0   │ composite │ spread │ label │
│                    │ Is it an │ Does it  │ Apple    │           │        │       │
│                    │ apple?   │ describe…│ (fruit)? │           │        │       │
├────────────────────┼──────────┼──────────┼──────────┼───────────┼────────┼───────┤
│ Green sour crisp…  │ 0.62 REV │ 0.81 YES │ 0.88 YES │ 0.72 REV  │  0.26  │ yes   │
│ Red round veg      │ 0.21 NO  │ 0.18 NO  │ 0.03 NO  │ 0.20 NO   │  0.18  │ no    │
│ Red crisp sweet…   │ 0.93 YES │ 0.95 YES │ 0.97 YES │ 0.94 YES  │  0.04  │ —     │
├────────────────────┼──────────┼──────────┼──────────┼───────────┼────────┼───────┤
│ mean               │ 0.59     │ 0.65     │ 0.63     │ 0.62      │        │       │
│ yes / review / no  │ 4/3/3    │ 6/1/3    │ 6/0/4    │ 5/2/3     │        │       │
│ acc (n=6) · review │ 75% · 33%│ 100% · 17%│ 83% · 0%│ 80% · 17% │        │       │
│ best thr · Brier   │ .58 · .14│ .70 · .06│ .40 · .11│ .65 · .08 │        │       │
│                    │ [use]    │ [use]    │ [use]    │ [use]     │        │       │
└────────────────────┴──────────┴──────────┴──────────┴───────────┴────────┴───────┘
 [+ input] [Import…]   [+ variant] [Duplicate & edit v2]
```

### Interactions

| Control | Behavior | Requests? |
|---------|----------|-----------|
| Threshold handles | Re-band all cells; update counts and metrics; a column header menu offers "override threshold" | none |
| Column weight (header field, 0–5, step 0.5) | Recompute the composite column and its metrics | none |
| Sort (column, composite, spread, label, input) | Reorder rows | none |
| Filters | Hide rows; footer stats then cover visible rows only and say "n of N" | none |
| Hide/show column | Excluded from spread, composite and agreement | none |
| Pivot | Variants become rows, inputs become columns; same values and bands | none |
| Values/Cost toggle | Cells show row cost and tokens; column header shows a "≈ share" | none |
| Model ▾ | Show one model's cells, or "compare" (column groups per model) | none |
| Focus option ▾ (Choice) | Which option the cell probability is about | none |
| Label cell | Inline select (yes/no, option, level). Metrics update | none |
| Click a cell | Side panel shows the full answer (all probabilities, confidence), run id, model, cost, and "open in History" | none |
| Run missing (N) | Shows requests, estimated cost and a Confirm step, then fills cells progressively (parallelism from prefs) | yes |
| Retry (on failed row) | Re-sends that row's missing columns | yes |
| Save view… | Stores the current view under a name; the dropdown switches views | none |
| Export | CSV of the current view (visible rows/cols, values, composite, spread, label, metrics block) | none |

Every view change autosaves to the experiment (debounced). Reopening the experiment restores it exactly.

### Cell rendering

- Background is a sequential heat scale from 0 to 1, in one hue. The band is shown as a text tag (YES, REV, NO). Misclassified cells get a thick outline and a "✕" glyph. Information is never carried by color alone.
- Choice: `0.91 apple`. If another option won, the cell shows `0.31 ↯pear`.
- Score: `0.67 · "sweet"` (normalized position · nearest level name).
- Empty cell: `·` (not run). Failed cell: `!` with the error on hover or focus.
- Cells answered by mixed model versions: a small dot, explained in the cell panel.

### No-label mode

Footer rows `acc`, `best thr` and `Brier` are replaced with `agreement` (the share of rows where all visible variants fall in the same band). The "misclassified" filter is hidden.

## Other views

| View | Contents |
|------|----------|
| **Run** | Single-run editor (input, questions of any type including Box, model), the guide card for the focused question's type, results. "Add to experiment…" creates an experiment, or appends this input as a row and these questions as columns. |
| **Experiments** | List (name, type, size, cost, updated); New, Duplicate, Delete |
| **History** | Filters; paged list; detail with "Open in editor", note/tags and delete; select runs → **Open as matrix** (pick type) · Export CSV/JSONL; totals |
| **Settings** | Theme, text size, probability format and decimals, default model, price per Mtok, parallelism, reset |
| **Compare types** | Dialog with 4 guide cards side by side (stacked on narrow screens) |

## Single-run result rendering

| Type | Main | Detail |
|------|------|--------|
| Noul | P(yes) bar + value | yes/review/no tag using the default thresholds 0.5 / 0.8 |
| Choice | Chosen option | All options as sorted bars; confidence |
| Score | Marker on a level scale | Per-level bars; confidence; a "split" hint when the top 2 levels are non-adjacent and each ≥ 0.25 |
| Box | Image + SVG rectangle | Confidence; "Add presence check" |

## Guide card content (fixed)

| Type | Asks | Returns | Use when | Pitfall |
|------|------|---------|----------|---------|
| Noul | Is this true? | P(yes) 0–1 | Clean yes/no condition | 0.5 = "unsure", not "medium amount". Use a Score for degree. |
| Choice | Which one? | Option + probabilities + confidence | Known, unordered options | It always picks one. Pair it with a Noul "does any option fit?". |
| Score | Which level? | Position + level probabilities + confidence | Ordered levels you can describe | Each level must be concrete. Watch for split answers. |
| Box | Where in the image? | Edges as fractions + confidence | Locate one object in a PNG/JPEG | It always returns a box. Pair it with a Noul "is it there?". |

## Keyboard

`Ctrl+Enter` run (Run view) / run missing (dashboard, still confirms) · `Ctrl+N` new · `Ctrl+H` History. Arrow keys move between grid cells, and `Enter` opens the cell panel. All controls are reachable with Tab and have visible focus.
