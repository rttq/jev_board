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
| `score` | how much, on a scale | Required. A **list** of at least 2 non-empty level labels, from lowest to highest |
| `box` | where in the image | No criteria. Works only in the Run view with an attached image; never put it in a file meant for experiments |

## Files meant for one experiment

An experiment compares several **wordings** of one question. Only questions with the experiment's exact type and criteria become variants; the app skips the rest. So in a question file made for an experiment:

- every question has the **same `type`**;
- every question has **identical `criteria`** (the same option names and descriptions, or the same levels in the same order);
- only `instructions` and the ID differ.

## Checking a file

Put the file in its folder, then click **Load JSON** or **Load questions** in jevbench. The picker checks every file: a file that cannot be used is marked `INVALID`, with the reason and, for syntax errors, the line and column. Questions that break a rule are marked `INVALID` on their card.
