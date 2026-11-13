# Quickstart: Jev Classification Workbench

## Setup

```powershell
$env:TYPESAFE_API_KEY = "ts-..."     # or put it in ~/.jevbench/api_key (one line)
uv sync
uv run jevbench                       # opens http://127.0.0.1:8765
```

Without uv: `pip install -e .` then `jevbench` (or `python -m jevbench`).

## Automated checks (no API key needed)

```powershell
uv run python -m unittest discover -s tests   # store, hashes, cells, from-runs, 409, cost, export
node --test "tests/*.test.mjs"                            # metrics.js: bands, spread, composite, accuracy, best threshold, Brier, MAE
```

Opt-in live contract check (real API, a fraction of a cent). It confirms the real response shape and that the test fakes still match it:

```powershell
$env:JEVBENCH_LIVE = "1"; uv run python -m unittest tests.test_core.LiveSmoke
```

## Browser checks (during implementation)

At the US1, US4 and US6 checkpoints and at the end, the coding agent drives the real page with the Playwright MCP tools against a throwaway data dir (`--data-dir .checks/data --port 8799`). It asserts the steps below, captures light, dark and phone-width screenshots to `.checks/`, and logs pass/fail to `.checks/REPORT.md` (gitignored).

## Manual verification (maps to spec user stories)

1. **US1 single run**: Input `A round red fruit with a crisp, sweet bite`. Noul ``Is `text` describing an apple?`` → a high %, `jev-1.14.0`, tokens and cost. Add a Choice and a Score → one request, one cost. Unset the key → setup message, nothing recorded.
2. **US2 guide**: Switching type changes the card. "Compare types" shows 4 cards. Box with no image → Run is disabled with the reason.
3. **US3 matrix**: New experiment "apple-wording", Noul. Paste 10 fruit descriptions and 3 variants (`Is it an apple?`, `Does this describe an apple?`, `Apple (the fruit)?`) → the estimate appears → confirm → a 10 × 3 heatmap with spread. Add a 4th variant → "Run missing (10)" sends only those cells. Edit v2's wording → a new column appears and v2 is kept.
4. **US4 live controls**: Note the all-time cost. Move the high handle 0.8 → 0.9, set v3 weight 0, sort by spread, pivot, toggle Cost → everything updates instantly, **the cost is unchanged, and History has no new runs**. Save the view "strict 0.9" → restart → switch to it → restored exactly.
5. **US5 labels**: Label 6 rows → metrics show `n=6`. Click "use" on the best threshold → the bands update. Filter "misclassified" → click a cell → the run opens.
6. **US6 History → matrix**: In Run, test 2 inputs × 3 wordings (6 runs). History → select them → Open as matrix (Noul) → a filled 2 × 3 grid with $0 added.
7. **US7 cost**: Session total = the sum of runs. The experiment total = the sum of its runs.
8. **US8 data**: Restart → runs, experiments, labels and views are all present. Export History CSV (one row per question) and the matrix CSV (as displayed + metrics block).
9. **US9 Box**: Apple photo, Box ``the apple in `image` `` → a rectangle is drawn. "Add presence check" adds a Noul.

## Where things live

| What | Where |
|------|-------|
| Code | `jevbench/` |
| Data | `~/.jevbench/jevbench.db`, `~/.jevbench/images/` |
| Tests | `tests/test_core.py`, `tests/metrics.test.mjs` |
