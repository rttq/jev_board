"""SQLite storage: runs, answers, experiments, prefs."""

import csv
import io
import json
import os
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

from . import jev

# ponytail: one global write lock; fine for a single local user, per-table locks if that ever changes
LOCK = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  experiment_id INTEGER,
  input TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  image_sha TEXT,
  questions TEXT NOT NULL,
  model_requested TEXT NOT NULL,
  model_used TEXT,
  status TEXT NOT NULL,
  error TEXT,
  input_tokens INTEGER,
  price_per_mtok REAL NOT NULL,
  cost_usd REAL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  request_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS runs_created ON runs(created_at);
CREATE INDEX IF NOT EXISTS runs_exp ON runs(experiment_id);
CREATE INDEX IF NOT EXISTS runs_input ON runs(input_hash);

CREATE TABLE IF NOT EXISTS answers (
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL,
  question_hash TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  model_used TEXT,
  type TEXT NOT NULL,
  answer TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, question_id)
);
CREATE INDEX IF NOT EXISTS answers_cell ON answers(input_hash, question_hash, model_used, created_at);

CREATE TABLE IF NOT EXISTS experiments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  criteria TEXT,
  reference TEXT,
  rows TEXT NOT NULL DEFAULT '[]',
  columns TEXT NOT NULL DEFAULT '[]',
  view TEXT NOT NULL DEFAULT '{}',
  views TEXT NOT NULL DEFAULT '{}',
  steps TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prefs (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL);
"""

PREF_DEFAULTS = {
    "theme": "system",
    "text_scale": 1.0,
    "prob_format": "percent",
    "prob_decimals": 0,
    "default_model": "jev-latest",
    "price_per_mtok": 0.042,
    "concurrency": 4,
}


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _connect(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    try:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(SCHEMA)
        have = {r[1] for r in conn.execute("PRAGMA table_info(experiments)")}
        if "reference" not in have:  # pre-reference DBs
            conn.execute("ALTER TABLE experiments ADD COLUMN reference TEXT")
        if "steps" not in have:  # pre-steps DBs
            conn.execute("ALTER TABLE experiments ADD COLUMN steps TEXT NOT NULL DEFAULT '[]'")
        conn.execute("SELECT count(*) FROM runs").fetchone()
        return conn
    except sqlite3.DatabaseError:
        conn.close()  # Windows keeps the file locked otherwise, and the rename would fail
        raise


class ThreadConn:
    """One sqlite connection per thread, behind the single `conn` every function takes.
    The server handles requests on parallel threads, and a shared sqlite3 connection fails under concurrent
    reads ("bad parameter or other API misuse"). Writes stay serialized by LOCK."""

    def __init__(self, path: Path, first: sqlite3.Connection):
        self.path, self.local = path, threading.local()
        self.local.c = first  # the opening thread reuses the connection that created and checked the schema

    def _c(self) -> sqlite3.Connection:
        c = getattr(self.local, "c", None)
        if c is None:
            c = self.local.c = sqlite3.connect(self.path)
            c.row_factory = sqlite3.Row
            c.execute("PRAGMA foreign_keys=ON")
        return c

    def __getattr__(self, name):
        return getattr(self._c(), name)

    def __enter__(self):  # `with conn:` transactions (dunder methods bypass __getattr__)
        return self._c().__enter__()

    def __exit__(self, *exc):
        return self._c().__exit__(*exc)


def open_db(data_dir) -> tuple["ThreadConn", str | None]:
    data_dir = Path(data_dir)
    (data_dir / "images").mkdir(parents=True, exist_ok=True)
    path = data_dir / "jevbench.db"
    try:
        return ThreadConn(path, _connect(path)), None
    except sqlite3.DatabaseError as e:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        broken = path.with_name(f"jevbench.db.broken-{stamp}")
        for suffix in ("", "-wal", "-shm"):
            p = Path(str(path) + suffix)
            if p.exists():
                os.replace(p, Path(str(broken) + suffix))
        notice = f"The data file could not be read ({e}). It was moved to {broken.name} and a fresh one was started."
        return ThreadConn(path, _connect(path)), notice


# ---------- prefs ----------

def _clean_prefs(p: dict) -> dict:
    out = dict(PREF_DEFAULTS)
    for k in PREF_DEFAULTS:
        if k in p:
            out[k] = p[k]
    if out["theme"] not in ("light", "dark", "system"):
        out["theme"] = "system"
    if out["prob_format"] not in ("percent", "fraction"):
        out["prob_format"] = "percent"
    out["text_scale"] = min(1.5, max(0.85, float(out["text_scale"])))
    out["prob_decimals"] = min(4, max(0, int(out["prob_decimals"])))
    out["concurrency"] = min(8, max(1, int(out["concurrency"])))
    out["price_per_mtok"] = max(0.0, float(out["price_per_mtok"]))
    out["default_model"] = str(out["default_model"]) or "jev-latest"
    return out


def get_prefs(conn) -> dict:
    row = conn.execute("SELECT data FROM prefs WHERE id = 1").fetchone()
    return _clean_prefs(json.loads(row["data"]) if row else {})


def put_prefs(conn, partial: dict) -> dict:
    merged = _clean_prefs({**get_prefs(conn), **(partial or {})})
    with LOCK, conn:
        conn.execute("INSERT INTO prefs(id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
                     (json.dumps(merged),))
    return merged


def reset_prefs(conn) -> dict:
    with LOCK, conn:
        conn.execute("DELETE FROM prefs")
    return get_prefs(conn)


# ---------- runs ----------

def insert_run(conn, run: dict) -> int:
    created = now()
    with LOCK, conn:
        cur = conn.execute(
            """INSERT INTO runs(created_at, experiment_id, input, input_hash, image_sha, questions, model_requested,
               model_used, status, error, input_tokens, price_per_mtok, cost_usd, duration_ms, request_id)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (created, run.get("experiment_id"), json.dumps(run["input"]), run["input_hash"], run.get("image_sha"),
             json.dumps(run["questions"]), run["model_requested"], run.get("model_used"), run["status"],
             run.get("error"), run.get("input_tokens"), run["price_per_mtok"], run.get("cost_usd"),
             run.get("duration_ms", 0), run.get("request_id")))
        run_id = cur.lastrowid
        if run["status"] == "ok":
            for qid, ans in (run.get("answers") or {}).items():
                q = run["questions"][qid]
                conn.execute(
                    """INSERT INTO answers(run_id, question_id, question_hash, input_hash, model_used, type, answer, created_at)
                       VALUES (?,?,?,?,?,?,?,?)""",
                    (run_id, qid, jev.question_hash(q), run["input_hash"], run.get("model_used"),
                     ans.get("type", q["type"]), json.dumps(ans), created))
    return run_id


def _run_dict(conn, row) -> dict:
    d = dict(row)
    d["input"] = json.loads(d["input"])
    d["questions"] = json.loads(d["questions"])
    d["tags"] = [t for t in d["tags"].split(",") if t]
    d["answers"] = {a["question_id"]: json.loads(a["answer"]) for a in
                    conn.execute("SELECT question_id, answer FROM answers WHERE run_id = ?", (d["id"],))}
    d["question_hashes"] = {qid: jev.question_hash(q) for qid, q in d["questions"].items()}
    return d


def get_run(conn, run_id: int) -> dict | None:
    row = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
    return _run_dict(conn, row) if row else None


def _run_where(f: dict) -> tuple[str, list]:
    """Filters: type, model, status, tag, experiment_id, q, from, to (YYYY-MM-DD, inclusive), ids (list or "1,2")."""
    w, a = [], []
    if f.get("type"):  # the questions JSON as sent, so error runs (no answers) match too
        w.append("questions LIKE ?"); a.append(f'%"type": "{f["type"]}"%')
    if f.get("model"):
        w.append("(model_used = ? OR model_requested = ?)"); a += [f["model"]] * 2
    if f.get("status"):
        w.append("status = ?"); a.append(f["status"])
    if f.get("tag"):
        w.append("(',' || tags || ',') LIKE ?"); a.append(f"%,{f['tag']},%")
    if f.get("experiment_id"):
        w.append("experiment_id = ?"); a.append(int(f["experiment_id"]))
    if f.get("q"):  # stored JSON escapes non-ASCII, so match both the raw and the escaped spelling
        forms = {f"%{f['q']}%", f"%{json.dumps(f['q'])[1:-1]}%"}
        w.append("(" + " OR ".join(["input LIKE ? OR questions LIKE ? OR note LIKE ?"] * len(forms)) + ")")
        a += [x for x in forms for _ in range(3)]
    if f.get("from"):
        w.append("created_at >= ?"); a.append(f["from"])
    if f.get("to"):
        w.append("created_at < date(?, '+1 day')"); a.append(f["to"])
    if f.get("ids"):
        ids = [int(i) for i in (f["ids"].split(",") if isinstance(f["ids"], str) else f["ids"]) if str(i).strip()]
        w.append(f"id IN ({_in(len(ids)) or 'NULL'})"); a += ids
    return (" WHERE " + " AND ".join(w)) if w else "", a


def list_runs(conn, filters: dict, limit: int | None = 50, offset: int = 0) -> dict:
    """Newest first. limit=None returns everything (export)."""
    where, args = _run_where(filters or {})
    total = conn.execute("SELECT count(*) FROM runs" + where, args).fetchone()[0]
    page = "" if limit is None else f" LIMIT {min(500, max(1, int(limit)))} OFFSET {max(0, int(offset))}"
    rows = conn.execute("SELECT * FROM runs" + where + " ORDER BY id DESC" + page, args).fetchall()
    return {"total": total, "runs": [_run_dict(conn, r) for r in rows]}


def patch_run(conn, run_id: int, body: dict) -> dict | None:
    """Only note and tags can change; everything else about a run is a record of what was sent."""
    sets, args = [], []
    if "note" in body:
        sets.append("note = ?"); args.append(str(body["note"] or ""))
    if "tags" in body:
        tags = body["tags"] if isinstance(body["tags"], list) else str(body["tags"] or "").split(",")
        sets.append("tags = ?"); args.append(",".join(t.strip().replace(",", " ") for t in map(str, tags) if t.strip()))
    if sets:
        with LOCK, conn:
            conn.execute(f"UPDATE runs SET {', '.join(sets)} WHERE id = ?", args + [run_id])
    return get_run(conn, run_id)


def delete_run(conn, run_id: int) -> bool:
    with LOCK, conn:  # answers go with it (ON DELETE CASCADE)
        return conn.execute("DELETE FROM runs WHERE id = ?", (run_id,)).rowcount > 0


EXPORT_COLUMNS = ["run_id", "created_at", "experiment_id", "model_used", "status", "input_tokens", "cost_usd",
                  "question_id", "type", "instructions", "result", "confidence", "probabilities", "input_text",
                  "tags", "note", "error"]


def _result(a: dict | None):
    if not a:
        return ""
    if a.get("type") == "box":
        b = a.get("box") or {}
        return ",".join(str(b.get(k)) for k in ("top", "bottom", "left", "right"))
    return a.get(a.get("type"), "")


def export_runs(conn, filters: dict, fmt: str) -> bytes:
    runs = list_runs(conn, filters, limit=None)["runs"]
    if fmt == "jsonl":
        return "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in runs).encode()
    out = io.StringIO()
    w = csv.writer(out, lineterminator="\r\n")
    w.writerow(EXPORT_COLUMNS)
    for r in runs:
        inp = r["input"]
        text = inp.get("text", "") if inp.get("kind") != "json" else json.dumps(inp.get("fields"), ensure_ascii=False)
        for qid, q in r["questions"].items():
            a = r["answers"].get(qid)
            instr = q.get("instructions")
            w.writerow([r["id"], r["created_at"], r["experiment_id"] or "", r["model_used"] or "", r["status"],
                        "" if r["input_tokens"] is None else r["input_tokens"], "" if r["cost_usd"] is None else r["cost_usd"],
                        qid, q.get("type"), instr if isinstance(instr, str) else json.dumps(instr, ensure_ascii=False),
                        _result(a), (a or {}).get("confidence", ""),
                        json.dumps(a["probabilities"], ensure_ascii=False) if a and a.get("probabilities") else "",
                        text, ";".join(r["tags"]), r["note"] or "", r["error"] or ""])
    return ("﻿" + out.getvalue()).encode("utf-8")  # BOM so Excel reads UTF-8


# ---------- experiments ----------

EXP_TYPES = ("noul", "choice", "score")
DEFAULT_VIEW = {"threshold": {"low": 0.5, "high": 0.8}, "focus_option": None,
                "sort": {"by": "input", "dir": "asc"},
                "filters": {"labeled": None, "misclassified": False, "review_only": False,
                            "spread_min": None, "tags": [], "text": ""},
                "pivot": False, "overlay": "value", "model": None, "weights_override": None,
                "gate": {"min_level": None, "pass_options": None, "review_passes": False},
                "step_name": None, "collapsed": False}


class ExpError(Exception):
    """status 400 (bad document, optional per-row errors), 404, or 409 (would change answered wording)."""

    def __init__(self, status, error, rows=None):
        self.status, self.error, self.rows = status, error, rows


def _wire(exp, col) -> dict:
    q = {"type": exp["type"], "instructions": col["instructions"]}
    if exp.get("criteria") is not None:
        q["criteria"] = exp["criteria"]
    return q


def _label_ok(t, criteria, label) -> bool:
    if label is None:
        return True
    if t == "noul":
        return label in ("yes", "no")
    if t == "choice":
        return isinstance(criteria, dict) and label in criteria
    return isinstance(label, int) and not isinstance(label, bool) and 0 <= label < len(criteria or [])


def _next_key(items, prefix) -> str:
    # ponytail: max+1, so deleting the highest key frees it again; a stored counter if views ever pin removed keys
    nums = [int(i["key"][1:]) for i in items if i.get("key") and i["key"][1:].isdigit()]
    return f"{prefix}{max(nums or [0]) + 1}"


def _check_question(t, criteria, where=""):
    if t not in EXP_TYPES:
        raise ExpError(400, where + "type must be noul, choice or score")
    probe = {"type": t, "instructions": "x"}
    if criteria is not None:
        probe["criteria"] = criteria
    errs = jev.validate_questions({"x": probe}, False, "jev-latest")
    if errs:
        raise ExpError(400, where + errs[0]["error"])


def _columns(q, cols, where, warnings) -> list[dict]:
    """Normalize one step's variants (no keys assigned here). q = {type, criteria}."""
    out, qseen = [], set()
    for i, c in enumerate(cols):
        instr = c.get("instructions")
        if not instr or (isinstance(instr, str) and not instr.strip()):
            raise ExpError(400, f"{where}variant {i + 1} has no wording")
        col = {"key": c.get("key"), "instructions": instr, "weight": float(c.get("weight", 1)),
               "threshold": c.get("threshold"), "hidden": bool(c.get("hidden", False))}
        col["question_hash"] = jev.question_hash(_wire(q, col))
        if col["question_hash"] in qseen:
            warnings.append(f"{where}variant {i + 1} repeats an earlier wording and was merged")
            continue
        qseen.add(col["question_hash"])
        out.append(col)
    return out


def all_cols(e) -> list[dict]:
    """Variants of every step: step 1 (top level) first, then each stored step."""
    return e["columns"] + [c for s in e.get("steps") or [] for c in s["columns"]]


def _normalize(body: dict, old: dict | None = None) -> tuple[dict, list[str]]:
    """Validate and fill keys/hashes. Returns (experiment fields, warnings). Raises ExpError(400)."""
    old = old or {}
    t = body.get("type", old.get("type"))
    criteria = body["criteria"] if "criteria" in body else old.get("criteria")
    _check_question(t, criteria)
    name = str(body.get("name", old.get("name", ""))).strip()
    if not name:
        raise ExpError(400, "give the experiment a name")
    ref = str(body.get("reference", old.get("reference")) or "").strip() or None
    exp = {"type": t, "criteria": criteria, "name": name, "reference": ref}
    warnings, row_errs, rows, seen = [], [], [], set()
    for i, r in enumerate(body.get("rows", old.get("rows", []))):
        inp = r.get("input")
        if isinstance(inp, str):
            inp = {"kind": "text", "text": inp}
        if isinstance(inp, dict) and inp.get("kind") == "json" and isinstance(inp.get("fields"), dict):
            inp = {"kind": "json", "fields": inp["fields"]}
        elif isinstance(inp, dict) and inp.get("kind", "text") == "text" and str(inp.get("text", "")).strip():
            inp = {"kind": "text", "text": str(inp["text"])}
        else:
            row_errs.append({"index": i, "error": "input must be non-empty text or a JSON object"})
            continue
        if not _label_ok(t, criteria, r.get("label")):
            row_errs.append({"index": i, "error": f"label {r.get('label')!r} is not valid for {t}"})
            continue
        h = jev.input_hash(jev.with_reference(inp, ref), None)  # the reference is part of what Jev sees
        if h in seen:
            warnings.append(f"row {i + 1} repeats an earlier input and was merged")
            continue
        seen.add(h)
        rows.append({"key": r.get("key"), "input": inp, "input_hash": h, "label": r.get("label"),
                     "tags": [str(x).strip() for x in (r.get("tags") or []) if str(x).strip()]})
    if row_errs:
        raise ExpError(400, f"{len(row_errs)} row(s) could not be imported", row_errs)
    for it in rows:
        if not it["key"]:
            it["key"] = _next_key(rows, "r")
    row_keys = {r["key"] for r in rows}
    cols = _columns(exp, body.get("columns", old.get("columns", [])), "", warnings)
    steps = []
    for n, s in enumerate(body.get("steps", old.get("steps") or [])):
        where = f"step {n + 2}: "
        st, cr = s.get("type"), s.get("criteria")
        _check_question(st, cr, where)
        labels = {}
        for k, v in (s.get("labels") or {}).items():
            if k not in row_keys or v is None:
                continue  # the row was removed, or the label cleared
            if not _label_ok(st, cr, v):
                raise ExpError(400, f"{where}label {v!r} is not valid for {st}")
            labels[k] = v
        steps.append({"key": s.get("key"), "type": st, "criteria": cr,
                      "columns": _columns({"type": st, "criteria": cr}, s.get("columns") or [], where, warnings),
                      "labels": labels, "view": {**DEFAULT_VIEW, **(s.get("view") or {})}, "views": s.get("views") or {}})
    # new items never take a key the previous version used, so they can't inherit its answered lock
    old_steps = old.get("steps") or []
    for s in steps:
        if not s["key"]:
            s["key"] = _next_key(steps + old_steps, "s")
    every = cols + [c for s in steps for c in s["columns"]]
    keys = [c["key"] for c in every if c["key"]]
    dup = next((k for k in keys if keys.count(k) > 1), None)
    if dup:
        raise ExpError(400, f"variant key {dup} is used twice")
    old_cols = all_cols(old) if old else []
    for c in every:  # keys are unique across steps, so one cells map serves every step
        if not c["key"]:
            c["key"] = _next_key(every + old_cols, "c")
    exp.update(rows=rows, columns=cols, steps=steps,
               view={**DEFAULT_VIEW, **(body.get("view") or old.get("view") or {})},
               views=body.get("views", old.get("views", {})))
    return exp, warnings


def _exp_dict(row) -> dict:
    d = dict(row)
    for k in ("criteria", "rows", "columns", "view", "views", "steps"):
        d[k] = json.loads(d[k]) if d[k] is not None else None
    d["steps"] = d["steps"] or []
    return d


def _save(conn, exp_id, exp, created=False) -> int:
    vals = (exp["name"], exp["type"], json.dumps(exp["criteria"]), exp.get("reference"), json.dumps(exp["rows"]),
            json.dumps(exp["columns"]), json.dumps(exp["view"]), json.dumps(exp["views"]), json.dumps(exp.get("steps", [])))
    try:
        with LOCK, conn:
            if created:
                t = now()
                return conn.execute("INSERT INTO experiments(name, type, criteria, reference, rows, columns, view, views,"
                                    " steps, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", vals + (t, t)).lastrowid
            conn.execute("UPDATE experiments SET name=?, type=?, criteria=?, reference=?, rows=?, columns=?, view=?, views=?,"
                         " steps=?, updated_at=? WHERE id=?", vals + (now(), exp_id))
            return exp_id
    except sqlite3.IntegrityError:
        raise ExpError(409, f"an experiment named {exp['name']!r} already exists")


def create_experiment(conn, body) -> tuple[int, list[str]]:
    exp, warnings = _normalize(body or {})
    return _save(conn, None, exp, created=True), warnings


def experiment_from_runs(conn, name, type_, run_ids=None, filters=None) -> tuple[int, list[str], dict]:
    """Rows = distinct inputs (first seen first); columns = distinct wordings of `type_` sharing its most common
    criteria. Cells then fill from the existing answers by hash. Never calls Jev."""
    if type_ not in EXP_TYPES:
        raise ExpError(400, "type must be noul, choice or score")
    f = {"ids": run_ids} if run_ids else dict(filters or {})
    runs = [r for r in reversed(list_runs(conn, {**f, "status": "ok"}, limit=None)["runs"])]  # oldest first
    skipped = {"other_types": 0, "other_criteria": 0, "with_image": 0}
    qs = []  # (run, criteria key, criteria, instructions)
    for r in runs:
        for q in r["questions"].values():
            if q.get("type") != type_:
                skipped["other_types"] += 1
            elif r["image_sha"]:
                skipped["with_image"] += 1  # experiment rows carry no image, so these cells could never match
            else:
                qs.append((r, json.dumps(q.get("criteria"), sort_keys=True), q.get("criteria"), q["instructions"]))
    if not qs:
        raise ExpError(400, f"The selection has no {type_} questions to build a matrix from.")
    counts = {}
    for _, key, _, _ in qs:
        counts[key] = counts.get(key, 0) + 1
    best = max(counts, key=counts.get)  # ties: the first seen (dicts keep insertion order)
    rows, cols, seen_in, seen_q = [], [], set(), set()
    for r, key, crit, instr in qs:
        if key != best:
            skipped["other_criteria"] += 1
            continue
        if r["input_hash"] not in seen_in:
            seen_in.add(r["input_hash"]); rows.append({"input": r["input"]})
        ik = json.dumps(instr, sort_keys=True)
        if ik not in seen_q:
            seen_q.add(ik); cols.append({"instructions": instr})
    criteria = json.loads(best)
    exp_id, warnings = create_experiment(conn, {"name": name, "type": type_, "criteria": criteria, "rows": rows, "columns": cols})
    notes = {"other_types": "of other types", "other_criteria": f"of type {type_} with different criteria",
             "with_image": "with an image"}
    warnings += [f"{n} question{'s' if n != 1 else ''} {notes[k]} left out." for k, n in skipped.items() if n]
    return exp_id, warnings, skipped


def get_experiment(conn, exp_id) -> dict | None:
    row = conn.execute("SELECT * FROM experiments WHERE id = ?", (exp_id,)).fetchone()
    return _exp_dict(row) if row else None


def list_experiments(conn) -> list[dict]:
    out = []
    for row in conn.execute("SELECT * FROM experiments ORDER BY updated_at DESC"):
        e = _exp_dict(row)
        cost = conn.execute("SELECT sum(cost_usd) FROM runs WHERE experiment_id = ?", (e["id"],)).fetchone()[0]
        out.append({"id": e["id"], "name": e["name"], "type": e["type"], "rows": len(e["rows"]),
                    "columns": len(all_cols(e)), "steps": [e["type"], *(s["type"] for s in e["steps"])],
                    "cost_usd": cost or 0.0, "updated_at": e["updated_at"]})
    return out


def _in(n) -> str:
    return ",".join("?" * n)


def _answered(conn, input_hashes, question_hashes) -> set[str]:
    """The question hashes that have at least one ok answer for any of the inputs."""
    if not input_hashes or not question_hashes:
        return set()
    q = ("SELECT DISTINCT a.question_hash FROM answers a JOIN runs r ON r.id = a.run_id WHERE r.status = 'ok'"
         f" AND a.input_hash IN ({_in(len(input_hashes))}) AND a.question_hash IN ({_in(len(question_hashes))})")
    return {r[0] for r in conn.execute(q, [*input_hashes, *question_hashes])}


def update_experiment(conn, exp_id, body) -> list[str]:
    old = get_experiment(conn, exp_id)
    if old is None:
        raise ExpError(404, "experiment not found")
    body = body or {}
    answered = _answered(conn, [r["input_hash"] for r in old["rows"]], [c["question_hash"] for c in all_cols(old)])
    has = lambda cols: any(c["question_hash"] in answered for c in cols)  # noqa: E731
    if has(old["columns"]) and (body.get("type", old["type"]) != old["type"]
                                or body.get("criteria", old["criteria"]) != old["criteria"]):
        raise ExpError(409, "Type and criteria are fixed once answers exist. Duplicate the experiment to change them.")
    exp, warnings = _normalize(body, old)
    old_steps = {s["key"]: s for s in old["steps"]}
    for pos, s in enumerate(exp["steps"], start=2):
        os_ = old_steps.get(s["key"])
        if os_ and has(os_["columns"]) and (s["type"] != os_["type"] or s["criteria"] != os_["criteria"]):
            raise ExpError(409, f"Step {pos}: type and criteria are fixed once answers exist. "
                                "Duplicate the experiment to change them.")
    old_cols = {c["key"]: c for c in all_cols(old)}
    for c in all_cols(exp):
        oc = old_cols.get(c["key"])
        if oc and oc["instructions"] != c["instructions"] and oc["question_hash"] in answered:
            raise ExpError(409, f"Variant {c['key']} already has answers, so its wording can't change. "
                                "Add a new variant (Duplicate & edit) instead.")
    _save(conn, exp_id, exp)
    return warnings


def duplicate_experiment(conn, exp_id) -> int:
    e = get_experiment(conn, exp_id)
    if e is None:
        raise ExpError(404, "experiment not found")
    names = {r[0] for r in conn.execute("SELECT name FROM experiments")}
    n, name = 2, f"{e['name']} copy"
    while name in names:
        name, n = f"{e['name']} copy {n}", n + 1
    return _save(conn, None, {**e, "name": name}, created=True)


def delete_experiment(conn, exp_id) -> bool:
    with LOCK, conn:
        conn.execute("UPDATE runs SET experiment_id = NULL WHERE experiment_id = ?", (exp_id,))
        return conn.execute("DELETE FROM experiments WHERE id = ?", (exp_id,)).rowcount > 0


def totals(conn, session_start) -> dict:
    """Runs and cost since session_start and for all time. unknown = ok runs with no cost (no token count)."""
    def since(t):
        n, cost, unknown = conn.execute("SELECT count(*), sum(cost_usd), sum(cost_usd IS NULL AND status = 'ok')"
                                        " FROM runs WHERE created_at >= ?", (t,)).fetchone()
        return {"runs": n, "cost_usd": cost or 0.0, "unknown_cost_runs": unknown or 0}
    return {"session": since(session_start), "all_time": since("")}


def experiment_cells(conn, exp) -> dict:
    """Latest ok answer per (row, column, model), found by content hash. Shape: contracts/http-api.md."""
    by_input = {r["input_hash"]: r["key"] for r in exp["rows"]}
    by_q = {}  # hash -> column keys; a question repeated in two steps fills both cells from one answer
    for c in all_cols(exp):
        by_q.setdefault(c["question_hash"], []).append(c["key"])
    cells, models = {}, set()
    if by_input and by_q:
        q = ("SELECT a.input_hash, a.question_hash, a.model_used, a.answer, a.run_id FROM answers a"
             f" JOIN runs r ON r.id = a.run_id WHERE r.status = 'ok' AND a.input_hash IN ({_in(len(by_input))})"
             f" AND a.question_hash IN ({_in(len(by_q))}) ORDER BY a.created_at, a.run_id")
        for ih, qh, model, ans, run_id in conn.execute(q, [*by_input, *by_q]):  # later rows overwrite: latest wins
            for key in by_q[qh]:
                cells.setdefault(by_input[ih], {}).setdefault(key, {})[model] = {"answer": json.loads(ans), "run_id": run_id}
            models.add(model)
    run_ids = {c["run_id"] for row in cells.values() for col in row.values() for c in col.values()}
    run_costs = {}
    for rid in run_ids:
        r = conn.execute("SELECT cost_usd, input_tokens, questions FROM runs WHERE id = ?", (rid,)).fetchone()
        lens = {}
        for qid, qq in json.loads(r["questions"]).items():
            instr = qq.get("instructions")
            # ponytail: a question shared by two steps splits its run cost over both keys; per-step cost if anyone needs it exact
            for key in by_q.get(jev.question_hash(qq), ["_" + qid]):
                lens[key] = len(instr if isinstance(instr, str) else json.dumps(instr))
        run_costs[str(rid)] = {"cost_usd": r["cost_usd"], "input_tokens": r["input_tokens"], "questions": lens}
    c = conn.execute("SELECT count(*), sum(cost_usd), sum(cost_usd IS NULL AND status = 'ok') FROM runs"
                     " WHERE experiment_id = ?", (exp["id"],)).fetchone()
    return {"cells": cells, "run_costs": run_costs, "models": sorted(models, reverse=True),
            "cost": {"cost_usd": c[1] or 0.0, "runs": c[0], "unknown_cost_runs": c[2] or 0}}


def resolve_model(conn, model) -> str:
    """An alias (jev-latest) maps to the latest version it actually returned; a version maps to itself."""
    if model not in ("jev-latest", "jev-preview"):
        return model
    r = conn.execute("SELECT model_used FROM runs WHERE model_requested = ? AND status = 'ok' ORDER BY id DESC LIMIT 1",
                     (model,)).fetchone()
    return r[0] if r else model


def experiment_plan(conn, exp, model, price, step=None, rows=None) -> dict:
    """Missing cells of one step (step 1 when `step` is empty) for the given row keys (all rows when None).
    The browser decides which rows reach a step; the server never evaluates gates."""
    q = exp if not step else next((s for s in exp["steps"] if s["key"] == step), None)
    if q is None:
        raise ExpError(404, "step not found")
    resolved = resolve_model(conn, model)
    cells = experiment_cells(conn, exp)["cells"]
    visible = [c for c in q["columns"] if not c["hidden"]]
    keep = set(rows) if rows is not None else None
    requests, chars = [], 0
    for r in exp["rows"]:
        if keep is not None and r["key"] not in keep:
            continue
        missing = [c for c in visible if resolved not in cells.get(r["key"], {}).get(c["key"], {})]
        if missing:
            requests.append({"row": r["key"], "columns": [c["key"] for c in missing]})
            chars += len(json.dumps(jev.with_reference(r["input"], exp.get("reference")))) + len(json.dumps({c["key"]: _wire(q, c) for c in missing}))
    avg = conn.execute("SELECT avg(input_tokens) FROM runs WHERE experiment_id = ? AND status = 'ok'"
                       " AND input_tokens IS NOT NULL", (exp["id"],)).fetchone()[0]
    tokens = round(avg * len(requests)) if avg else -(-chars // 4)
    return {"model": model, "resolved_model": resolved, "requests": requests,
            "estimated_tokens": tokens, "estimated_cost_usd": tokens * price / 1e6}
