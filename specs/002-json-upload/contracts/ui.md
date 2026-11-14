# Contract: library picker and entry points

## Entry points

| Place | Button | Opens on | Position |
|-------|--------|----------|----------|
| Run → Input panel | **Load JSON** | `inputs` | Next to "Attach image" |
| Run → Questions panel | **Load questions** | `questions` | In the panel header |
| Experiment → Setup → Add inputs | **Load JSON** | `inputs` | Next to "Import .txt / .csv" |
| Experiment → Setup → Add variant | **Load questions** | `questions` | Next to the add-variant button |

## Picker dialog (`<dialog id="lib">`, modal)

```
┌ Load JSON · inputs ─────────────────────────────────────────────────────────── [✕] ┐
│ E:\my products\jev_tests\data\json\inputs   [Open folder] [Refresh]                 │
├──────────────────────────────┬──────────────────────────────────────────────────────┤
│ ▸ ticket_01.json   412 B     │ tickets/refunds.json · list · 40 records · 6 fields  │
│ ▸ tickets/                   │ · depth 3                                            │
│   refunds.json  1.8 KB  ●    │ ⚠ key `priority` appears twice in one object         │
│   batch.json   2.2 MB  TOO   │ [Structure | Raw]                                    │
│     LARGE (limit 1 MB)       │ ticket            object                 40/40       │
│ ▸ broken.json      INVALID   │   subject         text   "Refund"        40/40 [⧉]   │
│                              │   priority        number 2               31/40 [⧉]   │
│                              │   tags            list of text (1)       40/40 [⧉]   │
│                              │ Record: [#3 · subject: Late delivery ▾] (Run only)   │
├──────────────────────────────┴──────────────────────────────────────────────────────┤
│                                                     [Cancel]  [Load record #3]      │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

### Behavior

- **Opening**: the dialog fetches the listing. `lastFile[place]` is preselected and its analysis fetched. Focus goes to the file list.
- **File list**: a `listbox`. Arrow keys move the selection, and each move fetches the analysis (the last request wins). `too_large` and `ok: false` files are listed with a text tag (never color alone) and can be selected to read the reason.
- **Unusable file**: the preview shows `error.message` and "line L, column C". The confirm button is disabled, with that reason as its title.
- **Structure tab** (inputs): a tree from `fields`, indented by depth. Each row shows path tail, type, sample and `count/records`. Partial counts are tagged `PARTIAL`. Above 200 descriptors, objects start collapsed (`<details>`). Samples are cut to one line with an ellipsis, and a "show all" toggle shows the full value. A **⧉** button copies the full path and announces "Copied ticket.subject" in a live region.
- **Questions tab** (questions): one card per question with ID, type tag, full wording (structured wording pretty-printed), and criteria. Choice shows option and description, Score its levels in order, Noul its yes/no meanings. Each card carries a validity tag (`VALID` / `INVALID` + errors) and its notes.
- **Raw tab**: `<pre>` holding `pretty`, read-only.
- **Warnings**: a list above the tabs.
- **Record selector** (Run → Input, list files only): a search field (record number, or text in `recordSummary`) and a `<select>` of matches, capped at 200 with a "refine the search" note. The confirm label names the record.
- **Empty folder**: "No JSON files in this folder yet", with the path and Open folder.
- **Confirm**: the dialog re-fetches the file, and if it changed the new analysis is shown first. It then closes and runs the place's load action. A `404` on re-fetch shows "the file was removed" and keeps the dialog open.
- **Close**: Cancel, ✕ or Escape. Focus returns to the button that opened the dialog.

### Confirm labels

| Place | Label |
|-------|-------|
| Run → Input | `Load` or `Load record #n` |
| Run → Questions | `Load n questions` |
| Exp → inputs | `Add n rows` |
| Exp → questions | `Add k variants` (k = matching questions; skipped ones listed in the preview under "Will be skipped") |

## Load actions

- **Run → Input**:
  1. If the input is non-empty, `confirmDialog("Replace the input?", …, "Replace")`.
  2. Set the draft to JSON fields with the record pretty-printed.
  3. Warn in the panel hint, without blocking, if the record has a top-level `image` key while an image is attached.
- **Run → Questions**:
  1. If any question has wording, show a three-way dialog: `Replace` / `Add` / `Cancel`.
  2. On Add, rename colliding IDs with `freeId` (`urgency` → `urgency_2`) and show the renames in a hint.
  3. Invalid questions load as they are, and the editor shows its usual errors.
- **Exp → inputs**: `saveDoc` with the rows appended. Then the Setup hint reads "n rows added" (and "m merged as repeats" when some were merged). It also warns about `reference` if the experiment has a reference and a record has that key.
- **Exp → questions**: `matchQuestions`, then `saveDoc`. The Setup hint lists the added count and each skipped ID with its reason.

## Matrix row label

JSON rows show `recordSummary(fields)` instead of raw JSON. A tooltip holds the compact JSON. Sorting and search are unchanged and use the full text.
