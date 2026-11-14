# Research: JSON Library (002)

No `NEEDS CLARIFICATION` remained in Technical Context. Each decision below settles one design question raised by the spec.

## R1. Where files are parsed and checked

- **Decision**: On the server (new `jevbench/library.py`), with stdlib `json`. The browser receives a finished analysis: the parsed records or questions, a field tree, warnings and a formatted text.
- **Rationale**: These checks are the main point of the feature. Python's `json` covers them in a few lines:
  - `JSONDecodeError` gives `lineno` and `colno` for syntax errors (FR-022).
  - `object_pairs_hook` sees duplicate keys before the dict drops one (FR-025).
  - `parse_int` sees each integer as written, so it can flag those beyond 2^53, which the browser would round (FR-025).
  - `parse_constant` rejects `NaN` and `Infinity`, which Python's `json` would otherwise accept but standard JSON forbids.
  - Decoding the bytes with `utf-8-sig` accepts a byte-order mark (FR-023).

  In the browser, `JSON.parse` gives no positions in some engines, keeps the last duplicate silently and rounds large integers. Reusing `jev.validate_questions` also gives question files exactly the run endpoint's rules (FR-020).
- **Alternatives**: Parsing in the browser. Rejected because it cannot meet FR-022/025. A JSON Schema library is a new dependency for a two-shape format.

## R2. "A new window" with the folder

- **Decision**: An in-app modal `<dialog>`, the same element `confirmDialog` uses, listing files the server reads from the library folder.
- **Rationale**: `<input type=file>` cannot start in a chosen folder. `showOpenFilePicker({startIn})` only accepts well-known folders or a handle from an earlier pick, and Firefox lacks it. A native dialog also cannot show the structure preview. `<dialog>` with `showModal()` gives focus trapping, Escape-to-close and an inert background for free (FR-010).
- **Alternatives**: OS file dialog (above). A separate browser window via `window.open`: popup blockers, and a second page to keep in sync.

## R3. Folder layout and kind

- **Decision**: `<data_dir>/json/inputs/` and `<data_dir>/json/questions/`. Both are created with `mkdir(parents=True, exist_ok=True)` on every list request (FR-001, edge case "deleted while running"). A file's kind comes from its folder.
- **Rationale**: This follows the clarified spec. Telling kinds apart by content is ambiguous: an object of objects is a valid input. The only content heuristic is a *warning* when an input file looks like questions (FR-017).

## R4. Path safety

- **Decision**: The browser sends a path relative to the kind's root. The server resolves `root / rel` and accepts it only when:
  - the resolved path is inside `root.resolve()` (`is_relative_to`);
  - its suffix is `.json`;
  - it is a regular file.

  Listing uses `rglob("*.json")` and applies the same filter, so a link pointing outside the folder is neither listed nor readable (FR-005). Nothing is ever written (FR-006).
- **Rationale**: This is the only trust boundary the feature adds, even on localhost. A `..` path or a link is the classic escape.

## R5. Field paths in the preview

- **Decision**: Dot paths with `[]` for list items: `ticket.customer.tier`, `ticket.tags`, `messages[].author`. Each descriptor holds:
  - `path` and `type`. The type is one of `text`, `number`, `boolean`, `null`, `list`, `object`, or `mixed` when records disagree.
  - `sample`: the first value seen.
  - `count`: how many records contain the path.
  - `items` (lists only): length and item type.
- **Rationale**: The app already tells users to refer to fields as `ticket.subject` (Run view hint). Jev reads questions in natural language, so the path is a naming aid, not a query language.

## R6. Large integers

- **Decision**: Warn, listing up to 5 offending values ("12345678901234567890 is beyond 2^53 and will be rounded to 12345678901234567000"). Loading is not blocked.
- **Rationale**: The value crosses the browser as a JS number, so rounding at that point cannot be avoided without changing the run path. Saying so is what "never silently rounded" requires. Keeping integers exact through the browser would need a custom JSON transport for one rare case.

## R7. Question files into experiments

- **Decision**: The browser does the matching (pure `matchQuestions` in `metrics.js`). It then calls the existing `saveDoc` with new `columns`, plus `type` and `criteria` when the experiment has no variants yet. Questions are compared on type and canonical criteria: object keys sorted, list order kept.
- **Rationale**: `saveDoc` → `PUT /api/experiments/{id}` already validates, merges repeated wordings and reports warnings (FR-034). It also refuses criteria changes after answers exist. A server route would duplicate all of that.
- **Alternatives**: A `POST …/columns/from-library` route. Rejected as duplicate logic.

## R8. Opening the folder in the file manager

- **Decision**: `POST /api/library/{kind}/reveal` runs one of:
  - `os.startfile(root)` on Windows;
  - `subprocess.Popen(["open", root])` on macOS;
  - `subprocess.Popen(["xdg-open", root])` elsewhere.

  Only the two fixed roots can be opened. If opening fails, the dialog keeps showing the path so the user can open it by hand.
- **Rationale**: The browser cannot open local folders. The server is local and the path is not user-chosen.

## R9. Freshness and caching

- **Decision**: No cache. Each list request reads the folder, and each file request reads and analyzes the file. Confirming re-fetches the file (FR-027).
- **Rationale**: Files are at most 1 MB and only one user reads them, so a read takes milliseconds. A cache would add an invalidation bug for no gain.

## R10. Readable summaries of JSON records

- **Decision**: A pure `recordSummary(fields)` in `metrics.js`. It returns the first non-empty text value found depth-first, prefixed by its key (`subject: Refund for order…`) and cut to 80 characters, or compact JSON when there is no text. It labels the record selector (Run view) and JSON rows in the matrix. Sorting and search keep using the full text (`inputText`).
- **Rationale**: One function serves both places. Raw JSON as a row label is what US3 AS3 rules out.
