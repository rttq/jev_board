"""Core checks: hashing, validation, cost, storage, run flow. No API key needed (except LiveSmoke, opt-in).

Run: uv run python -m unittest discover -s tests
Live: JEVBENCH_LIVE=1 and TYPESAFE_API_KEY (env or project .env) uv run python -m unittest tests.test_core.LiveSmoke
"""

import base64
import json
import os
import re
import sqlite3
import tempfile
import unittest
from pathlib import Path

import httpx2
import typesafe_sdk as ts

from jevbench import jev, server, store
from jevbench.__main__ import load_env

load_env()  # project .env feeds LiveSmoke

# Canned answers shaped exactly like the API's (LiveSmoke checks the key sets against the real thing).
CANNED = {
    "noul": {"type": "noul", "noul": 0.93},
    "choice": {"type": "choice", "choice": "apple", "probabilities": {"apple": 0.91, "pear": 0.06, "tomato": 0.03}, "confidence": 0.87},
    "score": {"type": "score", "score": 1.43, "confidence": 0.35, "legend": {"0": "a", "1": "b", "2": "c"},
              "probabilities": {"0": 0.0, "1": 0.57, "2": 0.43}},
    "box": {"type": "box", "box": {"top": 0.25, "bottom": 0.82, "left": 0.44, "right": 0.84}, "confidence": 0.92},
}
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


def _request_json(req) -> dict:
    raw = req.content
    if b"multipart" not in req.headers.get("content-type", "").encode():
        return json.loads(raw)
    m = re.search(rb'name="request"\r\nContent-Type: application/json\r\n\r\n(.*?)\r\n--', raw, re.S)
    return json.loads(m.group(1))


class FakeJev:
    """A real TypeSafeClient talking to a mock transport. `fail` = (status, body) makes every call fail."""

    def __init__(self, input_tokens=118, fail=None, model="jev-1.14.0"):
        self.calls, self.input_tokens, self.fail, self.model = 0, input_tokens, fail, model
        self.client = ts.TypeSafeClient(api_key="test-key-abcd", transport=httpx2.MockTransport(self._handle),
                                        retry=ts.RetryPolicy(max_retries=0))

    def _handle(self, req):
        self.calls += 1
        if self.fail:
            return httpx2.Response(self.fail[0], json=self.fail[1])
        body = _request_json(req)
        answers = {qid: CANNED[q["type"]] for qid, q in body["questions"].items()}
        return httpx2.Response(200, headers={"x-typesafe-request-id": "req_test"},
                               json={"model": self.model, "usage": {"input_tokens": self.input_tokens, "output_tokens": 4},
                                     "answers": answers})


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.data = Path(self.tmp.name)
        self.conn, self.notice = store.open_db(self.data)

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def ctx(self, fake=None):
        return {"conn": self.conn, "client": fake.client if fake else None, "data_dir": self.data,
                "notice": None, "started_at": store.now(), "key_hint": "abcd", "models": None}

    def post_run(self, fake, body):
        return server.dispatch(self.ctx(fake), "POST", "/api/runs", {}, body)

    def run_count(self):
        return self.conn.execute("SELECT count(*) FROM runs").fetchone()[0]


NOUL = {"type": "noul", "instructions": "Is `text` describing an apple?"}
CHOICE = {"type": "choice", "instructions": "Which fruit?", "criteria": {"apple": None, "pear": None, "tomato": "veg"}}
SCORE = {"type": "score", "instructions": "How sweet?", "criteria": ["not", "mild", "very"]}
APPLE = {"kind": "text", "text": "A round red fruit with a crisp, sweet bite"}


class TestFoundation(Base):
    def test_question_hash_ignores_id_and_tracks_content(self):
        h = jev.question_hash(NOUL)
        self.assertEqual(h, jev.question_hash(dict(NOUL)))
        self.assertNotEqual(h, jev.question_hash({**NOUL, "instructions": "Does `text` describe an apple?"}))
        self.assertNotEqual(jev.question_hash(CHOICE), jev.question_hash({**CHOICE, "criteria": {"apple": None, "pear": None}}))
        self.assertEqual(len(h), 16)

    def test_input_hash(self):
        self.assertEqual(jev.input_hash(APPLE, None), jev.input_hash(dict(APPLE), None))
        self.assertNotEqual(jev.input_hash(APPLE, None), jev.input_hash(APPLE, "abc"))
        self.assertNotEqual(jev.input_hash(APPLE, None), jev.input_hash({"kind": "json", "fields": {"text": APPLE["text"]}}, None))

    def test_validation_rules(self):
        v = jev.validate_questions
        self.assertEqual(v({"q1": NOUL, "q2": CHOICE, "q3": SCORE}, False, "jev-latest"), [])
        self.assertTrue(v({}, False, "jev-latest"))
        self.assertTrue(v({"bad id!": NOUL}, False, "jev-latest"))
        self.assertTrue(v({"q": {"type": "maybe", "instructions": "x"}}, False, "jev-latest"))
        self.assertTrue(v({"q": {**NOUL, "instructions": "  "}}, False, "jev-latest"))
        self.assertTrue(v({"q": {**CHOICE, "criteria": {"apple": None}}}, False, "jev-latest"))
        self.assertTrue(v({"q": {**SCORE, "criteria": ["only"]}}, False, "jev-latest"))
        self.assertTrue(v({"q": {**SCORE, "criteria": ["a", ""]}}, False, "jev-latest"))
        box = {"type": "box", "instructions": "the apple in `image`"}
        self.assertTrue(v({"q": box}, False, "jev-latest"))
        self.assertTrue(v({"q": box}, True, "jev-1.13.0"))
        self.assertEqual(v({"q": box}, True, "jev-latest"), [])

    def test_validate_image(self):
        self.assertEqual(jev.validate_image(base64.b64encode(PNG).decode())[1], "png")
        self.assertEqual(jev.validate_image(base64.b64encode(b"\xff\xd8\xff\xe0rest").decode())[1], "jpg")
        with self.assertRaises(ValueError):
            jev.validate_image(base64.b64encode(b"GIF89a....").decode())
        with self.assertRaises(ValueError):
            jev.validate_image("not base64!!")

    def test_cost(self):
        self.assertAlmostEqual(jev.cost_usd(118, 0.042), 4.956e-06)
        self.assertIsNone(jev.cost_usd(None, 0.042))

    def test_run_roundtrip(self):
        q = {"q1": NOUL, "q2": SCORE}
        rid = store.insert_run(self.conn, {"input": APPLE, "input_hash": jev.input_hash(APPLE, None), "questions": q,
                                           "model_requested": "jev-latest", "model_used": "jev-1.14.0", "status": "ok",
                                           "answers": {"q1": CANNED["noul"], "q2": CANNED["score"]},
                                           "input_tokens": 10, "price_per_mtok": 0.042, "cost_usd": 4.2e-7})
        run = store.get_run(self.conn, rid)
        self.assertEqual(run["answers"]["q2"], CANNED["score"])
        self.assertEqual(run["input"], APPLE)
        self.assertEqual(run["question_hashes"]["q1"], jev.question_hash(NOUL))
        self.assertEqual(self.conn.execute("SELECT count(*) FROM answers").fetchone()[0], 2)

    def test_prefs_clamp_and_reset(self):
        p = store.put_prefs(self.conn, {"text_scale": 9, "prob_decimals": -3, "concurrency": 99, "price_per_mtok": -1,
                                        "theme": "neon", "unknown": 1})
        self.assertEqual((p["text_scale"], p["prob_decimals"], p["concurrency"], p["price_per_mtok"], p["theme"]),
                         (1.5, 0, 8, 0.0, "system"))
        self.assertNotIn("unknown", p)
        self.assertEqual(store.reset_prefs(self.conn), store.PREF_DEFAULTS)

    def test_corrupt_db_recovery(self):
        self.conn.close()
        d = self.data / "broken"
        d.mkdir()
        (d / "jevbench.db").write_bytes(b"this is not a sqlite file" * 100)
        conn, notice = store.open_db(d)
        try:
            self.assertIsNotNone(notice)
            self.assertEqual(conn.execute("SELECT count(*) FROM runs").fetchone()[0], 0)
            self.assertTrue(list(d.glob("jevbench.db.broken-*")))
        finally:
            conn.close()
            self.conn, _ = store.open_db(self.data)


class TestRunFlow(Base):
    def test_ok_run_recorded_with_cost(self):
        fake = FakeJev()
        status, run = self.post_run(fake, {"input": APPLE, "questions": {"q1": NOUL}})
        self.assertEqual(status, 200)
        self.assertEqual(run["status"], "ok")
        self.assertEqual(run["model_used"], "jev-1.14.0")
        self.assertEqual(run["answers"]["q1"]["noul"], 0.93)
        self.assertEqual(run["input_tokens"], 118)
        self.assertAlmostEqual(run["cost_usd"], 118 * 0.042 / 1e6)
        self.assertEqual(run["request_id"], "req_test")
        self.assertEqual(run["model_requested"], "jev-latest")

    def test_mixed_types_one_request(self):
        fake = FakeJev()
        _, run = self.post_run(fake, {"input": APPLE, "questions": {"a": NOUL, "b": CHOICE, "c": SCORE}})
        self.assertEqual(fake.calls, 1)
        self.assertEqual(set(run["answers"]), {"a", "b", "c"})

    def test_sdk_error_recorded_without_cost(self):
        fake = FakeJev(fail=(401, {"error": {"message": "bad key"}}))
        status, run = self.post_run(fake, {"input": APPLE, "questions": {"q1": NOUL}})
        self.assertEqual((status, run["status"]), (200, "error"))
        self.assertIsNone(run["cost_usd"])
        self.assertIn("API key", run["error"])
        self.assertEqual(run["answers"], {})
        self.assertEqual(self.run_count(), 1)

    def test_null_tokens_cost_unknown(self):
        _, run = self.post_run(FakeJev(input_tokens=None), {"input": APPLE, "questions": {"q1": NOUL}})
        self.assertEqual(run["status"], "ok")
        self.assertIsNone(run["cost_usd"])

    def test_validation_failure_not_recorded(self):
        fake = FakeJev()
        status, body = self.post_run(fake, {"input": APPLE, "questions": {"q1": {**CHOICE, "criteria": {"x": None}}}})
        self.assertEqual(status, 400)
        self.assertEqual(body["field"], "questions.q1.criteria")
        self.assertEqual((fake.calls, self.run_count()), (0, 0))

    def test_no_key_503_not_recorded(self):
        status, body = server.dispatch(self.ctx(None), "POST", "/api/runs", {}, {"input": APPLE, "questions": {"q1": NOUL}})
        self.assertEqual(status, 503)
        self.assertEqual(self.run_count(), 0)

    def test_get_run_and_404(self):
        _, run = self.post_run(FakeJev(), {"input": APPLE, "questions": {"q1": NOUL}})
        self.assertEqual(server.dispatch(self.ctx(), "GET", f"/api/runs/{run['id']}", {}, None)[1]["id"], run["id"])
        self.assertEqual(server.dispatch(self.ctx(), "GET", "/api/runs/9999", {}, None)[0], 404)

    def test_price_change_applies_to_new_runs_only(self):
        _, r1 = self.post_run(FakeJev(), {"input": APPLE, "questions": {"q1": NOUL}})
        store.put_prefs(self.conn, {"price_per_mtok": 1.0})
        _, r2 = self.post_run(FakeJev(), {"input": APPLE, "questions": {"q1": NOUL}})
        self.assertAlmostEqual(store.get_run(self.conn, r1["id"])["cost_usd"], 118 * 0.042 / 1e6)
        self.assertAlmostEqual(r2["cost_usd"], 118 / 1e6)


class TestNoulCriteria(unittest.TestCase):
    def test_shape(self):
        ok = lambda c: not jev.validate_questions({"q1": {**NOUL, "criteria": c}}, False, "jev-latest")
        self.assertTrue(ok({"true": "the fruit itself", "false": "a brand"}))
        self.assertTrue(ok({"true": "the fruit itself"}))
        self.assertFalse(ok("plain text"))  # the API rejects this: "criteria must be an object"
        self.assertFalse(ok({"yes": "x"}))
        self.assertFalse(ok({}))


class TestEnvFile(unittest.TestCase):
    def test_parse_and_env_wins(self):
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / ".env"
            f.write_text('# c\nJB_A = "x=1"\nJB_B=two\nnoise\n', encoding="utf-8")
            os.environ["JB_B"] = "real"
            try:
                load_env(f)
                self.assertEqual(os.environ["JB_A"], "x=1")
                self.assertEqual(os.environ["JB_B"], "real")
            finally:
                for k in ("JB_A", "JB_B"):
                    os.environ.pop(k, None)


@unittest.skipUnless(os.environ.get("TYPESAFE_API_KEY") and os.environ.get("JEVBENCH_LIVE") == "1",
                     "live check: set JEVBENCH_LIVE=1 and TYPESAFE_API_KEY")
class LiveSmoke(unittest.TestCase):
    def test_real_response_shape_matches_fakes(self):
        client = ts.TypeSafeClient()
        out = jev.call_jev(client, "jev-latest", {"text": "A round red fruit with a crisp, sweet bite"},
                           {"n": NOUL, "c": CHOICE, "s": SCORE,
                            "nc": {**NOUL, "criteria": {"true": "the fruit itself", "false": "a brand or another fruit"}}})
        self.assertEqual(out["status"], "ok", out["error"])
        self.assertTrue(out["model_used"].startswith("jev-"))
        self.assertIsInstance(out["input_tokens"], int)
        self.assertGreater(out["input_tokens"], 0)
        for qid, t in (("n", "noul"), ("c", "choice"), ("s", "score")):
            self.assertEqual(set(out["answers"][qid]), set(CANNED[t]), f"{t} answer keys drifted from the fakes")
        self.assertEqual(sorted(out["answers"]["s"]["legend"]), ["0", "1", "2"])


if __name__ == "__main__":
    unittest.main()
