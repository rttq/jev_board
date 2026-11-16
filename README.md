# jevbench

A local workbench for TypeSafe's Jev model. Run single questions of all four types (Noul, Choice, Score, Box), compare wordings across many inputs in an experiment matrix, label rows to measure accuracy, and keep every request and its cost in History.

## Launch

```powershell
$env:TYPESAFE_API_KEY = "ts-..."   # or put TYPESAFE_API_KEY=ts-... in .env at the project root
uv sync
uv run jevbench                     # opens http://127.0.0.1:8765
```

Options: `--port 8799`, `--data-dir <folder>`, `--no-browser`. Without a key, the type guide and History still work.

## Where data lives

Everything stays on your machine, in `data/` at the project root (gitignored):

- `data/jevbench.db`: runs, experiments, labels, saved views and settings (SQLite)
- `data/images/`: images sent with Box runs, named by their SHA-256
- `data/json/inputs/`, `data/json/questions/`: your JSON library (see below)

Delete the folder to start fresh.

## JSON library

Keep prepared files in `data/json/` (created on first start) and load them with **Load JSON** / **Load questions**
in the Run view and in an experiment's Setup. The picker shows what each file holds before you load it.
The app only reads these files; it never changes or deletes them. Files over 1 MB are not loaded.

`data/json/inputs/`: one input (an object) or many (a list of objects). In an experiment a list becomes one row
per object; in the Run view you pick one record. The preview lists every field path (`ticket.customer.tier`,
`messages[].author`) with its type, a sample and how many records have it. Click ⧉ to copy a path for your wording.

```json
{"ticket": {"subject": "Refund for order 1182", "priority": 2, "tags": ["billing"]}}
```

`data/json/questions/`: question IDs mapped to questions, the same shape History exports.
In an experiment only questions with its type and criteria become variants; the rest are listed as skipped.

```json
{
  "urgent": {"type": "noul", "instructions": "Is the customer blocked right now?"},
  "area":   {"type": "choice", "instructions": "Which team owns `ticket.subject`?",
             "criteria": {"billing": "money, invoices, refunds", "tech": null, "sales": null}},
  "mood":   {"type": "score", "instructions": "How upset is the customer?", "criteria": ["calm", "annoyed", "angry"]}
}
```

The full rules, ready to paste into a prompt when an AI writes these files, are in [docs/json-format.md](docs/json-format.md).
Files must be UTF-8 (with or without BOM). Syntax errors show their line and column; duplicate keys and
integers beyond 2^53 (which the browser rounds) are flagged as warnings.

## Experiment steps

An experiment can be a chain of steps, e.g. Noul → Score → Choice. Click **+ Add step** at the bottom of the
experiment page. Each step is a full matrix with its own type, criteria, variants, thresholds and labels. A step only
gets the inputs that pass the **gate** of the step before, so later questions cost nothing for inputs that dropped out.

A gate turns each input's answers (visible variants, weighted like the composite) into one pass likelihood:

- **Noul**: P(yes).
- **Score**: P(level ≥ the minimum level you pick). The default is the middle level.
- **Choice**: P(one of the options you mark as passing). The default is the focus option.

The step's own thresholds decide the outcome. At or above high, the input passes. Below low, it stops. In between
is review, which stops unless **review passes** is ticked. An input waits until every visible variant has an answer.
Filters and sorting only change what a matrix shows; they never change who passes.

Moving a threshold or changing a gate re-filters every later step at once. Answers that were already paid for come
back with no new request. The funnel under the last step shows in / passed / stopped / waiting per step.
**Export chain CSV** gives one line per input with its outcome at every step. **Run chain** runs every step in
order. Its confirm shows step 1's cost and an upper bound for the later steps.

Step 1 holds the inputs and the shared reference, so it can't be removed. Later steps can be renamed,
collapsed or removed (their answers stay in History).

## Tests

```powershell
uv run python -m unittest discover -s tests   # server, storage, cost, export, JSON library (no API key needed)
node --test "tests/*.test.mjs"                # dashboard metrics, library helpers
```

Optional live check against the real API (costs a fraction of a cent):

```powershell
$env:JEVBENCH_LIVE = "1"; uv run python -m unittest tests.test_core.LiveSmoke
```
