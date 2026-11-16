# Quickstart: Experiment Steps

## Run

```powershell
uv run python -m jevbench          # opens the app
python -m unittest tests.test_core # server tests (TestSteps)
node --test "tests/*.test.mjs"     # metrics tests
```

## Checks (agent browser pass after implementation)

1. **Unchanged single step**: open an existing experiment. The matrix, numbers, export and Run missing count match `main`. The only new element is **+ Add step** at the bottom.
2. **noul → noul**:
   - make 10 text inputs with one Noul variant, and Run missing;
   - click **+ Add step**, then add a Noul variant to step 2;
   - step 2 lists exactly the rows whose step 1 gate column says `passes`;
   - Run missing (n) in step 2 equals that count.
3. **Live re-filter**:
   - drag step 1's high threshold down: step 2 gains rows, the funnel updates, and the Network tab shows only the debounced PUT;
   - drag it back: step 2's answered cells return with no new run.
4. **Review toggle**: rows with step 1 `p` between low and high appear in step 2 only when "review passes" is on.
5. **Score gate**:
   - add a Score step (3 levels) after step 2, and run it;
   - set "Pass at level ≥ 1";
   - a row with probabilities `{0: .1, 1: .5, 2: .4}` has `p = 0.90` and passes at high = 0.8.
6. **Choice gate**:
   - add a Choice step (apple/pear/tomato), and mark apple and pear as passing;
   - `p` = P(apple) + P(pear);
   - unchecking every option shows the "no row can pass" warning.
7. **Filters don't gate**: set step 1's text filter so that only 2 rows show. Step 2 still lists every passing row.
8. **Remove step 2** of 3: step 3 now takes rows from step 1. History still lists step 2's runs.
9. **Duplicate** a 3-step experiment: the copy has the same chain, setups and gate settings. The list shows "Noul → Score → Choice".
10. **Run chain** on a fresh 3-step chain:
    - the confirm shows step 1's exact count and "at most" for steps 2–3;
    - after the run, the funnel equals a step-by-step run.
11. **Export chain CSV**: one line per input, with outcome and p per step, and `did not reach` after the step where a row stopped.
12. **Lock**: after step 2 has answers, its type select is disabled. A PUT that changes its criteria returns 409.

## Example numbers for tests (FakeJev canned answers)

- Noul: `noul = 0.93` → passes at the default threshold (0.5 / 0.8).
- Score (3 levels): probabilities `{0: 0.0, 1: 0.57, 2: 0.43}`:
  - min level 1 → p = 1.00 → passes;
  - min level 2 → p = 0.43 → stops (< 0.5);
  - min level 2 with low 0.4 → review → passes only with review on.
- Choice: `{apple: 0.91, pear: 0.06, tomato: 0.03}`:
  - {apple} → 0.91 → passes;
  - {pear, tomato} → 0.09 → stops.
