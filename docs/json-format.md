# jevbench JSON format

Use this when you create JSON files for jevbench, or when you ask an AI to create them (paste this whole page into the prompt).
There are two kinds of file, kept in two folders. Write each file as UTF-8, under 1 MB, with a `.json` name.

| Folder | Holds |
|--------|-------|
| `data/json/inputs/` | Data to judge: one object, or a list of objects |
| `data/json/questions/` | Ready-made questions, keyed by ID |

## Input files

The top level is **one object** (one input) or a **list of objects** (one input per object). Any fields and any nesting are allowed. Questions refer to fields by path, e.g. `ticket.subject` or `messages[].author`.

```json inputs
[
  {"ticket": {"subject": "Refund for order 1182", "priority": 2, "tags": ["billing"],
              "customer": {"tier": "pro", "name": "Ольга"}},
   "messages": [{"author": "customer", "text": "I was charged twice for the same order."}]},
  {"ticket": {"subject": "App crashes on start", "priority": 3, "tags": ["tech", "urgent"],
              "customer": {"tier": "free", "name": "Sam"}},
   "messages": [{"author": "customer", "text": "Since the update it closes right after the logo."}]}
]
```

Rules:

- Every record has the **same field names and the same nesting**. Do not use `subject` in one record and `title` in another.
- A value keeps one type in every record (a number stays a number, not sometimes `"2"`).
- Do not use these as top-level field names: `image` (the attached image uses it) and `reference` (an experiment's shared reference uses it).
- Numbers stay below 9007199254740991. Write longer IDs as text: `"id": "12345678901234567890"`.
- No comments, no trailing commas, no `NaN` or `Infinity`.

## Question files

The top level is an object that maps **question IDs** to questions. It is never a list, and never a single unwrapped question.

```json questions
{
  "urgent": {"type": "noul", "instructions": "Is the customer unable to use the product right now?",
             "criteria": {"true": "blocked: cannot log in, crashes, payment fails",
                          "false": "a question, a wish, or a minor annoyance"}},
  "area":   {"type": "choice", "instructions": "Which team should handle `ticket.subject`?",
             "criteria": {"billing": "money, invoices, refunds", "tech": "bugs and crashes", "sales": null}},
  "mood":   {"type": "score", "instructions": "How upset is the customer in `messages`?",
             "criteria": ["calm", "annoyed", "angry"]}
}
```

Each question has:

| Key | Rule |
|-----|------|
| ID (the key) | 1–64 characters: letters, digits, `_` or `-`. No spaces. Unique in the file |
| `type` | `noul`, `choice`, `score` or `box` |
| `instructions` | The question wording, not empty. Refer to input fields by path in backticks, e.g. `` `ticket.subject` `` |
| `criteria` | Depends on the type (below) |

Criteria by type:

| Type | Asks | `criteria` |
|------|------|------------|
| `noul` | yes or no | Optional. An object with only the keys `"true"` and/or `"false"`, each a non-empty text: what counts as yes, what counts as no |
| `choice` | which one of several options | Required. An **object** of at least 2 options: option name → description text, or `null` for no description. Never a list |
| `score` | how much, on a scale | Required. A **list** of at least 2 levels, from lowest to highest. A level is a non-empty text or a non-empty object, e.g. `{"description": "…", "examples": ["…"]}`. Use the same fields on every level |
| `box` | where in the image | No criteria. Works only in the Run view with an attached image; never put it in a file meant for experiments |

### Score levels as objects

Jev judges each level on its own, against the input, without seeing the other levels. So a level should describe a concrete situation, not a degree like "moderate". When Jev keeps confusing two neighboring levels, write each level as an object with the same fields, such as a description and examples:

```json
"criteria": [
  {"description": "names the concept but gives it the wrong role", "examples": ["the vector DB turns text into vectors"]},
  {"description": "right idea, said loosely or in slang", "examples": ["I stored the embeddings in Supabase"]},
  {"description": "right idea, with the reason or a parameter", "examples": ["chunks of 800 tokens with 100 overlap so steps don't split"]}
]
```

- Examples help only when they look like the real inputs. Unrelated examples change little.
- Check a change on cases whose right level you know, not by whether confidence went up.
- In the app's level editor, an object level is edited as JSON text. Text that starts with `{` must be a valid, non-empty JSON object.

## Files meant for one experiment

An experiment compares several **wordings** of one question. Only questions with the experiment's exact type and criteria become variants; the app skips the rest. So in a question file made for an experiment:

- every question has the **same `type`**;
- every question has **identical `criteria`** (the same option names and descriptions, or the same levels in the same order);
- only `instructions` and the ID differ.

## Shared reference (experiments)

An experiment can carry one **shared reference**: a passage of text that Jev sees next to every input, such as a correct explanation, a policy or a definition. It is not part of either file. You set it in the experiment's **Setup → Shared reference (optional)**.

What Jev receives:

| Row | Without a reference | With a reference |
|-----|---------------------|------------------|
| Text row | `{"text": "…"}` | `{"reference": "…", "text": "…"}` |
| JSON row | `{"ticket": {…}, …}` | `{"reference": "…", "ticket": {…}, …}` |

- `reference` is an ordinary field name, not a keyword. Jev reads every field it gets, so it uses the reference **even if no question mentions it**. Questions may still point at it, e.g. ``"Using `reference` as the correct explanation, how well does `text` …"``.
- If a record in an input file has its own top-level `reference` field, that value wins and the shared reference is not used for that row. That is why input files should not use `reference` as a field name.
- The reference is part of each cell's identity. Changing it shows every cell as unanswered, and the earlier answers stay in History. To compare results with and without a reference, duplicate the experiment and set the reference on the copy.

What it changed in a measured test (Score, 5 levels, 9 definitions of "agent harness", the same questions run with and without a 150-word reference):

| Case | Without reference | With reference |
|------|-------------------|----------------|
| Correct definitions (7 rows) | on their labels, confidence ≥ 0.77 | unchanged |
| A wrong answer the levels did not anticipate ("a GPU cluster") | 0.36, confidence 0.72 | 0.04, confidence 0.97 |
| Right words, roles reversed ("tools call the model") | 3.04, confidence 0.67: Jev was fooled | 1.75, confidence 0.25: flagged as uncertain |
| Question points at `reference` or not | — | almost no difference |
| Input tokens per request | ~700 | ~970: every request pays for the reference |

So a reference helps most with wrong answers the levels don't describe. Even when Jev still misses, low confidence flags the case for review. It does not make Jev stricter on correct answers.

Writing a reference (also when an AI writes one):

- Write it as a **correct, general explanation** of the topic: what the thing is and **who does what**. Roles and relationships are where Jev is weakest without one.
- **Don't tailor it to the test inputs.** Don't list the specific wrong answers you are testing. Otherwise the experiment measures the reference, not Jev.
- Keep it focused: about 100–300 words is enough. It is sent with every request, so its length multiplies the cost. The hard limits are 64k tokens per request and 32k per question.
- Plain text, no JSON. It goes in the Setup box, not in a file.

## Checking a file

Put the file in its folder, then click **Load JSON** or **Load questions** in jevbench. The picker checks every file: a file that cannot be used is marked `INVALID`, with the reason and, for syntax errors, the line and column. Questions that break a rule are marked `INVALID` on their card.
