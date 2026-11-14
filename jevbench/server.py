"""Local HTTP server: static page + JSON API. Route handlers are plain functions for testability."""

import hashlib
import json
import mimetypes
import os
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from datetime import date
from pathlib import Path
from typing import NamedTuple
from urllib.parse import parse_qs, urlparse

from . import jev, library, store

STATIC = Path(__file__).parent / "static"
STATIC_MODELS = ["jev-latest", "jev-preview", "jev-1.14.0", "jev-1.13.0"]


class ApiError(Exception):
    def __init__(self, status: int, error: str, field: str | None = None, **extra):
        self.status, self.error, self.field, self.extra = status, error, field, extra


class Download(NamedTuple):
    """A handler result sent as a file instead of JSON."""
    data: bytes
    ctype: str
    filename: str


# ---------- handlers: fn(ctx, params, query, body) -> (status, obj) ----------

def h_status(ctx, params, query, body):
    if ctx.get("models") is None:
        models = list(STATIC_MODELS)
        if ctx.get("client"):
            try:  # best effort, once
                for m in ctx["client"].models.list().models:
                    if m.name not in models:
                        models.append(m.name)
            except Exception:
                pass
        ctx["models"] = models
    return 200, {"key_present": ctx.get("client") is not None, "key_hint": ctx.get("key_hint"),
                 "data_dir": str(ctx["data_dir"]), "key_file": str(ctx.get("env_file", ".env")),
                 "notice": ctx.get("notice"),
                 "server_started_at": ctx["started_at"], "models": ctx["models"]}


def h_get_prefs(ctx, params, query, body):
    return 200, store.get_prefs(ctx["conn"])


def h_put_prefs(ctx, params, query, body):
    return 200, store.put_prefs(ctx["conn"], body or {})


def h_reset_prefs(ctx, params, query, body):
    return 200, store.reset_prefs(ctx["conn"])


def h_post_run(ctx, params, query, body):
    body = body or {}
    inp = body.get("input") or {}
    if inp.get("kind", "text") not in ("text", "json"):
        raise ApiError(400, "input.kind must be text or json", "input.kind")
    if inp.get("kind") == "json" and not isinstance(inp.get("fields"), dict):
        raise ApiError(400, "fields must be a JSON object", "input.fields")
    inp = {"kind": "json", "fields": inp["fields"]} if inp.get("kind") == "json" else {"kind": "text", "text": str(inp.get("text", ""))}
    exp = body.get("experiment_id") and store.get_experiment(ctx["conn"], int(body["experiment_id"]))
    if exp:
        inp = jev.with_reference(inp, exp.get("reference"))
    model = body.get("model") or store.get_prefs(ctx["conn"])["default_model"]
    questions = body.get("questions")

    image_bytes = ext = image_sha = None
    if body.get("image_base64"):
        try:
            image_bytes, ext = jev.validate_image(body["image_base64"])
        except ValueError as e:
            raise ApiError(400, str(e), "image")
    errs = jev.validate_questions(questions, image_bytes is not None, model)
    if errs:
        raise ApiError(400, errs[0]["error"], errs[0]["field"], errors=errs)
    if ctx.get("client") is None:
        raise ApiError(503, "No TypeSafe API key. Set TYPESAFE_API_KEY in the project .env file, then restart.")

    if image_bytes is not None:
        image_sha = hashlib.sha256(image_bytes).hexdigest()
        path = Path(ctx["data_dir"]) / "images" / f"{image_sha}.{ext}"
        if not path.exists():
            path.write_bytes(image_bytes)

    result = jev.call_jev(ctx["client"], model, jev.build_state(inp, image_bytes), questions,
                          has_image=image_bytes is not None)
    price = store.get_prefs(ctx["conn"])["price_per_mtok"]
    run = {**result, "input": inp, "input_hash": jev.input_hash(inp, image_sha), "image_sha": image_sha,
           "questions": questions, "model_requested": model, "experiment_id": body.get("experiment_id"),
           "price_per_mtok": price,
           "cost_usd": jev.cost_usd(result["input_tokens"], price) if result["status"] == "ok" else None}
    run_id = store.insert_run(ctx["conn"], run)
    return 200, store.get_run(ctx["conn"], run_id)


def h_get_run(ctx, params, query, body):
    run = store.get_run(ctx["conn"], int(params[0]))
    if run is None:
        raise ApiError(404, "run not found")
    return 200, run


RUN_FILTERS = ("type", "model", "status", "tag", "experiment_id", "q", "from", "to", "ids")


def _filters(query) -> dict:
    return {k: query[k][0] for k in RUN_FILTERS if query.get(k) and query[k][0] != ""}


def h_list_runs(ctx, params, query, body):
    try:
        limit = int((query.get("limit") or [50])[0]); offset = int((query.get("offset") or [0])[0])
        return 200, store.list_runs(ctx["conn"], _filters(query), limit, offset)
    except ValueError:
        raise ApiError(400, "limit, offset, experiment_id and ids must be numbers")


def h_patch_run(ctx, params, query, body):
    run = store.patch_run(ctx["conn"], int(params[0]), body or {})
    if run is None:
        raise ApiError(404, "run not found")
    return 200, run


def h_delete_run(ctx, params, query, body):
    if not store.delete_run(ctx["conn"], int(params[0])):
        raise ApiError(404, "run not found")
    return 204, None


def h_export(ctx, params, query, body):
    fmt = (query.get("format") or ["csv"])[0]
    if fmt not in ("csv", "jsonl"):
        raise ApiError(400, "format must be csv or jsonl", "format")
    try:
        data = store.export_runs(ctx["conn"], _filters(query), fmt)
    except ValueError:
        raise ApiError(400, "experiment_id and ids must be numbers")
    ctype = "text/csv; charset=utf-8" if fmt == "csv" else "application/x-ndjson; charset=utf-8"
    return 200, Download(data, ctype, f"jevbench-{date.today().isoformat()}.{fmt}")


def _exp(ctx, exp_id):
    exp = store.get_experiment(ctx["conn"], int(exp_id))
    if exp is None:
        raise ApiError(404, "experiment not found")
    return exp


def _full(ctx, exp_id, warnings=()):
    exp = _exp(ctx, exp_id)
    return 200, {"experiment": exp, **store.experiment_cells(ctx["conn"], exp), "warnings": list(warnings)}


def _exp_call(fn, *args):
    try:
        return fn(*args)
    except store.ExpError as e:
        raise ApiError(e.status, e.error, None, **({"rows": e.rows} if e.rows else {}))


def h_list_exps(ctx, params, query, body):
    return 200, store.list_experiments(ctx["conn"])


def h_create_exp(ctx, params, query, body):
    exp_id, warnings = _exp_call(store.create_experiment, ctx["conn"], body)
    return _full(ctx, exp_id, warnings)


def h_exp_from_runs(ctx, params, query, body):
    body = body or {}
    filters = {k: v for k, v in (body.get("filter") or {}).items() if k in RUN_FILTERS and v not in ("", None)}
    try:
        exp_id, warnings, skipped = _exp_call(store.experiment_from_runs, ctx["conn"], str(body.get("name") or "").strip(),
                                              body.get("type"), body.get("run_ids"), filters)
    except (ValueError, TypeError):
        raise ApiError(400, "run_ids and experiment_id must be numbers")
    st, out = _full(ctx, exp_id, warnings)
    return st, {**out, "skipped": skipped}


def h_get_exp(ctx, params, query, body):
    return _full(ctx, params[0])


def h_put_exp(ctx, params, query, body):
    _exp(ctx, params[0])
    warnings = _exp_call(store.update_experiment, ctx["conn"], int(params[0]), body)
    return _full(ctx, params[0], warnings)


def h_delete_exp(ctx, params, query, body):
    if not store.delete_experiment(ctx["conn"], int(params[0])):
        raise ApiError(404, "experiment not found")
    return 204, None


def h_dup_exp(ctx, params, query, body):
    return _full(ctx, _exp_call(store.duplicate_experiment, ctx["conn"], int(params[0])))


def h_plan_exp(ctx, params, query, body):
    model = (query.get("model") or [None])[0] or store.get_prefs(ctx["conn"])["default_model"]
    price = store.get_prefs(ctx["conn"])["price_per_mtok"]
    return 200, store.experiment_plan(ctx["conn"], _exp(ctx, params[0]), model, price)


def h_lib_list(ctx, params, query, body):
    return 200, library.list_files(ctx["data_dir"], params[0])


def h_lib_file(ctx, params, query, body):
    try:
        return 200, library.analyze(ctx["data_dir"], params[0], (query.get("path") or [""])[0])
    except ValueError as e:
        raise ApiError(400, str(e), "path")
    except FileNotFoundError:
        raise ApiError(404, "file not found", "path")
    except OSError as e:
        raise ApiError(500, f"cannot read the file: {e}", "path")


def h_lib_reveal(ctx, params, query, body):
    try:
        return 200, library.reveal(ctx["data_dir"], params[0])
    except OSError as e:
        raise ApiError(500, f"could not open the folder: {e}")


ROUTES = [
    ("GET", r"/api/status", h_status),
    ("GET", r"/api/library/(inputs|questions)", h_lib_list),
    ("GET", r"/api/library/(inputs|questions)/file", h_lib_file),
    ("POST", r"/api/library/(inputs|questions)/reveal", h_lib_reveal),
    ("GET", r"/api/prefs", h_get_prefs),
    ("PUT", r"/api/prefs", h_put_prefs),
    ("POST", r"/api/prefs/reset", h_reset_prefs),
    ("GET", r"/api/totals", lambda ctx, p, q, b: (200, store.totals(ctx["conn"], ctx["started_at"]))),
    ("POST", r"/api/runs", h_post_run),
    ("GET", r"/api/runs", h_list_runs),
    ("GET", r"/api/runs/(\d+)", h_get_run),
    ("PATCH", r"/api/runs/(\d+)", h_patch_run),
    ("DELETE", r"/api/runs/(\d+)", h_delete_run),
    ("GET", r"/api/export", h_export),
    ("GET", r"/api/experiments", h_list_exps),
    ("POST", r"/api/experiments", h_create_exp),
    ("POST", r"/api/experiments/from-runs", h_exp_from_runs),
    ("GET", r"/api/experiments/(\d+)", h_get_exp),
    ("PUT", r"/api/experiments/(\d+)", h_put_exp),
    ("DELETE", r"/api/experiments/(\d+)", h_delete_exp),
    ("POST", r"/api/experiments/(\d+)/duplicate", h_dup_exp),
    ("GET", r"/api/experiments/(\d+)/plan", h_plan_exp),
]
ROUTES = [(m, re.compile(p + r"$"), fn) for m, p, fn in ROUTES]


def dispatch(ctx, method, path, query, body):
    """Return (status, obj). Raises nothing; errors become {"error", "field"} bodies."""
    for m, rx, fn in ROUTES:
        match = rx.match(path)
        if match and m == method:
            try:
                return fn(ctx, match.groups(), query, body)
            except ApiError as e:
                return e.status, {"error": e.error, "field": e.field, **e.extra}
    return 404, {"error": f"no route for {method} {path}", "field": None}


# ---------- HTTP plumbing ----------

def make_handler(ctx):
    class Handler(BaseHTTPRequestHandler):
        server_version = "jevbench"

        def log_message(self, fmt, *args):  # keep the terminal quiet
            pass

        def _send(self, status, data: bytes, ctype, headers=None):
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if status != 204:
                self.wfile.write(data)

        def send_json(self, status, obj):
            data = b"" if status == 204 else json.dumps(obj, ensure_ascii=False).encode()
            self._send(status, data, "application/json; charset=utf-8")

        def _file(self, base: Path, name: str):
            p = (base / name).resolve()
            if base.resolve() not in p.parents or not p.is_file():
                return self.send_json(404, {"error": "not found", "field": None})
            ctype = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
            if p.suffix == ".js":
                ctype = "text/javascript"
            self._send(200, p.read_bytes(), ctype + ("; charset=utf-8" if ctype.startswith("text/") else ""))

        def _handle(self, method):
            url = urlparse(self.path)
            path = url.path
            if method == "GET" and path == "/":
                return self._file(STATIC, "index.html")
            if method == "GET" and path.startswith("/static/"):
                return self._file(STATIC, path[len("/static/"):])
            if method == "GET" and path.startswith("/api/images/"):
                sha = path.rsplit("/", 1)[1]
                if re.fullmatch(r"[0-9a-f]{64}", sha):
                    for ext in ("png", "jpg"):
                        if (Path(ctx["data_dir"]) / "images" / f"{sha}.{ext}").exists():
                            return self._file(Path(ctx["data_dir"]) / "images", f"{sha}.{ext}")
                return self.send_json(404, {"error": "image not found", "field": None})
            body = None
            length = int(self.headers.get("Content-Length") or 0)
            if length:
                try:
                    body = json.loads(self.rfile.read(length))
                except json.JSONDecodeError:
                    return self.send_json(400, {"error": "body is not valid JSON", "field": None})
            status, obj = dispatch(ctx, method, path, parse_qs(url.query), body)
            if isinstance(obj, Download):
                return self._send(status, obj.data, obj.ctype,
                                  {"Content-Disposition": f'attachment; filename="{obj.filename}"'})
            self.send_json(status, obj)

        def do_GET(self):
            self._handle("GET")

        def do_POST(self):
            self._handle("POST")

        def do_PUT(self):
            self._handle("PUT")

        def do_PATCH(self):
            self._handle("PATCH")

        def do_DELETE(self):
            self._handle("DELETE")

    return Handler


class Server(ThreadingHTTPServer):
    daemon_threads = True
    # On Windows SO_REUSEADDR lets two servers share a port silently; we want "port in use" instead.
    allow_reuse_address = os.name != "nt"


def make_server(ctx, port: int) -> ThreadingHTTPServer:
    return Server(("127.0.0.1", port), make_handler(ctx))
