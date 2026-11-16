# Feature Specification: Experiment Steps (linear chain with gates)

**Feature Branch**: `003-experiment-steps`

**Created**: 2026-11-16

**Status**: Draft

**Input**: User description: "Add steps to the Experiments window, for example noul -> score -> noul, noul -> noul, noul -> score -> choice. A visible button at the bottom of the open experiment adds a step. An input moves on to the next step or stops, based on thresholds. Optional: nodes instead of steps?"

## Context

Today an experiment is one matrix: inputs are rows, and wordings (variants) of **one** question are columns. Every answer becomes a value from 0 to 1:
- Noul gives P(yes).
- Choice gives the probability of the focus option.
- Score gives its position on the level scale.

The visible variants combine into a weighted **composite** per row. Two thresholds (low/high) put each value in a band: **yes** (≥ high), **review** (between) or **no** (< low). Answers are stored by input and question. A repeated request is never paid twice.

This feature turns an experiment into an ordered **chain of steps**. Each step is a full matrix with its own question. A row reaches a step only if it passed the **gate** of the step before. This lets the user build funnels such as "is it on topic? → how good is it? → which category?", and pay for later questions only on the inputs that survive earlier ones.

## Clarifications

### Session 2026-11-16

- Q: Steps as a linear chain or as a graph of nodes? → A: Linear chain. Routing one step to different next steps (e.g. per Choice option) is out of scope; it is the reason to move to nodes later.
- Q: What is one step? → A: A full matrix like today's experiment: its own type, criteria, variants, weights, thresholds, labels and Run missing.
- Q: What happens to inputs in the review band at a gate? → A: A per-step setting, "review passes" on or off. Off by default, so review stops.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Chain two steps and gate the inputs (Priority: P1)

The user has an experiment with a Noul question ("Is this answer on topic?") run over 100 inputs. At the bottom of the experiment page they click **+ Add step**. A second step appears below the first, with its own setup: type, criteria and variants. Step 1 now shows a **gate**: which rows go on to step 2. Step 2's matrix lists only the rows that passed. **Run missing** in step 2 asks only about those rows. Rows that stopped are marked as stopped in step 1. When the user moves step 1's thresholds, step 2's rows update at once, with no new requests.

**Why this priority**: This is the core of the feature: a second question only for the inputs that pass the first. It already saves cost and delivers the noul → noul and noul → score flows.

**Independent Test**: Make an experiment with 10 inputs and one Noul variant, and run it. Add a step (Noul, one variant). Check that step 2 lists exactly the rows whose step 1 composite is ≥ the high threshold. Check that Run missing in step 2 sends exactly that many requests. Lower the high threshold and check that more rows appear in step 2, with no requests sent.

**Acceptance Scenarios**:

1. **Given** an open experiment, **When** the user scrolls to the bottom of the page, **Then** a **+ Add step** button is visible below the last step.
2. **Given** the user clicks **+ Add step**, **When** the new step appears, **Then** it is numbered (Step 2), has an empty setup (type, criteria, variants), and its matrix says it is waiting for rows that pass step 1.
3. **Given** step 1 is a Noul step with answers, **When** a second step exists, **Then** step 1 shows its gate: rows in the yes band pass, rows in the no band stop, and rows in the review band stop unless "review passes" is turned on.
4. **Given** step 1 has a gate, **When** the user views step 1's matrix, **Then** every row shows its gate outcome (passes, stops, or waiting) as text, not only as color.
5. **Given** 40 of 100 rows pass step 1, **When** the user opens step 2, **Then** its matrix lists exactly those 40 rows, and Run missing offers requests only for them.
6. **Given** step 2 has answers for 40 rows, **When** the user raises step 1's high threshold so that only 25 pass, **Then** step 2 shows 25 rows. If the user lowers it back, the 40 rows and their answers return with no new requests.
7. **Given** the user turns on "review passes" for step 1, **When** the matrices update, **Then** rows in step 1's review band also appear in step 2.
8. **Given** any step after the first, **When** the user removes it and confirms, **Then** the step and its setup disappear. The next step (if any) takes its rows from the step before. Its answers stay in History. Step 1 cannot be removed, because it holds the inputs.

---

### User Story 2 - Gate on Score levels and Choice options (Priority: P2)

Not every step is a yes/no question. For a **Score** step, the user picks a minimum level ("level 2 or better passes"). For a **Choice** step, the user picks which options pass ("billing or refund pass"). The gate then works out how likely each row is to pass: the sum of the probabilities of the passing levels or options, combined across variants like the composite. It applies the step's thresholds and review setting to that likelihood, exactly as for Noul.

**Why this priority**: It makes flows like noul → score → choice possible. It builds on the gate from Story 1.

**Independent Test**: Make a chain noul → score → choice. Set the Score step's minimum level to 2. Check that a row whose levels 2+ add up to ≥ the high threshold passes, and one below the low threshold stops. Set the Choice step's passing options to two of three. Check that its gate outcome follows the summed probability of those two options.

**Acceptance Scenarios**:

1. **Given** a Score step with levels 0–3, **When** the user sets the minimum passing level to 2, **Then** each row's pass likelihood is the probability of level 2 or 3, combined across the step's visible variants with their weights.
2. **Given** a Choice step with options A, B and C, **When** the user marks A and B as passing, **Then** each row's pass likelihood is P(A) + P(B), combined across visible variants.
3. **Given** a pass likelihood, **When** it is ≥ the step's high threshold, **Then** the row passes. Below the low threshold it stops. In between it is review, and it passes only if "review passes" is on.
4. **Given** a Choice step with no passing option chosen, **When** the gate is shown, **Then** it warns that no row can pass.
5. **Given** a Score step whose minimum level is the lowest level, **When** the gate is shown, **Then** it warns that every judged row passes.
6. **Given** any step's gate, **When** the user views a row's outcome, **Then** the pass likelihood is shown next to it, so the user can see why a row passed or stopped.

---

### User Story 3 - See the funnel (Priority: P2)

Next to the **+ Add step** button, the user sees the whole chain at a glance:
- how many inputs entered each step;
- how many passed, stopped (including review), or are still waiting for answers;
- how many passed the last step.

They can export one row per input with its outcome at every step.

**Why this priority**: The point of a chain is the funnel: where inputs drop out, and which questions do the filtering. The numbers exist only once steps exist (Stories 1–2).

**Independent Test**: In a 3-step chain over 50 inputs, check that the funnel's numbers match the rows shown in each step's matrix. Check that the exported file has 50 lines, each with the right outcome per step.

**Acceptance Scenarios**:

1. **Given** a chain of 3 steps, **When** the user looks at the funnel, **Then** each step shows the count of rows that entered, passed, stopped, and are waiting (not fully answered). At every step, entered = passed + stopped + waiting.
2. **Given** the last step has a gate, **When** the funnel is shown, **Then** it shows how many inputs passed the whole chain.
3. **Given** the user changes any threshold, weight, minimum level, passing option or review setting, **When** the change applies, **Then** the funnel updates at once.
4. **Given** the user exports the chain, **When** the file opens in a spreadsheet, **Then** it has one line per input with its label summary, and for each step: the outcome (passed, stopped, waiting, did not reach) and the pass likelihood.

---

### User Story 4 - Manage a chain (Priority: P3)

The user names steps ("on topic", "quality", "category"), collapses steps they are not working on, and duplicates an experiment together with all its steps. The experiment list shows each experiment's chain, e.g. "Noul → Score → Choice".

**Why this priority**: These comforts matter once chains are in daily use. The chain works without them.

**Independent Test**: Rename step 2, collapse step 1, reload the page, and check both are kept. Duplicate the experiment and check the copy has the same steps, setups and gates. Check the list shows the chain.

**Acceptance Scenarios**:

1. **Given** a step, **When** the user renames it, **Then** the new name shows in its header, the funnel and the export.
2. **Given** a step is collapsed, **When** the page reloads, **Then** it is still collapsed, and its header still shows its type and counts.
3. **Given** an experiment with 3 steps, **When** the user duplicates it, **Then** the copy has the same 3 steps, with the same setups and gate settings.
4. **Given** an experiment with steps, **When** the user opens the experiment list, **Then** the Type column shows the chain of step types.

---

### User Story 5 - Run the whole chain (Priority: P3)

Instead of clicking Run missing step by step, the user clicks **Run chain**. The app runs step 1's missing cells, applies the gate, runs step 2 for the rows that passed, and so on to the last step. Before starting, it confirms the cost. The estimate for later steps is an upper bound, since it is not yet known how many rows will pass.

**Why this priority**: It saves clicks on long chains. Step-by-step running (Story 1) already covers the need.

**Independent Test**: In a fresh 3-step chain over 20 inputs, click Run chain and confirm. Check that steps run in order, that each later step asks only about the rows that passed, and that the final funnel matches a step-by-step run.

**Acceptance Scenarios**:

1. **Given** a chain with missing cells, **When** the user clicks Run chain, **Then** a confirmation shows step 1's exact request count and cost, and an upper bound for later steps.
2. **Given** the run is in progress, **When** a step finishes, **Then** the next step starts with only the rows that passed, and progress shows the current step.
3. **Given** a step's requests fail for some rows, **When** the run continues, **Then** those rows count as waiting, are not sent to later steps, and can be retried.

---

### Edge Cases

- **Experiment without added steps**: it looks and behaves as today. The only addition is the **+ Add step** button at the bottom. No gate is shown and nothing changes in its matrix, export or costs.
- **Partly answered row**: a row is judged at a step only when every visible variant there has an answer for the model in view. Until then it is "waiting" and does not move on.
- **Step with no visible variants**: every arriving row waits there. Later steps receive nothing, and the step says why.
- **Hidden variants**: they do not count toward the composite or the gate, as today.
- **Rows that stop passing**: their later-step answers are kept but hidden. They come back with no new cost if the rows pass again.
- **Removing an input** (in step 1): it disappears from every step.
- **Same question in two steps** (same type, criteria and wording): it is treated as the same question, so the earlier answer is reused, not paid twice.
- **Labels**: each step has its own labels, since types differ. A label set on a row in step 2 stays if the row later stops passing and comes back.
- **View filters and sorting** (text, tag, labeled, misclassified, review only, spread): they change only what a step's matrix shows. They never change which rows pass to the next step.
- **Comparing model versions** in a step: the gate uses the most recent model's answers, and the step says so.
- **Type and criteria lock**: each step's type and criteria are fixed once that step has answers, as today. Gate settings, thresholds and weights can change at any time.
- **Changing step 1's reference or inputs**: this affects every step. The inputs Jev sees are the same at every step.

## Requirements *(mandatory)*

### Functional Requirements

**Chain and steps**

- **FR-001**: An experiment MUST hold an ordered chain of one or more steps. Today's experiments are a chain of one step and MUST work unchanged.
- **FR-002**: The open experiment page MUST show a **+ Add step** button below the last step. Clicking it appends a new step at the end of the chain.
- **FR-003**: Each step MUST have its own question type (Noul, Choice, Score), shared criteria, variants, variant weights and own thresholds, low/high thresholds, labels, and Run missing, with the same behavior as today's experiment.
- **FR-004**: Inputs, tags and the shared reference MUST belong to the experiment and be managed only in step 1. Every step sends Jev the same input.
- **FR-005**: The question library ("Load questions") MUST be available in every step's setup. Loading inputs MUST stay in step 1.
- **FR-006**: The user MUST be able to remove any step after the first, after confirming. Steps after it then take their rows from the step before it. Answers stay in History.
- **FR-007**: Each step's type and criteria MUST be locked once that step has answers. Its gate settings MUST stay editable.

**Gates**

- **FR-008**: Every step except a lone first step MUST show a gate. The gate of the last step defines "passed the chain".
- **FR-009**: The gate MUST compute each judged row's **pass likelihood**, combining the step's visible variants with their weights:
  - Noul: P(yes);
  - Score: the sum of the probabilities of the levels at or above the chosen minimum level;
  - Choice: the sum of the probabilities of the chosen passing options.
- **FR-010**: A row MUST pass when its pass likelihood is ≥ the step's high threshold, and stop when it is < the low threshold. Between the two it is review: it passes if the step's "review passes" setting is on, and stops otherwise. The setting is off by default.
- **FR-011**: Score gates MUST default to the middle level as the minimum, rounded up. Choice gates MUST default to the focus option as the only passing option.
- **FR-012**: A row MUST be "waiting" at a step until every visible variant there has an answer for the model in view. Waiting rows do not move on.
- **FR-013**: Rows reaching step N+1 MUST be exactly the rows that pass step N. View filters and sorting MUST NOT affect this.
- **FR-014**: Changing a threshold, weight, hidden variant, minimum level, passing option or review setting MUST update every later step and the funnel at once, with no request to Jev.
- **FR-015**: Each row in a step's matrix MUST show its gate outcome and pass likelihood as text. The step MUST warn when its gate lets no row pass, or every row pass.

**Running and cost**

- **FR-016**: Run missing in a step MUST request only the rows that reach that step and lack answers there. It MUST NOT request rows that stopped earlier or are waiting earlier.
- **FR-017**: Answers MUST be reused across steps and across gate changes whenever the input and question are the same. The same request MUST never be paid twice.
- **FR-018**: **Run chain** MUST run steps in order, with only the passing rows going on. Before starting, it MUST confirm the exact cost of step 1 and an upper bound for later steps.

**Funnel and export**

- **FR-019**: The page MUST show a funnel, with for each step: entered, passed, stopped and waiting counts, and the count that passed the whole chain.
- **FR-020**: The user MUST be able to export one line per input, with its outcome (passed, stopped, waiting, did not reach) and pass likelihood at every step.
- **FR-021**: Each step's existing matrix export MUST contain only the rows that reach that step.

**Management**

- **FR-022**: The user MUST be able to rename steps and collapse or expand them. Both MUST be kept across reloads.
- **FR-023**: Duplicating an experiment MUST copy all its steps, setups and gate settings.
- **FR-024**: The experiment list MUST show each experiment's chain of step types.

### Key Entities

- **Experiment**: has a name, the inputs (rows with tags), a shared reference, and an ordered chain of steps.
- **Step**: has a position in the chain, an optional name, a question type, criteria, variants (wordings with weight, own threshold and hidden flag), view settings (thresholds, sort, filters), labels per row, a gate, and a collapsed flag.
- **Gate**: belongs to a step. It holds the minimum level (Score), the passing options (Choice) and the "review passes" setting. With the step's thresholds and weights, it decides each row's outcome.
- **Row outcome**: computed, never stored. For each row and step, it is one of: passes, stops, waiting or did not reach, plus the pass likelihood.
- **Answer (cell)**: unchanged. One answer per input, question and model. Shared by every step that asks the same question about the same input.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can turn a one-step experiment into a 3-step chain (noul → score → choice) and run it in under 5 minutes, not counting time spent waiting for answers.
- **SC-002**: In every step, Run missing sends 0 requests for rows that stopped or are waiting at an earlier step.
- **SC-003**: Changing any gate setting on a chain of 5 steps over 1,000 inputs updates every step and the funnel in under 1 second, with 0 requests to Jev.
- **SC-004**: Moving a threshold away and back restores every earlier later-step answer with 0 extra cost.
- **SC-005**: Every existing experiment opens and behaves exactly as before: same matrix, numbers, export and costs.
- **SC-006**: At every step, the funnel counts add up (entered = passed + stopped + waiting) and match the rows shown in the step's matrix.

## Assumptions

- **Linear only**: each step has exactly one next step. Routing per option or level to different steps is out of scope; it is the upgrade path to a node graph.
- **Same input at every step**: later steps do not see earlier steps' answers. Feeding an answer into the next step's input is out of scope.
- **Step order is fixed**: reordering steps is out of scope. Removing and re-adding a step costs nothing for questions already answered, because answers are reused.
- **Gate thresholds are the step's existing low/high thresholds**: there is no separate threshold pair for the gate. For Noul, and for Choice with only the focus option passing, the pass likelihood equals the existing composite.
- **Row labels and the existing label metrics** (accuracy, best threshold, Brier, MAE) work per step, on the rows that reach that step.
- **Run model**: the page's "Run with" model applies to whichever step runs.
- Experiments made from History runs start as a chain of one step.
- No limit on the number of steps is enforced. The responsiveness target is 5 steps × 1,000 inputs.
