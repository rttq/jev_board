# Feature Specification: Jev Classification Workbench (local GUI)

**Feature Branch**: `001-jev-classification-gui`

**Created**: 2026-11-13

**Status**: Draft (rev 2: "UX adaptation" redefined as an adaptable analysis dashboard)

**Input**: User description: "Simple local GUI for Jev (https://docs.typesafe.ai/), launched from a terminal. Purposes: (1) test proposals against the different Jev classification types (user believes there are 3; verify the actual number); (2) view results per classification, e.g. how certain a description of an apple is (0-95%) relative to a proposition; (3) show cost of each task; (4) collect/persist data on these tasks; (5) decision support: a small visual description of each classification type. Very simple visual style with deep UX adaptation options."

**Revision note (user clarification)**: "Deep UX adaptation" means adapting the **analysis of outcomes** through a dashboard, not fonts and colors. The first dashboard view is a **wording variants × inputs matrix**. Labels are optional per input. Live controls: threshold, weights/composite, pivot/sort/filter, cost overlay. A matrix can be designed and run, or assembled from saved History.

## Correction to the brief: Jev has four question types, not three

The current Jev release (`jev-1.14.0`, the `jev-latest` alias) supports **four** question types:

| Type | Answers the question | Returns |
|------|----------------------|---------|
| **Noul** | "Is this true?" | Probability of *yes* (0–1). No separate confidence value. |
| **Choice** | "Which of these options?" | The chosen option, a probability for each option, and confidence |
| **Score** | "Which level on this ordered scale?" | A position on the scale (can sit between levels), a probability for each level, and confidence |
| **Box** | "Where is it in this image?" | Four edges as fractions of the image, and confidence. Image input only, Jev 1.14+. |

The user's "apple description from 0 to 95% certainty" example is a **Noul**.

## Clarifications

### Session 2026-11-13

- Q: What does "deep UX adaptation" mean? → A: An analysis dashboard whose views the user reshapes, not visual styling.
- Q: Which matrix comes first? → A: Wording variants × inputs (columns are alternative phrasings of one proposition, rows are inputs).
- Q: Will the user supply expected answers? → A: Sometimes. Labels are optional per input, and metrics that need them appear only when they exist.
- Q: Which live controls are needed without re-running Jev? → A: Threshold, weights/composite score, pivot/sort/filter, cost overlay.
- Q: Where does matrix data come from? → A: Both: design a grid and run it, or assemble one from saved History.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Test one proposition against one input (Priority: P1)

The user starts the workbench from a terminal and it opens in the browser. They paste an input (e.g. "A round red fruit with a crisp, sweet bite"), pick a question type (Noul by default), write a proposition ("Is this describing an apple?"), add options or levels for Choice or Score, and press Run. The result appears in a moment as a readable certainty value with a bar, plus per-option or per-level probabilities and confidence where the type has them. The answering model version and the cost show beside the result. From the result, the user can send the input and question into a new or existing experiment (US5).

**Why this priority**: This is the core loop and the quickest way to try a proposition.

**Independent Test**: With a valid API key, run a Noul on the apple example and see a probability, the model version and a cost.

**Acceptance Scenarios**:

1. **Given** a valid API key, **When** the user runs Noul "Is this describing an apple?" on an apple description, **Then** P(yes) appears as a value with a bar, plus cost and model version.
2. **Given** a Choice with "apple / pear / tomato", **When** run, **Then** the chosen option, all option probabilities ranked, and confidence appear.
3. **Given** a Score with 4 ordered levels, **When** run, **Then** the position on the scale, per-level probabilities and confidence appear.
4. **Given** several mixed-type questions, **When** run, **Then** all answers return from one request with one cost.
5. **Given** the API key is missing or invalid, **When** the user runs a test, **Then** a plain fix-it message appears and no successful run is recorded.

---

### User Story 2 - Read the type guide and choose a type (Priority: P1)

Each question type has a short card (2–4 lines and a small diagram): what it asks, what comes back, when to use it, and one common mistake. The card for the selected type stays visible while editing. A comparison view shows all four side by side.

**Why this priority**: Decision support was asked for explicitly, and it prevents picking the wrong type or misreading the numbers.

**Independent Test**: Open the guide without an API key and check that all four types are described, each with a diagram and a "use when" line.

**Acceptance Scenarios**:

1. **Given** a type is selected, **When** the user edits, **Then** that type's card is visible without scrolling on a laptop screen.
2. **Given** the comparison view, **When** opened, **Then** all four cards appear, each in no more than about 60 words plus a diagram.
3. **Given** Box is selected with no image, **When** the user looks at Run, **Then** it is disabled and the reason is shown.

---

### User Story 3 - Design and run a wording-variants matrix (Priority: P1)

The user creates an **experiment**: a name, one question type (Noul by default; for Choice the options are shared by all columns, for Score the levels are), a list of **inputs** as rows (pasted one per line or imported from a file, each with an optional expected answer and tags), and two or more **wording variants** of the proposition as columns (e.g. "Is it an apple?", "Does this describe an apple?", "Apple (the fruit)?"). A "duplicate and edit" action makes new variants quick to create. Before running, the user sees the number of requests and an estimated cost and confirms. The grid then fills in as results arrive. Each cell shows its value as a number and a heat color. Each row shows its **spread** (max − min across variants), which measures how sensitive Jev is to wording for that input. Adding a variant or input later runs only the missing cells.

**Why this priority**: This is the user's primary analysis goal: see how the proposal's wording changes Jev's certainty across inputs.

**Independent Test**: Create an experiment with 10 fruit descriptions × 3 Noul variants, run it, and see a 10 × 3 heatmap with per-row spread, all recorded in History.

**Acceptance Scenarios**:

1. **Given** 10 inputs and 3 Noul variants, **When** the user confirms the run, **Then** a 10 × 3 grid shows P(yes) per cell with heat color, and each row shows its spread.
2. **Given** a completed grid, **When** the user adds a 4th variant, **Then** only the 10 new cells are requested and the estimate covers only them.
3. **Given** a Choice experiment with options "apple / pear / tomato", **When** results show, **Then** each cell shows the probability of the chosen **focus option** (selectable, default the first option) and marks cells where a different option won.
4. **Given** a Score experiment, **When** results show, **Then** each cell shows the position on the levels, normalized so the lowest level is 0 and the highest is 1, and the level name nearest to it.
5. **Given** a column's wording is edited after it has results, **When** saved, **Then** it becomes a new column (old answers stay attached to the old wording, which can be hidden).
6. **Given** one row's request fails, **When** the run ends, **Then** the other cells keep their results and the failed row shows its error and a Retry action.

---

### User Story 4 - Reshape the analysis live without re-running (Priority: P1)

On the matrix, the user adapts the analysis with no new requests and no new cost:

- **Threshold**: two handles split each cell into *yes* / *review* / *no* (below the low handle = no, above the high handle = yes). Cell styling and per-column counts update as the handles move. Any column can override the global thresholds.
- **Weights / composite**: each variant gets a weight (0 = excluded). A **composite** column shows the weighted mean for each row. It can be thresholded, sorted and (with labels) scored like any variant, which answers "is an ensemble of wordings better than the best single one?"
- **Pivot / sort / filter**: swap rows and columns; sort by any column, the composite, spread, or label; filter rows to labeled/unlabeled, misclassified, in the review band, spread above X, by tag, or by text; group or compare by model version.
- **Cost overlay**: toggle cells to show tokens and cost instead of values; the summary shows total cost, cost per row, and (with labels) cost per correctly decided row.

Every experiment remembers its current view. The user can also save named views (e.g. "strict 0.9", "wording-only, no v3") and switch between them.

**Why this priority**: The user explicitly defined "deep UX adaptation" as this.

**Independent Test**: On a completed 10 × 3 grid, move the threshold, set weights, sort by spread, and toggle the cost overlay. Confirm there are no new History entries and no added cost. Restart and confirm the view is restored.

**Acceptance Scenarios**:

1. **Given** a completed grid, **When** the high threshold moves from 0.8 to 0.9, **Then** cells between 0.8 and 0.9 change from *yes* to *review* within a fraction of a second, column counts update, and no request is sent.
2. **Given** weights v1=1, v2=1, v3=0, **When** applied, **Then** the composite for each row equals the mean of v1 and v2 for that row.
3. **Given** the user sorts by spread descending, **When** applied, **Then** the rows most sensitive to wording come first.
4. **Given** pivot is on, **When** applied, **Then** variants become rows and inputs become columns with the same cell values.
5. **Given** the cost overlay is on, **When** viewed, **Then** each row shows its request cost, and column shares are marked as estimates.
6. **Given** a saved view "strict 0.9", **When** the user switches to it after a restart, **Then** thresholds, weights, sort, filters, pivot and overlay are restored exactly.

---

### User Story 5 - Labels and accuracy (Priority: P2)

The user optionally sets the expected answer per input (yes/no for Noul, an option for Choice, a level for Score), at import or directly in the grid. When at least one row is labeled, each column (and the composite) shows, for labeled rows only: accuracy on decided rows, review rate, the best single threshold (the one that maximizes accuracy), and a calibration error (Brier score for Noul and Choice, mean absolute level error for Score). A confusion summary (correct yes, correct no, false yes, false no, in review) is shown per column. Misclassified cells are outlined and can be filtered to. All metrics update live with the threshold and weights.

**Why this priority**: The user will sometimes label. Labels turn exploration into a decision about which wording to use.

**Independent Test**: Label 6 of 10 rows. Check that metrics appear computed over those 6, and that changing a label updates them instantly without a request.

**Acceptance Scenarios**:

1. **Given** 6 of 10 rows labeled, **When** metrics show, **Then** they state "n = 6" and ignore the unlabeled rows.
2. **Given** labels exist, **When** the user clicks "use best threshold" on a column, **Then** the thresholds are set to that column's best value and accuracy reflects it.
3. **Given** no rows are labeled, **When** the grid shows, **Then** label metrics are hidden and spread, mean and agreement are shown instead.
4. **Given** a misclassified cell, **When** clicked, **Then** the underlying run opens with its full answer.

---

### User Story 6 - Build a matrix from saved History (Priority: P2)

From History, the user filters or selects saved runs and chooses "Open as matrix". The workbench builds an experiment: rows are the distinct inputs, and columns are the distinct questions of the chosen type (same type and criteria, differing wording). Cells are filled from the existing answers at no cost. Missing cells are shown empty and can be run on demand.

**Why this priority**: Ad-hoc tests become analyzable later, and nothing paid for is wasted.

**Independent Test**: Make 6 single runs (2 inputs × 3 wordings), select them in History, choose "Open as matrix", and see a filled 2 × 3 grid with total added cost $0.

**Acceptance Scenarios**:

1. **Given** selected runs covering 2 inputs × 3 Noul wordings, **When** opened as a matrix, **Then** a 2 × 3 grid is filled from them and no request is sent.
2. **Given** some combinations are missing, **When** the grid shows, **Then** those cells are empty with "Run missing (N)" and an estimate.
3. **Given** selected runs mix types, **When** opening, **Then** the user picks which type forms the matrix and the others are left out with a count shown.

---

### User Story 7 - See costs per task and in total (Priority: P2)

Every run shows input tokens and cost. Totals are shown for the session, for each experiment, and for all time. The price used is visible and editable.

**Why this priority**: The user wants to know what each experiment costs.

**Independent Test**: Run 3 single tests and a 5 × 2 grid. Check that the session total equals the sum of the recorded runs and that the experiment total equals the sum of its rows.

**Acceptance Scenarios**:

1. **Given** a completed run, **When** shown, **Then** tokens and cost (USD, enough decimals to be non-zero) appear.
2. **Given** several runs, **When** the user views totals, **Then** session, experiment and all-time totals match the sum of the recorded runs.
3. **Given** a run with no reported token count, **When** shown, **Then** its cost reads "unknown" and totals state how many runs are excluded.

---

### User Story 8 - Collect, review and export task data (Priority: P2)

Every run is saved automatically. History can be filtered by type, model, experiment, tag, date or text. A run can be reopened in the editor, annotated, or deleted. Runs and matrices (as displayed, with labels and metrics) can be exported to a spreadsheet-friendly file, and runs also to a full-fidelity file.

**Why this priority**: The user explicitly wants to collect data on these tasks.

**Independent Test**: Make runs, restart, check History, and export both the runs and one matrix.

**Acceptance Scenarios**:

1. **Given** earlier runs, **When** the tool restarts, **Then** all of them are in History.
2. **Given** History, **When** filtered to one experiment, **Then** only its runs are listed.
3. **Given** a matrix view, **When** exported, **Then** the file has one row per input with each variant's value, the composite, the label and spread, followed by a metrics block.

---

### User Story 9 - Box on an image (Priority: P3)

The user attaches a PNG or JPEG image, writes what to find, and runs a Box. The image shows with the box drawn on it, plus the confidence. One click adds the recommended companion Noul ("Is the target in the image?").

**Why this priority**: It completes coverage of all four types, but the main use is text. Box is single-run only; it is not part of matrices in v1.

**Independent Test**: Attach an apple photo, run a Box, and see a rectangle drawn on the image.

**Acceptance Scenarios**:

1. **Given** an image and a Box question, **When** run, **Then** the box is drawn over the image and confidence appears.
2. **Given** a Box question, **When** "Add presence check" is clicked, **Then** a Noul is added to the same run.

---

### Edge Cases

- **Missing or invalid key**: show setup instructions; record no successful run.
- **Rate limit or overload**: automatic retries with backoff and a "retrying…" state, then a clear failure. A failed run is recorded with no cost.
- **Input too long for the model**: show the limit and how far over the input is. No cost.
- **Choice with < 2 options, Score with < 2 levels, or an experiment with < 1 input or < 1 variant**: Run is blocked and the field is highlighted. One variant is allowed, but spread then shows "—".
- **Duplicate inputs or duplicate variant wordings in an experiment**: warn and merge on confirm.
- **Labels that don't match the experiment type** (e.g. "maybe" on a Noul, or an unknown option on a Choice): rejected at import with a row-level list of problems.
- **Composite with all weights 0**: the composite column shows "—" and is excluded from sorting.
- **Cells answered by different model versions** (the alias moved between runs): mark the mixed cells; the model filter separates them.
- **History-built matrix with two answers for the same cell**: the latest successful answer per model is used, and the older ones stay in History.
- **Score with an unlabeled position between levels**: the nearest level is named and the exact position shown.
- **Large grid (500 rows × 10 variants)**: the controls stay responsive and the grid pages or virtualizes rows.
- **Network offline**: matrix analysis, guide and History keep working; only Run is unavailable.
- **Corrupted data store**: start with an empty store, keep the damaged file aside, and tell the user.

## Requirements *(mandatory)*

### Functional Requirements

**Launch & setup**

- **FR-001**: Users MUST be able to start the workbench with a single terminal command that opens it in the default browser and prints the local address.
- **FR-002**: The workbench MUST be reachable only from the user's own machine.
- **FR-003**: The system MUST read the TypeSafe API key from the environment or a local file, and MUST never show the full key in the interface, logs or exports.
- **FR-004**: The system MUST show a clear setup message when no valid key is present.

**Single runs**

- **FR-005**: Users MUST be able to compose a run from one input (text, named fields, optional PNG/JPEG image) and one or more questions of type Noul, Choice, Score or Box.
- **FR-006**: The system MUST validate questions before sending and explain problems next to the field.
- **FR-007**: Users MUST be able to pick the model version (default: the latest stable alias). Box MUST be unavailable on versions that lack it.
- **FR-008**: All questions of one run MUST be sent as a single request.
- **FR-009**: Results MUST show, per type: Noul P(yes) with a bar; Choice option, ranked probabilities and confidence; Score position, per-level probabilities and confidence; Box overlay and confidence. Each result MUST show the answering model version.

**Experiments (matrix)**

- **FR-010**: Users MUST be able to create, rename, duplicate and delete experiments. An experiment has one question type, shared criteria (Choice options or Score levels), rows (input, optional label, tags) and columns (wording variants).
- **FR-011**: Users MUST be able to add rows by pasting lines or importing a file with input, label and tags fields, and add columns by typing or duplicating a variant.
- **FR-012**: Before any grid run, the system MUST show the number of requests and the estimated cost, and require confirmation.
- **FR-013**: A grid run MUST send one request per row, containing all of that row's missing variants. Only missing or failed cells are requested.
- **FR-014**: Editing a variant's wording after it has answers MUST create a new column and keep the old answers attached to the old wording.
- **FR-015**: The cell value MUST be: Noul → P(yes); Choice → probability of the focus option (selectable, with a marker when another option won); Score → normalized position 0–1 with the nearest level named.
- **FR-016**: Each row MUST show spread (max − min of the visible variants). Each column MUST show mean, yes/review/no counts and, without labels, agreement (the share of rows where all visible variants fall in the same band).
- **FR-017**: Users MUST be able to run missing cells, retry failed rows, and re-run the experiment on another model version, keeping both versions' answers.

**Live analysis controls (no requests, no cost)**

- **FR-018**: Users MUST be able to set a global two-handle threshold (low/high) and override it per column. Cell bands and counts MUST update immediately.
- **FR-019**: Users MUST be able to set a weight per variant. The system MUST show a composite column (weighted mean) that behaves like any column for thresholds, sorting and metrics.
- **FR-020**: Users MUST be able to pivot the matrix, sort by any column/composite/spread/label, filter rows (labeled, unlabeled, misclassified, in review band, spread above a value, tag, text), hide or show columns, and compare or filter by model version.
- **FR-021**: Users MUST be able to switch cells to a cost overlay (tokens and cost per row; per-column shares marked as estimates) and see total cost, cost per row, and cost per correctly decided row when labels exist.
- **FR-022**: Each experiment MUST persist its current view state. Users MUST be able to save, rename, delete and switch between named views.

**Labels & metrics**

- **FR-023**: Users MUST be able to set, change or clear an expected answer per row: yes/no (Noul), an option (Choice), or a level (Score).
- **FR-024**: When ≥ 1 row is labeled, each column and the composite MUST show, over labeled rows only and with the count n: accuracy on decided rows, review rate, confusion summary, best single threshold (with a one-click "use it"), and calibration error (Brier for Noul/Choice, mean absolute level error for Score).
- **FR-025**: Misclassified cells MUST be visually marked, filterable, and open their underlying run when clicked.

**History → matrix**

- **FR-026**: Users MUST be able to turn a filtered or selected set of saved runs into an experiment. Rows are the distinct inputs, columns the distinct question wordings of one chosen type with identical criteria. Cells are filled from existing answers with no request.

**Costs**

- **FR-027**: Each run MUST show input tokens and cost from a user-editable per-token price (default $0.042 per million input tokens; output free). Unknown token counts MUST show as "unknown", never 0.
- **FR-028**: The system MUST show session, per-experiment and all-time totals.

**Data collection**

- **FR-029**: The system MUST record every run automatically on the user's machine: timestamp, input, questions, all answer values, model version, tokens, cost, duration, status, error, and the experiment and row it belongs to.
- **FR-030**: Users MUST be able to filter History, reopen a run in the editor, annotate, tag and delete runs.
- **FR-031**: Users MUST be able to export runs (spreadsheet-friendly and full-fidelity) and a matrix as displayed (spreadsheet-friendly, including labels, composite, spread and metrics).
- **FR-032**: All runs, experiments, labels and views MUST survive restarts.

**Decision support**

- **FR-033**: The system MUST provide a short card per type (asks, returns, use when, pitfall, diagram). The current type's card MUST be visible while editing, and a comparison view MUST show all four. The guide MUST work offline.

**Basic display preferences**

- **FR-034**: Users MUST be able to choose theme (light/dark/system), text size, and probability format (percent or fraction, with decimals). These persist across restarts. Visual styling beyond this is out of scope.
- **FR-035**: The interface MUST be keyboard-operable and meet basic contrast in all themes. Bands and misclassification MUST never be shown by color alone.

### Key Entities

- **Run**: one request to Jev. Has a timestamp, input, questions, model requested and used, status, duration, tokens, cost, error, note and tags. Optionally belongs to an experiment row.
- **Question**: ID, type, wording (instructions), criteria.
- **Answer**: type-specific result for one question in one run.
- **Experiment**: a name, one question type, shared criteria, rows, columns, view state, and named views.
- **Row (input)**: input text or fields, optional label, tags, and its position in the experiment.
- **Column (variant)**: one wording of the proposition, a weight, an optional threshold override, and a hidden flag. Its wording never changes once it has answers.
- **Cell** (derived): the latest successful answer for a (row, column, model version).
- **View**: a named snapshot of thresholds, weights, sort, filters, pivot, hidden columns, overlay, focus option and model filter.
- **Preferences**: theme, text size, number format, default model, price per token, parallelism.
- **Type guide card**: fixed descriptive content for each of the four types.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A first-time user with an API key gets their first Noul result within 2 minutes of launching from the terminal.
- **SC-002**: A single run's result appears within 3 seconds on a normal connection.
- **SC-003**: A 50-input × 5-variant experiment completes within 1 minute.
- **SC-004**: Threshold, weight, sort, filter, pivot and overlay changes update a 500 × 10 matrix in under 0.2 seconds, with zero requests and zero added cost.
- **SC-005**: With a labeled experiment, a user can identify the most accurate wording (or the composite) and its best threshold in under 1 minute.
- **SC-006**: Turning saved History into a matrix takes ≤ 3 actions and adds $0 cost when all cells already exist.
- **SC-007**: Displayed totals equal the sum of per-run costs, at the precision shown.
- **SC-008**: 100% of runs, experiments, labels and saved views are present after a restart.
- **SC-009**: A user new to Jev picks the right type for 4 sample tasks (one per type) after reading only the guide cards, in under 1 minute.

## Assumptions

- Single user on their own machine; no accounts or sharing.
- The user has a TypeSafe API key and internet access when running tests.
- "Very simple visual style" means neutral, low-chrome UI. Adaptation lives in the analysis controls (FR-018–FR-022), not styling.
- The variant matrix compares wordings of **one** question type with shared criteria, so cells are comparable. Matrices of *types × same intent* and *expected × predicted* confusion views beyond the per-column summary are later views, out of scope for v1.
- Per-cell cost is not reported by the API (usage is per request, and one request covers all of a row's variants). Per-column cost is therefore an estimate proportional to question length and is labeled as such.
- Box is single-run only in v1.
- Costs are computed locally as reported input tokens × the configured price.
- All data stays on the user's machine. Only test requests go to TypeSafe.
- Long-context mode is out of scope.
