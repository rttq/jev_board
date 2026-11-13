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
