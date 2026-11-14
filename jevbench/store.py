"""SQLite storage: runs, answers, experiments, prefs."""

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
    conn = sqlite3.connect(path, check_same_thread=False)
    try:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(SCHEMA)
        if "reference" not in {r[1] for r in conn.execute("PRAGMA table_info(experiments)")}:  # pre-reference DBs
            conn.execute("ALTER TABLE experiments ADD COLUMN reference TEXT")
        conn.execute("SELECT count(*) FROM runs").fetchone()
        return conn
    except sqlite3.DatabaseError:
        conn.close()  # Windows keeps the file locked otherwise, and the rename would fail
        raise


def open_db(data_dir) -> tuple[sqlite3.Connection, str | None]:
    data_dir = Path(data_dir)
    (data_dir / "images").mkdir(parents=True, exist_ok=True)
    path = data_dir / "jevbench.db"
    try:
        return _connect(path), None
    except sqlite3.DatabaseError as e:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        broken = path.with_name(f"jevbench.db.broken-{stamp}")
        for suffix in ("", "-wal", "-shm"):
            p = Path(str(path) + suffix)
            if p.exists():
                os.replace(p, Path(str(broken) + suffix))
        notice = f"The data file could not be read ({e}). It was moved to {broken.name} and a fresh one was started."
        return _connect(path), notice


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


# ---------- experiments ----------

EXP_TYPES = ("noul", "choice", "score")
DEFAULT_VIEW = {"threshold": {"low": 0.5, "high": 0.8}, "focus_option": None,
                "sort": {"by": "input", "dir": "asc"},
                "filters": {"labeled": None, "misclassified": False, "review_only": False,
                            "spread_min": None, "tags": [], "text": ""},
                "pivot": False, "overlay": "value", "model": None, "weights_override": None}


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


def _normalize(body: dict, old: dict | None = None) -> tuple[dict, list[str]]:
    """Validate and fill keys/hashes. Returns (experiment fields, warnings). Raises ExpError(400)."""
    old = old or {}
    t = body.get("type", old.get("type"))
    if t not in EXP_TYPES:
        raise ExpError(400, "type must be noul, choice or score")
    name = str(body.get("name", old.get("name", ""))).strip()
    if not name:
        raise ExpError(400, "give the experiment a name")
    criteria = body["criteria"] if "criteria" in body else old.get("criteria")
    probe = {"type": t, "instructions": "x"}
    if criteria is not None:
        probe["criteria"] = criteria
    errs = jev.validate_questions({"x": probe}, False, "jev-latest")
    if errs:
        raise ExpError(400, errs[0]["error"])
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
    cols, qseen = [], set()
    for i, c in enumerate(body.get("columns", old.get("columns", []))):
        instr = c.get("instructions")
        if not instr or (isinstance(instr, str) and not instr.strip()):
            raise ExpError(400, f"variant {i + 1} has no wording")
        col = {"key": c.get("key"), "instructions": instr, "weight": float(c.get("weight", 1)),
               "threshold": c.get("threshold"), "hidden": bool(c.get("hidden", False))}
        col["question_hash"] = jev.question_hash(_wire(exp, col))
        if col["question_hash"] in qseen:
            warnings.append(f"variant {i + 1} repeats an earlier wording and was merged")
            continue
        qseen.add(col["question_hash"])
        cols.append(col)
    for items, prefix in ((rows, "r"), (cols, "c")):
        for it in items:
            if not it["key"]:
                it["key"] = _next_key(items, prefix)
    exp.update(rows=rows, columns=cols,
               view={**DEFAULT_VIEW, **(body.get("view") or old.get("view") or {})},
               views=body.get("views", old.get("views", {})))
    return exp, warnings


def _exp_dict(row) -> dict:
    d = dict(row)
    for k in ("criteria", "rows", "columns", "view", "views"):
        d[k] = json.loads(d[k]) if d[k] is not None else None
    return d


def _save(conn, exp_id, exp, created=False) -> int:
    vals = (exp["name"], exp["type"], json.dumps(exp["criteria"]), exp.get("reference"), json.dumps(exp["rows"]),
            json.dumps(exp["columns"]), json.dumps(exp["view"]), json.dumps(exp["views"]))
    try:
        with LOCK, conn:
            if created:
                t = now()
                return conn.execute("INSERT INTO experiments(name, type, criteria, reference, rows, columns, view, views,"
                                    " created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)", vals + (t, t)).lastrowid
            conn.execute("UPDATE experiments SET name=?, type=?, criteria=?, reference=?, rows=?, columns=?, view=?, views=?,"
                         " updated_at=? WHERE id=?", vals + (now(), exp_id))
            return exp_id
    except sqlite3.IntegrityError:
        raise ExpError(409, f"an experiment named {exp['name']!r} already exists")


def create_experiment(conn, body) -> tuple[int, list[str]]:
    exp, warnings = _normalize(body or {})
    return _save(conn, None, exp, created=True), warnings


def get_experiment(conn, exp_id) -> dict | None:
    row = conn.execute("SELECT * FROM experiments WHERE id = ?", (exp_id,)).fetchone()
    return _exp_dict(row) if row else None


def list_experiments(conn) -> list[dict]:
    out = []
    for row in conn.execute("SELECT * FROM experiments ORDER BY updated_at DESC"):
        e = _exp_dict(row)
        cost = conn.execute("SELECT sum(cost_usd) FROM runs WHERE experiment_id = ?", (e["id"],)).fetchone()[0]
        out.append({"id": e["id"], "name": e["name"], "type": e["type"], "rows": len(e["rows"]),
                    "columns": len(e["columns"]), "cost_usd": cost or 0.0, "updated_at": e["updated_at"]})
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
    answered = _answered(conn, [r["input_hash"] for r in old["rows"]], [c["question_hash"] for c in old["columns"]])
    if answered and (body.get("type", old["type"]) != old["type"] or body.get("criteria", old["criteria"]) != old["criteria"]):
        raise ExpError(409, "Type and criteria are fixed once answers exist. Duplicate the experiment to change them.")
    exp, warnings = _normalize(body, old)
    old_cols = {c["key"]: c for c in old["columns"]}
    for c in exp["columns"]:
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


def experiment_cells(conn, exp) -> dict:
    """Latest ok answer per (row, column, model), found by content hash. Shape: contracts/http-api.md."""
    by_input = {r["input_hash"]: r["key"] for r in exp["rows"]}
    by_q = {c["question_hash"]: c["key"] for c in exp["columns"]}
    cells, models = {}, set()
    if by_input and by_q:
        q = ("SELECT a.input_hash, a.question_hash, a.model_used, a.answer, a.run_id FROM answers a"
             f" JOIN runs r ON r.id = a.run_id WHERE r.status = 'ok' AND a.input_hash IN ({_in(len(by_input))})"
             f" AND a.question_hash IN ({_in(len(by_q))}) ORDER BY a.created_at, a.run_id")
        for ih, qh, model, ans, run_id in conn.execute(q, [*by_input, *by_q]):  # later rows overwrite: latest wins
            cells.setdefault(by_input[ih], {}).setdefault(by_q[qh], {})[model] = {"answer": json.loads(ans), "run_id": run_id}
            models.add(model)
    run_ids = {c["run_id"] for row in cells.values() for col in row.values() for c in col.values()}
    run_costs = {}
    for rid in run_ids:
        r = conn.execute("SELECT cost_usd, input_tokens, questions FROM runs WHERE id = ?", (rid,)).fetchone()
        lens = {}
        for qid, qq in json.loads(r["questions"]).items():
            instr = qq.get("instructions")
            lens[by_q.get(jev.question_hash(qq), "_" + qid)] = len(instr if isinstance(instr, str) else json.dumps(instr))
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


def experiment_plan(conn, exp, model, price) -> dict:
    resolved = resolve_model(conn, model)
    cells = experiment_cells(conn, exp)["cells"]
    visible = [c for c in exp["columns"] if not c["hidden"]]
    requests, chars = [], 0
    for r in exp["rows"]:
        missing = [c for c in visible if resolved not in cells.get(r["key"], {}).get(c["key"], {})]
        if missing:
            requests.append({"row": r["key"], "columns": [c["key"] for c in missing]})
            chars += len(json.dumps(jev.with_reference(r["input"], exp.get("reference")))) +len(json.dumps({c["key"]: _wire(exp, c) for c in missing}))
    avg = conn.execute("SELECT avg(input_tokens) FROM runs WHERE experiment_id = ? AND status = 'ok'"
                       " AND input_tokens IS NOT NULL", (exp["id"],)).fetchone()[0]
    tokens = round(avg * len(requests)) if avg else -(-chars // 4)
    return {"model": model, "resolved_model": resolved, "requests": requests,
            "estimated_tokens": tokens, "estimated_cost_usd": tokens * price / 1e6}
