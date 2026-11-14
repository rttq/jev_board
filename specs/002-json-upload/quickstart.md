# Quickstart: JSON Library (002)

Setup is unchanged from 001 ([../001-jev-classification-gui/quickstart.md](../001-jev-classification-gui/quickstart.md)). After the first start, the library folders exist:

```text
data/json/inputs/      # put input files here (an object, or a list of objects)
data/json/questions/   # put question files here ({"id": {"type", "instructions", "criteria"}})
```

## Example files

`data/json/inputs/ticket_01.json`:

```json
{"ticket": {"subject": "Refund for order 1182", "priority": 2, "tags": ["billing"],
            "customer": {"tier": "pro", "name": "Ольга"}}}
```

`data/json/questions/triage.json`:

```json
{
  "urgent": {"type": "noul", "instructions": "Is the customer blocked right now?",
             "criteria": {"true": "cannot use the product", "false": "a question or a wish"}},
  "area":   {"type": "choice", "instructions": "Which team owns `ticket.subject`?",
             "criteria": {"billing": "money, invoices, refunds", "tech": null, "sales": null}},
  "mood":   {"type": "score", "instructions": "How upset is the customer?",
             "criteria": ["calm", "annoyed", "angry"]}
}
```

## Automated checks (no API key needed)

```powershell
uv run python -m unittest discover -s tests   # + TestLibrary: listing, path escape, every validation rule, field tree, question checks
node --test "tests/*.test.mjs"                # + recordSummary, matchQuestions, freeId
```

`TestLibrary` builds its fixture files in a temporary data dir. They include a BOM, UTF-16, Cyrillic, emoji, a big integer, NaN, duplicate keys, deep nesting, `[]`, `{}`, a mixed list, a link outside the folder, a question file in `inputs/`, and an unwrapped question. This set is SC-003's test set of at least 20 files.

## Browser checks (agent, Playwright MCP, `--data-dir .checks/data --port 8799`)

Copy the two example files above into `.checks/data/json/…`, plus `refunds.json` (a list of 40 objects, `priority` missing in 9) and `broken.json` (a missing comma on line 4).

| # | Story | Steps | Expect |
|---|-------|-------|--------|
| 1 | US1 | Run → Load JSON → `ticket_01.json` → Load | Input is in Fields (JSON) mode with the object, and `Ольга` is intact |
| 2 | US1 | Same with `refunds.json`, choose record #3 | Only record 3 is loaded, and the confirm label read "Load record #3" |
| 3 | US1 | Add a file to the folder with the dialog closed, reopen | The new file is listed |
| 4 | US2 | Select `refunds.json` | `ticket.priority` shows `31/40 PARTIAL`, the summary line reads 40 records |
| 5 | US2 | ⧉ on `ticket.subject` | Clipboard holds `ticket.subject`, and "Copied" is announced |
| 6 | US5 | Select `broken.json` | Error shows line 4 with a column, and confirm is disabled |
| 7 | US3 | Experiment → Setup → Load JSON → `refunds.json` → Add 40 rows | 40 rows, labelled `subject: …`, not raw JSON |
| 8 | US4 | Run → Load questions → `triage.json` → Replace | 3 questions, criteria identical to the file |
| 9 | US4 | Choice experiment with criteria billing/tech/sales → Load questions → `triage.json` | 1 variant added. `urgent` and `mood` are skipped as "other type" |
| 10 | — | Keyboard only: open, move with arrows, Escape | Focus is trapped while open and returns to the button |

Capture light, dark and phone-width screenshots of the dialog to `.checks/`, and log the results to `.checks/REPORT.md`.
