"""Jev wrapper: hashing, validation, state building, the call itself, cost.

Confirmed against typesafe-sdk 0.7.5 (T004):
  TypeSafeClient(api_key=, transport=, retry=RetryPolicy(max_retries=...))
  client.system_one(state=, questions={id: {"type", "instructions", "criteria"}}, model=)
    - plain dict questions are accepted; Image objects may sit anywhere in state
  response.model, response.usage.input_tokens (may be None), response.answers[id].model_dump(mode="json")
  response.request_id  -> raises TypeSafeError when header x-typesafe-request-id is absent
  Image.from_base64(str)
  Errors: TypeSafeAPIError(.status, .body) > TypeSafeAuthenticationError, TypeSafeBadRequestError,
          TypeSafeUnprocessableEntityError, TypeSafeRateLimitError, ...;
          TypeSafeAPIConnectionError, TypeSafeAPITimeoutError; base TypeSafeError.
  SDK retries 429/529/connection errors itself (default max_retries=2).
"""

import base64
import hashlib
import json
import re
import struct
import time

import typesafe_sdk as ts

TYPES = ("noul", "choice", "score", "box")
ID_RE = re.compile(r"^[A-Za-z0-9_\-]{1,64}$")
MAX_IMAGE = 16 * 1024 * 1024  # docs.typesafe.ai/images: 16 MiB per file, each side 280-1568 px
MIN_SIDE, MAX_SIDE = 280, 1568


def canon_hash(obj) -> str:
    raw = json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def input_hash(inp: dict, image_sha: str | None) -> str:
    if inp.get("kind") == "json":
        key = {"kind": "json", "fields": inp.get("fields")}
    else:
        key = {"kind": "text", "text": inp.get("text", "")}
    key["image_sha"] = image_sha
    return canon_hash(key)


def with_reference(inp: dict, reference: str | None) -> dict:
    """An experiment's shared reference rides along in state as `reference` (a row's own field wins)."""
    if not reference:
        return inp
    fields = inp["fields"] if inp.get("kind") == "json" else {"text": inp.get("text", "")}
    return {"kind": "json", "fields": {"reference": reference, **fields}}


def question_hash(q: dict) -> str:
    return canon_hash({"type": q.get("type"), "instructions": q.get("instructions"), "criteria": q.get("criteria")})


def validate_questions(questions, has_image: bool, model: str) -> list[dict]:
    errs = []
    if not isinstance(questions, dict) or not questions:
        return [{"field": "questions", "error": "add at least one question"}]
    for qid, q in questions.items():
        f = f"questions.{qid}"
        if not ID_RE.match(str(qid)):
            errs.append({"field": f, "error": "id must be 1-64 letters, digits, _ or -"})
        if not isinstance(q, dict) or q.get("type") not in TYPES:
            errs.append({"field": f + ".type", "error": "type must be noul, choice, score or box"})
            continue
        instr = q.get("instructions")
        if not instr or (isinstance(instr, str) and not instr.strip()):
            errs.append({"field": f + ".instructions", "error": "write the question"})
        t, c = q["type"], q.get("criteria")
        if t == "choice" and not (isinstance(c, dict) and len(c) >= 2):
            errs.append({"field": f + ".criteria", "error": "a Choice needs at least 2 options"})
        level_ok = lambda x: bool(x) if isinstance(x, dict) else bool(str(x).strip())  # text, or a non-empty object
        if t == "score" and not (isinstance(c, list) and len(c) >= 2 and all(level_ok(x) for x in c)):
            errs.append({"field": f + ".criteria", "error": "a Score needs at least 2 non-empty levels"})
        if t == "noul" and c is not None and not (
                isinstance(c, dict) and c and set(c) <= {"true", "false"}
                and all(isinstance(v, str) and v.strip() for v in c.values())):
            errs.append({"field": f + ".criteria", "error": "Noul criteria must be {true: text, false: text} (either optional)"})
        if t == "box":
            if not has_image:
                errs.append({"field": f, "error": "Box needs an image"})
            if str(model).startswith("jev-1.13"):
                errs.append({"field": f, "error": "Box needs Jev 1.14 or later"})
    return errs


def validate_image(b64: str):
    """Return (bytes, ext) or raise ValueError with a user-readable message."""
    try:
        data = base64.b64decode(b64, validate=True)
    except Exception:
        raise ValueError("image is not valid base64")
    if len(data) > MAX_IMAGE:
        raise ValueError("image is larger than 16 MiB")
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        ext = "png"
    elif data.startswith(b"\xff\xd8\xff"):
        ext = "jpg"
    else:
        raise ValueError("image must be PNG or JPEG")
    size = image_size(data, ext)
    if size is None:
        raise ValueError("cannot read the image size; the file may be damaged")
    w, h = size
    if not (MIN_SIDE <= w <= MAX_SIDE and MIN_SIDE <= h <= MAX_SIDE):
        raise ValueError(f"image is {w} x {h} px; Jev needs each side between {MIN_SIDE} and {MAX_SIDE} px")
    return data, ext


def image_size(data: bytes, ext: str):
    """(width, height) from the PNG IHDR or the first JPEG frame header, or None."""
    if ext == "png":
        return struct.unpack(">II", data[16:24]) if data[12:16] == b"IHDR" else None
    i = 2
    while i + 9 <= len(data):
        if data[i] != 0xFF:
            return None
        m = data[i + 1]
        if m == 0xFF:  # fill byte
            i += 1
        elif 0xC0 <= m <= 0xCF and m not in (0xC4, 0xC8, 0xCC):  # SOFn: length, precision, height, width
            h, w = struct.unpack(">HH", data[i + 5:i + 9])
            return w, h
        elif m == 0x01 or 0xD0 <= m <= 0xD9:  # markers without a length
            i += 2
        else:
            i += 2 + struct.unpack(">H", data[i + 2:i + 4])[0]
    return None


def build_state(inp: dict, image_bytes: bytes | None):
    state = dict(inp.get("fields") or {}) if inp.get("kind") == "json" else {"text": inp.get("text", "")}
    if image_bytes is not None:
        state["image"] = ts.Image(image_bytes)
    return state


def _error_message(e: Exception) -> str:
    if isinstance(e, ts.TypeSafeAuthenticationError):
        return "API key rejected (401). Check TYPESAFE_API_KEY."
    if isinstance(e, ts.TypeSafeBadRequestError) and "max_tokens_exceeded" in str(e.body):
        return "Input is too long for the model's context (max_tokens_exceeded)."
    if isinstance(e, ts.TypeSafeAPITimeoutError):
        return "Request timed out after retries."
    if isinstance(e, ts.TypeSafeAPIConnectionError):
        return "Network error: cannot reach TypeSafe (after retries)."
    if isinstance(e, ts.TypeSafeRateLimitError):
        return "Rate limited by TypeSafe (429) after retries. Try again shortly."
    return str(e)


# The API rejects images unless the request opts in (400 "Images are experimental").
IMAGE_HEADERS = {"TypeSafe-Danger-Zone-Images": "true"}


def call_jev(client, model: str, state, questions: dict, has_image: bool = False) -> dict:
    t0 = time.perf_counter()
    out = {"status": "ok", "model_used": None, "answers": None, "input_tokens": None, "request_id": None, "error": None}
    try:
        r = client.system_one(state=state, questions=questions, model=model,
                              extra_headers=IMAGE_HEADERS if has_image else None)
        out["model_used"] = r.model
        out["answers"] = {k: v.model_dump(mode="json") for k, v in r.answers.items()}
        out["input_tokens"] = r.usage.input_tokens if r.usage else None
        try:
            out["request_id"] = r.request_id
        except ts.TypeSafeError:
            pass
    except ts.TypeSafeError as e:
        out.update(status="error", error=_error_message(e))
        out["request_id"] = getattr(e, "request_id", None)
    out["duration_ms"] = int((time.perf_counter() - t0) * 1000)
    return out


def cost_usd(tokens, price_per_mtok: float):
    return None if tokens is None else tokens * price_per_mtok / 1_000_000
