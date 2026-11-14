# Data Model: JSON Library (002)

Nothing new is stored in SQLite. Library files live on disk and are read on demand. Loaded content becomes the existing structures: the Run view draft, experiment `rows`, and experiment `columns`, `type` and `criteria`.

## Library folders (disk)

```text
<data_dir>/json/
├── inputs/        # input files, any subfolders
└── questions/     # question files, any subfolders
```

Both are created on demand. The app only reads them.

## File listing entry

| Field | Type | Notes |
|-------|------|-------|
| `path` | str | Relative to the kind's root, `/` separators, e.g. `tickets/refund_01.json` |
| `size` | int | Bytes |
| `mtime` | str | ISO-8601 local time |
| `too_large` | bool | `size > 1_048_576` |

Sorted by `path`, case-insensitive.

## File analysis (response of the file route)

| Field | Type | Notes |
|-------|------|-------|
| `path`, `kind`, `size`, `mtime` | | As in the listing; `kind` ∈ `inputs`, `questions` |
| `ok` | bool | `false` means it cannot be loaded; `error` says why |
| `error` | `{message, line?, col?}` \| null | Plain-words reason; `line`/`col` for syntax errors |
| `warnings` | [str] | Non-blocking (see the validation rules) |
| `pretty` | str \| null | `json.dumps(value, indent=2, ensure_ascii=False)`; integers exact |
| `inputs` | object \| absent | Only for `kind=inputs` and `ok` |
| `questions` | object \| absent | Only for `kind=questions` and `ok` |

### `inputs`

| Field | Type | Notes |
|-------|------|-------|
| `shape` | `"object"` \| `"list"` | Top level of the file |
| `records` | [object] | 1 for `object`, n for `list`, in file order |
| `fields` | [FieldDescriptor] | Depth-first, in first-seen key order |
| `depth` | int | Maximum nesting depth (a flat object is 1) |

### FieldDescriptor

| Field | Type | Notes |
|-------|------|-------|
| `path` | str | `a.b`, list items as `a[]`, e.g. `messages[].author` |
| `type` | str | `text`, `number`, `boolean`, `null`, `list`, `object`, or `mixed` |
| `types` | [str] | Only when `type == "mixed"` |
| `sample` | any | First scalar value seen (absent for `object`/`list`) |
| `count` | int | Records containing the path. Partial when `< len(records)` |
| `items` | `{n, type}` | Lists only: length in the first record seen, and item type |

### `questions`

An ordered map `question_id → PreparedQuestion`.

| Field | Type | Notes |
|-------|------|-------|
| `wire` | object | `{type, instructions, criteria?}`, exactly as in the file |
| `valid` | bool | `jev.validate_questions` passes (checked with an image present, model `jev-latest`) |
| `errors` | [str] | The editor's messages |
| `notes` | [str] | E.g. Box: "needs an image in the Run view; skipped in experiments" |

## Validation rules

### All files (blocking → `ok: false`)

| Rule | Message (abridged) |
|------|--------------------|
| Path outside the root, not `.json`, or not a file | 400 / 404 (route error, not an analysis) |
| `size > 1 MB` | "file is 1.4 MB; the limit is 1 MB" |
| Starts with a UTF-16/32 BOM | "file is saved as UTF-16; save it as UTF-8" |
| Not valid UTF-8 | "file is not UTF-8 (first bad byte at position N)" |
| Empty or whitespace only | "file is empty" |
| `JSONDecodeError` | the decoder's message, with `line` and `col` |
| `NaN`, `Infinity`, `-Infinity` | "NaN/Infinity is not valid JSON", with position |
| `RecursionError` | "nested too deeply to read" |

### All files (warnings)

- Duplicate key: "key `x` appears twice in one object; the last value is used". Listed once per key.
- Integer beyond ±2^53: shows up to 5 values and the rounded value each will become.

### Input files

| Rule | Kind |
|------|------|
| Top level is an object → 1 record | — |
| Top level is a non-empty list of objects → n records | — |
| `[]` | blocking: "the file holds no records" |
| List with a non-object item | blocking: "item 7 is a number; every item must be an object" |
| Any other top level | blocking: "top level is a text; expected an object or a list of objects" |
| A record is `{}` | warning: "record 3 has no fields" |
| Every top-level value is `{type, instructions}` | warning: "looks like a question file; move it to questions/" |

Collisions with `image` and `reference` are checked in the browser at load time, because only the browser knows whether an image is attached or the experiment has a reference.

### Question files

| Rule | Kind |
|------|------|
| Top level is not an object, or is `{}` | blocking |
| A value is not an object, lacks `type` or `instructions`, or has a `type` outside noul/choice/score/box | blocking: names the question ID |
| The file looks like a single unwrapped question (top level has `type` and `instructions`) | blocking: shows the expected shape `{"my_id": {…}}` |
| A question fails `jev.validate_questions` | per question `valid: false`, file still `ok` |

## Mapping into existing structures

| Target | Mapping |
|--------|---------|
| Run view input | `draft.kind = "json"`, `draft.fields = JSON.stringify(record, null, 2)` |
| Experiment rows | `saveDoc({rows: [...rows, ...records.map(f => ({input: {kind: "json", fields: f}}))]})`. The server merges repeats and warns |
| Run view questions | `fromWire(id, wire)` per question. Replace, or add with `freeId` renaming |
| Experiment variants | `matchQuestions(exp, questions)` → `{columns: [{instructions}], type?, criteria?, skipped: [{id, reason}]}` → `saveDoc` |

## Session state (browser memory only)

`lastFile[place]`, where `place` ∈ `run-input`, `run-questions`, `exp-input`, `exp-questions`. It is the relative path the picker preselects (FR-035) and is gone on reload.
