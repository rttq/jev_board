# Feature Specification: JSON Library (inputs and questions)

**Feature Branch**: `002-json-upload`

**Created**: 2026-11-14

**Status**: Draft (clarified)

**Input**: User description: "Hi. I want to add a new feature - uploading pre-prepared JSON into question window or experiment: create a folder where JSON files will be stored; add a button to the corresponded parts of the interface; everytime I click this button, opens a new window with JSONs folder; everytime we open JSON, we somehow need to see clearly what objects are stored in this particular file (just to understand what to input into the question); we also need to make sure that app reads JSON structure properly"

## Context

The workbench already has two places that take inputs and questions:

- **Run view** (the single-run editor). Its *Input* panel has a "Fields (JSON)" mode, where the user types or pastes a JSON object by hand. Questions refer to its fields by name, e.g. `ticket.subject`. Its *Questions* panel holds one or more questions (ID, type, wording, criteria), all entered by hand.
- **Experiment Setup**. Inputs are typed one per line or imported from `.txt` / `.csv`. Variants (wordings of the experiment's one question) are typed one at a time. Experiment rows can already hold JSON-object inputs, but the interface offers no way to add them.

This feature adds a **JSON library**: one folder of prepared files in two kinds, **input files** (data to judge) and **question files** (ready-made questions). Both the Run view and experiments can open, preview and load them, with validation.

## Clarifications

### Session 2026-11-14

- Q: What can a JSON file contain? → A: Input data or questions, in separate files.
- Q: How should a file with a list of records be handled? → A: In an experiment, each object becomes a row. In the Run view, the user picks one object from the list.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Load a prepared input file into the Run view (Priority: P1)

The user keeps realistic sample inputs (support tickets, product records, chat transcripts) as JSON files in the library. In the Run view's Input panel they click **Load JSON**. A picker window opens and lists the input files. They choose one, see a preview, and confirm. The Input panel switches to "Fields (JSON)" and holds the file's object, ready to run. If the file holds a list of records, they pick which one to load.

**Why this priority**: This is the smallest slice that delivers the core value: no more hand-pasting JSON, and the input always comes from the file exactly as written.

**Independent Test**: Put one object file and one list file in the inputs folder. Load each in the Run view (choosing record 3 from the list file) and check the Input panel shows exactly that object and a run sends it unchanged.

**Acceptance Scenarios**:

1. **Given** the inputs folder contains `ticket_01.json` with a JSON object, **When** the user clicks Load JSON in the Input panel, **Then** a picker window opens and lists `ticket_01.json` with its size and last-modified date.
2. **Given** the picker is open, **When** the user selects `ticket_01.json` and confirms, **Then** the Input panel switches to Fields (JSON), shows the object formatted for reading, and the picker closes.
3. **Given** a file holding a list of 40 objects, **When** the user selects it, **Then** the preview shows a record selector (number plus a short summary of each record). Confirming loads only the chosen record.
4. **Given** the Input panel already holds non-empty text or fields, **When** the user confirms loading, **Then** the app asks before replacing, and Cancel leaves the input untouched.
5. **Given** a file was loaded, **When** the user runs, **Then** the state sent is identical to the loaded object: same keys, nesting, value types and characters.
6. **Given** a new file was added to the folder while the app was running, **When** the user clicks Load JSON again, **Then** the new file appears without a restart.

---

### User Story 2 - See what an input file contains before using it (Priority: P1)

When the user selects an input file, a preview shows its structure as a tree: every field, its full path (e.g. `ticket.customer.tier`), its type (text, number, true/false, empty, list, object) and a short sample value. The user copies a field path with one click, so they know exactly which names to use in the question wording.

**Why this priority**: The user named this as the reason for the feature: to understand what to write into the question.

**Independent Test**: Select a nested file and check that every field appears with the correct path, type and sample, and that copying a path gives the exact text a question can refer to.

**Acceptance Scenarios**:

1. **Given** a file `{"ticket": {"subject": "Refund", "priority": 2, "tags": ["billing"]}}`, **When** the user selects it, **Then** the preview lists `ticket` (object), `ticket.subject` (text, "Refund"), `ticket.priority` (number, 2) and `ticket.tags` (list of 1 text).
2. **Given** a list file whose records do not all share the same fields, **When** it is previewed, **Then** the tree shows the fields found across all records and marks each field present in only some records with its count (e.g. "in 31 of 40").
3. **Given** the preview is shown, **When** the user activates a field's copy control, **Then** its path is copied and the app confirms the copy.
4. **Given** a long text value, **When** it is previewed, **Then** the sample is shortened with an ellipsis and the full value is available on demand.
5. **Given** the preview is shown, **When** the user switches to the raw view, **Then** the file's content is shown formatted and read-only.
6. **Given** a file with more than 200 fields, **When** it is previewed, **Then** nested objects start collapsed and can be expanded, and the preview stays responsive.

---

### User Story 3 - Add input files to an experiment (Priority: P2)

In an experiment's Setup, next to "Import .txt / .csv", the user clicks **Load JSON**. The same picker opens on the input files. Confirming appends the file's records as rows: one row for an object file, one row per object for a list file.

**Why this priority**: Experiments compare wordings across many inputs, so they need batches of structured inputs. It builds on the picker and preview from Stories 1–2.

**Independent Test**: Open an experiment, load a list file of 25 objects, and check that 25 rows are added and that running the matrix sends each row's object unchanged.

**Acceptance Scenarios**:

1. **Given** an experiment's Setup is open, **When** the user loads an object file, **Then** one row is appended after the existing rows.
2. **Given** a list file of 25 objects, **When** the user confirms it, **Then** 25 rows are appended in file order, and Setup reports "25 rows added".
3. **Given** rows were added from a file, **When** the matrix shows them, **Then** each row is labelled with a readable summary of its object (e.g. its first text field), not raw JSON.
4. **Given** some records repeat an existing input, **When** they are added, **Then** the repeats are merged as with the existing import, and Setup says how many were merged.

---

### User Story 4 - Load prepared questions (Priority: P2)

The user also keeps ready-made questions in the library as question files. A question file holds one or more questions, each with an ID, a type, a wording and criteria, in the same form the app already records for every run. A **Load questions** button opens the picker on the question files. The preview lists each question readably. Confirming fills the Run view's question editor, or adds the wordings as variants in an experiment.

**Why this priority**: Writing the same Choice options or Score levels by hand for every session is slow and error-prone. It is P2 because inputs (Stories 1–3) are the main request.

**Independent Test**: Put a question file with a Noul, a Choice and a Score question in the questions folder. Load it into the Run view and check all three questions appear in the editor exactly as written. Load it into a Choice experiment and check only the Choice question becomes a variant, with a message about the other two.

**Acceptance Scenarios**:

1. **Given** a question file is selected, **When** the preview shows, **Then** each question appears as a card with its ID, type, full wording and criteria (Choice options with descriptions, Score levels in order, Noul yes/no meanings), plus a validity mark.
2. **Given** the Run view's question editor holds questions, **When** the user confirms a question file, **Then** the app asks whether to replace the current questions or add to them. Cancel changes nothing.
3. **Given** the user chooses "add" and a loaded ID already exists, **When** the questions are added, **Then** the loaded question gets a free ID (e.g. `urgency_2`) and the app lists the renamed IDs.
4. **Given** a question in the file breaks the editor's rules (e.g. a Choice with one option), **When** the file is previewed, **Then** that question is marked invalid with the editor's message. Loading still works, and the editor shows the same error on that question.
5. **Given** an experiment of type Choice with options A/B/C, **When** the user loads a question file into its Setup, **Then** every Choice question whose options equal A/B/C becomes a new variant. The others are skipped, and Setup lists each skipped question with the reason (other type, or other criteria).
6. **Given** an experiment with no variants and no answers yet, **When** the user loads a question file, **Then** the experiment takes the type and criteria of the file's first eligible question, and every question that matches them becomes a variant.

---

### User Story 5 - Trust that files are read correctly, and get clear errors when they are not (Priority: P2)

Every file is checked before it can be used. Problems are explained in plain words with the location of the error, and an unusable file cannot be loaded.

**Why this priority**: The user asked for this explicitly. A silent misread (a number turned into text, a dropped nested field, mangled non-English characters) would corrupt every result built on that input.

**Independent Test**: Put a set of tricky files in both folders (invalid syntax, wrong top level, UTF-8 with a byte-order mark, Cyrillic text, deep nesting, large numbers, empty file, a question file in the inputs folder) and check each is either loaded exactly or rejected with a precise message.

**Acceptance Scenarios**:

1. **Given** a file with a syntax error, **When** it is selected, **Then** the picker marks it invalid, shows the message with line and column, and the confirm button is disabled.
2. **Given** an input file whose top level is neither an object nor a list of objects, **When** it is selected, **Then** the preview says what was found and what is accepted. For a list, it gives the position of the first item that is not an object.
3. **Given** a file saved as UTF-8 with a byte-order mark (common on Windows), **When** it is selected, **Then** it loads normally.
4. **Given** a file with non-English text (e.g. Cyrillic), emoji, nested lists of objects, `null`, `true`/`false`, decimals and integers, **When** it is loaded and run, **Then** every value reaches the question with its original type and characters.
5. **Given** a file larger than the size limit, **When** it is listed, **Then** it is shown as too large with the limit stated, and cannot be loaded.
6. **Given** an input file has a top-level field named `image` (Run view with an attached image) or `reference` (experiment with a shared reference), **When** it is loaded, **Then** the app warns that the name collides and says which value the question will see.
7. **Given** a file in the inputs folder looks like a question file (every top-level value has a type and a wording), **When** it is selected, **Then** the preview warns that it looks like questions and suggests moving it to the questions folder. Loading it as an input is still allowed.

---

### Edge Cases

- **Library folders missing or deleted while the app runs**: they are recreated on the next Load JSON or Load questions, and the picker shows the empty state.
- **Empty folder**: the picker says no files were found, shows the folder path, and offers to open the folder in the system file manager.
- **Non-JSON files** (`.txt`, `.csv`, images): not listed.
- **Subfolders**: files in subfolders are listed with their relative path (e.g. `tickets/refund_01.json`), so users can group files.
- **File changed or removed between listing and confirming**: the app re-reads the file on confirm. If it changed, the latest content is used; if it is gone, an error is shown and nothing is loaded.
- **Empty file or only whitespace**: rejected as "file is empty".
- **Empty list `[]`**: rejected as "the file holds no records".
- **Duplicate keys in one object**: flagged with a warning naming the key, because only one value can survive.
- **Very large integers** (beyond about 15–16 digits): flagged with a warning that precision may be lost, never silently rounded.
- **Empty object `{}`**: allowed, with a warning that questions will have no fields to refer to.
- **Large list file in the Run view** (thousands of records): the record selector stays usable, with search by record number or text.
- **Mixing inputs in one experiment**: JSON rows can be added to an experiment that already has text rows. Setup notes that rows of both kinds are present.
- **Box questions in a question file**: load into the Run view as usual, with the editor's image and model rules. In experiments they are always skipped, because Box is single-run only.
- **Question file with a single question that is not wrapped by an ID**: rejected, with a message showing the expected shape.
- **Question wording that is not plain text** (structured wording, which the app already supports): kept as is and shown formatted in the preview.

## Requirements *(mandatory)*

### Functional Requirements

**Library folders**

- **FR-001**: The system MUST provide a JSON library inside the project's data folder with two subfolders, one for input files and one for question files. It MUST create them automatically if they are missing.
- **FR-002**: The picker MUST show the full path of the folder it lists, and MUST offer an action that opens that folder in the operating system's file manager.
- **FR-003**: The system MUST list `.json` files in the relevant folder and its subfolders, with relative path, size and last-modified date, sorted by path. Other file types MUST NOT be listed.
- **FR-004**: The system MUST read the folder afresh each time the picker opens, and MUST offer a refresh action while it is open.
- **FR-005**: The system MUST NOT read or list files outside the library folders, including through relative paths or links that point elsewhere.
- **FR-006**: The system MUST only read library files. It MUST never write, rename or delete them.

**Entry points**

- **FR-007**: The Run view's Input panel MUST have a Load JSON button that opens the picker on input files.
- **FR-008**: The Run view's Questions panel MUST have a Load questions button that opens the picker on question files.
- **FR-009**: Each experiment's Setup MUST have a Load JSON button next to the existing .txt/.csv import (input files), and a Load questions button next to the add-variant area (question files).
- **FR-010**: The picker MUST open as a separate window over the current view, close with Cancel or Escape, keep keyboard focus inside while open, and return focus to the button that opened it.

**Input files: reading and preview**

- **FR-011**: An input file MUST have a top level that is either one object (one record) or a list of objects (one record per item). Anything else MUST be rejected with what was found, and for lists the position of the first item that is not an object.
- **FR-012**: Selecting an input file MUST show a structure preview listing every field with its full path in the dot form questions use (e.g. `ticket.customer.tier`), its type, and a sample value.
- **FR-013**: For list files, the preview MUST show the fields found across all records and mark fields present in only some records with their count.
- **FR-014**: For lists inside a record, the preview MUST show the item count and item type, and the fields of objects inside the list.
- **FR-015**: Each field in the preview MUST have a copy control that copies its path.
- **FR-016**: The preview MUST show a summary line: number of records, number of distinct fields, maximum nesting depth.
- **FR-017**: The system MUST warn, without blocking, when an input file looks like a question file.

**Question files: reading and preview**

- **FR-018**: A question file MUST have a top level that is an object mapping question IDs to questions. Each question MUST have a type and a wording and MAY have criteria, in the same form the app records for each run and exports from History.
- **FR-019**: Selecting a question file MUST show one card per question with its ID, type, full wording, criteria in readable form, and a validity mark.
- **FR-020**: The system MUST check each question with the same rules as the question editor (ID format, unique IDs, wording present, Choice needs at least 2 unique options, Score at least 2 non-empty levels, Noul criteria shape, Box needs an image and Jev 1.14 or later), and MUST show the same messages.
- **FR-021**: A question file whose structure cannot be read as questions at all (wrong top level, a question missing its type or wording) MUST be rejected. A question that breaks only editor rules MUST be marked invalid but MUST NOT block loading.

**Shared reading rules**

- **FR-022**: The system MUST check each file before it can be loaded. It MUST disable loading for unusable files and say why in plain words, with line and column for syntax errors.
- **FR-023**: The system MUST accept UTF-8 files with or without a byte-order mark, and MUST reject other encodings with a message that names the expected encoding.
- **FR-024**: Loaded content MUST reach the app unchanged: same keys, key order, nesting, value types (text, number, true/false, empty, list, object) and characters.
- **FR-025**: The system MUST warn, without blocking, about duplicate keys, integers too large to keep exactly, empty objects, and top-level input fields named `image` or `reference` that collide with values the app adds.
- **FR-026**: The system MUST reject files larger than 1 MB, and MUST say so in the file list before selection.
- **FR-027**: The system MUST re-read and re-check the file when the user confirms, and MUST use that content.
- **FR-028**: The preview MUST offer a read-only raw view of any file's content, formatted.

**Loading**

- **FR-029**: Confirming an input file in the Run view MUST switch the Input panel to Fields (JSON) and fill it with the chosen record: the only record, or the one picked in the record selector. It MUST ask before replacing a non-empty input. The loaded content MUST stay editable.
- **FR-030**: Confirming an input file in experiment Setup MUST append all its records as rows in file order, with the same validation, merging and reporting as the .txt/.csv import, and MUST report how many rows were added and merged.
- **FR-031**: Confirming a question file in the Run view MUST either replace the current questions or add to them, as the user chooses when questions already exist. On add, colliding IDs MUST get a free ID, and the renames MUST be listed.
- **FR-032**: Confirming a question file in experiment Setup MUST add as variants the wordings of questions whose type and criteria equal the experiment's. It MUST skip the others and list each skipped question with its reason. Box questions are always skipped.
- **FR-033**: If the experiment has no variants and no answers, loading a question file MUST set the experiment's type and criteria from the file's first eligible question (Noul, Choice or Score) before adding variants.
- **FR-034**: Wordings that repeat an existing variant MUST be merged as the experiment already does, and the merge MUST be reported.
- **FR-035**: The system MUST remember, for the current session, the last file loaded in each place, and the picker MUST preselect it.

### Key Entities

- **JSON library**: The folder under the project's data folder that holds prepared files, with an inputs subfolder and a questions subfolder. Both may contain further subfolders.
- **Library file**: One `.json` file. Attributes: kind (input or questions, from its folder), relative path, size, last-modified date, validity, warnings.
- **Record**: One JSON object from an input file. It is one input in the Run view or one experiment row. An object file yields one record, a list file one per item.
- **Field descriptor**: One entry in an input preview: path, type, sample value, item count (lists), presence count across records.
- **Prepared question**: One entry in a question file: ID, type (Noul, Choice, Score, Box), wording, criteria, validity and messages.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can go from clicking Load JSON to a ready-to-run Run view in under 15 seconds for a file they know by name.
- **SC-002**: The picker lists a folder and previews any valid file up to 1 MB in under 1 second.
- **SC-003**: In a test set of at least 20 files covering the edge cases above, 100% of valid files load with content identical to the file, and 100% of unusable files are rejected with a message that names the problem and, for syntax errors, its location.
- **SC-004**: A user who has never seen a given input file can name the exact path of a nested field to use in a question, from the preview alone, on the first try.
- **SC-005**: Filling an experiment with 100 inputs from one list file takes 3 user actions once the experiment is open (Load JSON, select, confirm).
- **SC-006**: Setting up a Run view with a saved set of 5 questions takes 3 user actions (Load questions, select, confirm), compared with retyping every wording and criterion.
- **SC-007**: A question file saved by the user loads back with every question identical to the original: same IDs, types, wordings and criteria.

## Assumptions

- The library lives at `data/json/`, with `data/json/inputs/` and `data/json/questions/`, beside the existing database and images. Keeping the kinds in separate folders makes each picker list only files it can load, and avoids guessing a file's kind from its content.
- The user creates and edits library files with their own tools. Saving files from the app (e.g. "save current questions to library") is out of scope for this feature.
- "A new window" means a window inside the app, layered over the current view (like the app's existing confirm dialogs), not a separate operating-system file dialog. Browsers cannot open a system dialog at a chosen folder, and an in-app window is what makes the preview possible.
- Input files fill the same "Fields (JSON)" input the Run view already has, so no new input kind is added. The image attachment stays separate and works as before.
- A question file uses the question form the app already stores per run and exports from History, so a run's questions copied from an export are a valid question file.
- The 1 MB per-file limit is well above realistic files and keeps the preview instant. It can be raised later if needed.
- Box questions stay single-run only. Loading files does not change which question types are allowed where.
- Checking whether a question's wording refers to fields that exist in the loaded input is out of scope. The preview's field paths support doing this by eye.
- The remembered "last loaded file" lasts for the session and is not saved between restarts.
- Everything here works offline: listing, preview, validation and loading make no calls to Jev and cost nothing.
