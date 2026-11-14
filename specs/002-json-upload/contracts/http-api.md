# Contract: library routes (added to the local HTTP API)

These routes extend the 001 API ([../../001-jev-classification-gui/contracts/http-api.md](../../001-jev-classification-gui/contracts/http-api.md)): same base URL, JSON bodies and error shape `{"error", "field"}`. `{kind}` is `inputs` or `questions`; any other value returns 404. None of them call Jev, and all work offline.

## `GET /api/library/{kind}`: list files

Creates both library folders if missing, then lists `.json` files under `<data_dir>/json/{kind}/`, recursively.

```json
{"kind": "inputs",
 "folder": "E:\\my products\\jev_tests\\data\\json\\inputs",
 "files": [
   {"path": "ticket_01.json", "size": 412, "mtime": "2026-11-14T10:02:11", "too_large": false},
   {"path": "tickets/batch.json", "size": 2306118, "mtime": "2026-11-14T09:40:00", "too_large": true}
 ]}
```

Files that resolve outside the folder (links) are left out. The list is sorted by `path`, case-insensitive.

## `GET /api/library/{kind}/file?path=<relative path>`: read and analyze one file

- `400 {"error": "path must stay inside the library folder", "field": "path"}`: missing path, absolute path, `..` escape, a link outside the folder, or a name not ending in `.json`.
- `404 {"error": "file not found", "field": "path"}`: the file was removed.
- Otherwise `200`. An unusable file is still `200`, with `ok: false`:

```json
{"path": "bad.json", "kind": "inputs", "size": 88, "mtime": "…", "ok": false,
 "error": {"message": "Expecting ',' delimiter", "line": 4, "col": 17},
 "warnings": [], "pretty": null}
```

Input file, `ok`:

```json
{"path": "tickets/refunds.json", "kind": "inputs", "size": 1880, "mtime": "…", "ok": true, "error": null,
 "warnings": ["key `priority` appears twice in one object; the last value is used"],
 "pretty": "[\n  {\n    \"ticket\": {…}\n  }\n]",
 "inputs": {
   "shape": "list",
   "records": [{"ticket": {"subject": "Refund", "priority": 2, "tags": ["billing"]}}, "…"],
   "depth": 3,
   "fields": [
     {"path": "ticket", "type": "object", "count": 40},
     {"path": "ticket.subject", "type": "text", "sample": "Refund", "count": 40},
     {"path": "ticket.priority", "type": "number", "sample": 2, "count": 31},
     {"path": "ticket.tags", "type": "list", "items": {"n": 1, "type": "text"}, "count": 40}
   ]}}
```

Question file, `ok`:

```json
{"path": "urgency.json", "kind": "questions", "ok": true, "error": null, "warnings": [], "pretty": "…",
 "questions": {
   "urgent": {"wire": {"type": "noul", "instructions": "Is the ticket urgent?",
                       "criteria": {"true": "customer is blocked"}},
              "valid": true, "errors": [], "notes": []},
   "tier":   {"wire": {"type": "choice", "instructions": "Which tier?", "criteria": {"free": null}},
              "valid": false, "errors": ["a Choice needs at least 2 options"], "notes": []}
 }}
```

The validation rules and messages are in [../data-model.md](../data-model.md).

## `POST /api/library/{kind}/reveal`: open the folder in the system file manager

Body ignored. Creates the folder if missing, then opens it.

- `200 {"folder": "<absolute path>"}`
- `500 {"error": "could not open the folder: <reason>", "field": null}`: the dialog keeps showing the path.
