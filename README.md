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

Delete the folder to start fresh.

## Tests

```powershell
uv run python -m unittest discover -s tests   # server, storage, cost, export (no API key needed)
node --test "tests/*.test.mjs"                # dashboard metrics
```

Optional live check against the real API (costs a fraction of a cent):

```powershell
$env:JEVBENCH_LIVE = "1"; uv run python -m unittest tests.test_core.LiveSmoke
```
