"""Read-only JSON library: listing, path containment, strict parsing, analysis.

Files live in <data_dir>/json/inputs (an object, or a list of objects) and <data_dir>/json/questions
({id: {type, instructions, criteria?}}). Nothing here ever writes, renames or deletes a library file.
"""

import json
import os
import re
import subprocess
import sys
from datetime import datetime
from decimal import Decimal
from pathlib import Path, PureWindowsPath

from . import jev

KINDS = ("inputs", "questions")
MAX_BYTES = 1_048_576
BIG_INT = 2 ** 53  # beyond this a browser (JS number) rounds the value
BOMS = ((b"\xff\xfe\x00\x00", "UTF-32"), (b"\x00\x00\xfe\xff", "UTF-32"), (b"\xff\xfe", "UTF-16"), (b"\xfe\xff", "UTF-16"))
BOX_NOTE = "needs an image in the Run view; skipped in experiments"
QUESTION_SHAPE = '{"my_id": {"type": "noul", "instructions": "…"}}'


class LibraryError(Exception):
    """A file that cannot be loaded. line/col point at syntax errors."""

    def __init__(self, message, line=None, col=None):
        super().__init__(message)
        self.message, self.line, self.col = message, line, col


# ---------- folders and paths ----------

def root(data_dir, kind) -> Path:
    if kind not in KINDS:
        raise ValueError(f"unknown library kind {kind!r}")
    base = Path(data_dir) / "json"
    for k in KINDS:
        (base / k).mkdir(parents=True, exist_ok=True)
    return base / kind


def _inside(p: Path, r: Path) -> bool:
    try:
        return p.resolve().is_relative_to(r.resolve())
    except OSError:
        return False


def resolve(data_dir, kind, rel) -> Path:
    """Library-relative path -> absolute file. ValueError if it escapes the folder, FileNotFoundError if absent."""
    r = root(data_dir, kind)
    rel = str(rel or "").strip()
    bad = ValueError("path must stay inside the library folder")
    if (not rel or rel.startswith(("/", "\\")) or Path(rel).is_absolute() or PureWindowsPath(rel).drive
            or not rel.lower().endswith(".json") or not _inside(r / rel, r)):
        raise bad
    p = (r / rel).resolve()
    if not p.is_file():
        raise FileNotFoundError(rel)
    return p


def _mtime(st) -> str:
    return datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds")


def list_files(data_dir, kind) -> dict:
    r = root(data_dir, kind)
    rr = r.resolve()
    files = []
    for p in r.rglob("*"):
        if p.suffix.lower() != ".json":
            continue
        try:
            if not p.is_file() or not p.resolve().is_relative_to(rr):  # links pointing out are left out
                continue
            st = p.stat()
        except OSError:
            continue
        files.append({"path": p.relative_to(r).as_posix(), "size": st.st_size, "mtime": _mtime(st),
                      "too_large": st.st_size > MAX_BYTES})
    files.sort(key=lambda f: f["path"].lower())
    return {"kind": kind, "folder": str(rr), "files": files}


def reveal(data_dir, kind) -> dict:
    p = root(data_dir, kind).resolve()
    if sys.platform == "win32":
        os.startfile(p)  # noqa: S606 - fixed library folder, never user-chosen
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(p)])
    else:
        subprocess.Popen(["xdg-open", str(p)])
    return {"folder": str(p)}


# ---------- strict parsing ----------

_CONST = re.compile(r'"(?:[^"\\]|\\.)*"|(-?Infinity|NaN)')


def _line_col(text: str, idx: int):
    line = text.count("\n", 0, idx) + 1
    return line, idx - (text.rfind("\n", 0, idx) + 1) + 1


class _Constant(Exception):
    pass


def load_strict(data: bytes):
    """bytes -> (value, warnings). Raises LibraryError with a plain message (and line/col when known)."""
    for bom, name in BOMS:
        if data.startswith(bom):
            raise LibraryError(f"file is saved as {name}; save it as UTF-8")
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError as e:
        raise LibraryError(f"file is not UTF-8 (first bad byte at position {e.start})")
    if not text.strip():
        raise LibraryError("file is empty")
    dups, big = [], []

    def pairs(kv):
        d = {}
        for k, v in kv:
            if k in d and k not in dups:
                dups.append(k)
            d[k] = v
        return d

    def as_int(s):
        v = int(s)
        if abs(v) > BIG_INT:
            big.append(v)
        return v

    def no_constant(s):
        raise _Constant(s)

    try:
        value = json.loads(text, object_pairs_hook=pairs, parse_int=as_int, parse_constant=no_constant)
    except json.JSONDecodeError as e:
        raise LibraryError(e.msg, e.lineno, e.colno)
    except _Constant:
        m = next((m for m in _CONST.finditer(text) if m.group(1)), None)
        line, col = _line_col(text, m.start(1)) if m else (None, None)
        raise LibraryError("NaN/Infinity is not valid JSON", line, col)
    except RecursionError:
        raise LibraryError("nested too deeply to read")
    warnings = [f"key `{k}` appears twice in one object; the last value is used" for k in dups]
    if big:
        shown = ", ".join(f"{v} becomes {_js_number(v)}" for v in big[:5])
        more = f" and {len(big) - 5} more" if len(big) > 5 else ""
        warnings.append(f"integers beyond 2^53 are rounded when shown or sent: {shown}{more}")
    return value, warnings


def _js_number(v: int) -> str:
    """How a browser prints int v after it becomes a double (no exponent below 1e21, like JS)."""
    r = repr(float(v))
    return format(Decimal(r), "f") if abs(float(v)) < 1e21 else r


# ---------- analysis ----------

def _tname(v) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, (int, float)):
        return "number"
    if isinstance(v, str):
        return "text"
    return "list" if isinstance(v, list) else "object"


def _a(t: str) -> str:
    return t if t == "null" else ("an " if t[0] in "aeiou" else "a ") + t


def _itemtype(lst):
    types = {_tname(x) for x in lst}
    return None if not types else types.pop() if len(types) == 1 else "mixed"


def _walk(records):
    """Field tree over all records -> (descriptors in parent-before-child order, max depth)."""
    tree, depth = {}, 1

    def visit(v, path, level, siblings, seen):
        nonlocal depth
        t = _tname(v)
        if path not in siblings:
            siblings[path] = ({"path": path, "type": t, "count": 0, "_types": set()}, {})
        desc, kids = siblings[path]
        desc["_types"].add(t)
        if t not in ("object", "list") and "sample" not in desc:
            desc["sample"] = v
        if t == "list" and "items" not in desc:
            desc["items"] = {"n": len(v), "type": _itemtype(v)}
        if path not in seen:
            seen.add(path)
            desc["count"] += 1
        depth = max(depth, level + (t in ("object", "list")))
        if t == "object":
            for k, x in v.items():
                visit(x, f"{path}.{k}", level + 1, kids, seen)
        elif t == "list":
            for x in v:
                if isinstance(x, dict):
                    depth = max(depth, level + 2)
                    for k, y in x.items():
                        visit(y, f"{path}[].{k}", level + 2, kids, seen)
                elif isinstance(x, list):
                    visit(x, f"{path}[]", level + 1, kids, seen)

    for rec in records:
        seen = set()
        for k, x in rec.items():
            visit(x, k, 1, tree, seen)

    out = []

    def flat(nodes):
        for desc, kids in nodes.values():
            types = desc.pop("_types")
            if len(types) > 1:
                desc["type"], desc["types"] = "mixed", sorted(types)
            out.append(desc)
            flat(kids)

    flat(tree)
    return out, depth


def _inputs(value):
    if isinstance(value, dict):
        shape, records = "object", [value]
    elif isinstance(value, list):
        if not value:
            raise LibraryError("the file holds no records")
        for i, it in enumerate(value, 1):
            if not isinstance(it, dict):
                raise LibraryError(f"item {i} is {_a(_tname(it))}; every item must be an object")
        shape, records = "list", value
    else:
        raise LibraryError(f"top level is {_a(_tname(value))}; expected an object or a list of objects")
    warnings = []
    empty = [i for i, r in enumerate(records, 1) if not r]
    if empty:
        nums = ", ".join(map(str, empty[:5])) + (" …" if len(empty) > 5 else "")
        warnings.append(f"record {nums} has no fields" if len(empty) == 1 else f"records {nums} have no fields")
    if shape == "object" and value and all(isinstance(v, dict) and "type" in v and "instructions" in v
                                           for v in value.values()):
        warnings.append("looks like a question file; move it to questions/")
    fields, depth = _walk(records)
    return {"shape": shape, "records": records, "fields": fields, "depth": depth}, warnings


def _questions(value):
    if not isinstance(value, dict):
        raise LibraryError(f"top level is {_a(_tname(value))}; a question file maps IDs to questions, e.g. {QUESTION_SHAPE}")
    if not value:
        raise LibraryError("the file holds no questions")
    if "type" in value and "instructions" in value:
        raise LibraryError(f"this looks like one question without an ID; wrap it like {QUESTION_SHAPE}")
    out = {}
    for qid, q in value.items():
        if not isinstance(q, dict):
            raise LibraryError(f"question `{qid}` is {_a(_tname(q))}; each question is an object with type and instructions")
        if "type" not in q:
            raise LibraryError(f"question `{qid}` has no type (noul, choice, score or box)")
        if q["type"] not in jev.TYPES:
            raise LibraryError(f"question `{qid}` has type {q['type']!r}; use noul, choice, score or box")
        if "instructions" not in q:
            raise LibraryError(f"question `{qid}` has no instructions")
        errs = [e["error"] for e in jev.validate_questions({qid: q}, True, "jev-latest")]
        out[qid] = {"wire": q, "valid": not errs, "errors": errs, "notes": [BOX_NOTE] if q["type"] == "box" else []}
    return out, []


def analyze(data_dir, kind, rel) -> dict:
    p = resolve(data_dir, kind, rel)
    st = p.stat()
    out = {"path": p.relative_to(root(data_dir, kind).resolve()).as_posix(), "kind": kind, "size": st.st_size,
           "mtime": _mtime(st), "ok": False, "error": None, "warnings": [], "pretty": None}

    def fail(message, line=None, col=None):
        out["error"] = {"message": message, "line": line, "col": col}
        return out

    if st.st_size > MAX_BYTES:
        return fail(f"file is {st.st_size / MAX_BYTES:.2f} MB; the limit is 1 MB")
    data = p.read_bytes()
    try:
        value, warnings = load_strict(data)
        part, more = (_inputs if kind == "inputs" else _questions)(value)
        pretty = json.dumps(value, indent=2, ensure_ascii=False)
        pretty.encode("utf-8")  # an escaped lone surrogate (\ud800) parses but cannot be sent anywhere
    except LibraryError as e:
        try:  # show the text as it is, so line/column can be found (FR-028)
            out["pretty"] = data.decode("utf-8-sig")
        except UnicodeDecodeError:
            pass
        return fail(e.message, e.line, e.col)
    except RecursionError:
        return fail("nested too deeply to read")
    except UnicodeEncodeError:
        return fail("text contains an escaped lone surrogate (like \\ud800), which is not a valid character")
    out.update(ok=True, warnings=warnings + more, pretty=pretty)
    out[kind] = part
    return out
