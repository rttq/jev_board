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
        body = self.last = _request_json(req)
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


class TestExperiments(Base):
    def exp(self, fake=None, **over):
        body = {"name": "apple-wording", "type": "noul", "criteria": None,
                "rows": [{"input": APPLE}, {"input": "Red round veg", "label": "no"}],
                "columns": [{"instructions": NOUL["instructions"]}, {"instructions": "Does `text` describe an apple?"}],
                **over}
        st, out = server.dispatch(self.ctx(fake), "POST", "/api/experiments", {}, body)
        self.assertEqual(st, 200, out)
        return out

    def get(self, exp_id, fake=None):
        return server.dispatch(self.ctx(fake), "GET", f"/api/experiments/{exp_id}", {}, None)[1]

    def test_create_assigns_keys_and_hashes(self):
        e = self.exp()["experiment"]
        self.assertEqual([r["key"] for r in e["rows"]], ["r1", "r2"])
        self.assertEqual([c["key"] for c in e["columns"]], ["c1", "c2"])
        self.assertEqual(e["rows"][0]["input_hash"], jev.input_hash(APPLE, None))
        self.assertEqual(e["columns"][0]["question_hash"], jev.question_hash(NOUL))
        self.assertEqual(e["view"]["threshold"], {"low": 0.5, "high": 0.8})

    def test_cells_from_experiment_and_adhoc_runs_latest_wins(self):
        fake = FakeJev()
        e = self.exp(fake)["experiment"]
        self.post_run(fake, {"input": APPLE, "questions": {"c1": NOUL}, "experiment_id": e["id"]})
        out = self.get(e["id"], fake)
        first = out["cells"]["r1"]["c1"]["jev-1.14.0"]["run_id"]
        self.assertEqual(out["cost"]["runs"], 1)
        # an ad-hoc run (no experiment) with the same text and wording fills the same cell, and is newer
        st, run = self.post_run(fake, {"input": APPLE, "questions": {"anything": NOUL}})
        out = self.get(e["id"], fake)
        self.assertEqual(out["cells"]["r1"]["c1"]["jev-1.14.0"]["run_id"], run["id"])
        self.assertNotEqual(first, run["id"])
        self.assertEqual(out["cost"]["runs"], 1)  # experiment cost counts only its own runs
        self.assertIn(str(run["id"]), out["run_costs"])
        self.assertNotIn("r2", out["cells"])

    def test_answered_wording_is_immutable_new_column_ok(self):
        fake = FakeJev()
        e = self.exp(fake)["experiment"]
        self.post_run(fake, {"input": APPLE, "questions": {"c1": NOUL}, "experiment_id": e["id"]})
        cols = [dict(c) for c in e["columns"]]
        cols[0]["instructions"] = "Changed wording?"
        st, out = server.dispatch(self.ctx(fake), "PUT", f"/api/experiments/{e['id']}", {}, {**e, "columns": cols})
        self.assertEqual(st, 409)
        st, out = server.dispatch(self.ctx(fake), "PUT", f"/api/experiments/{e['id']}", {},
                                  {**e, "columns": e["columns"] + [{"instructions": "Apple (the fruit)?"}]})
        self.assertEqual(st, 200, out)
        self.assertEqual(out["experiment"]["columns"][-1]["key"], "c3")
        st, out = server.dispatch(self.ctx(fake), "PUT", f"/api/experiments/{e['id']}", {}, {**e, "type": "score",
                                  "criteria": ["a", "b"]})
        self.assertEqual(st, 409)

    def test_plan_lists_only_missing_cells(self):
        fake = FakeJev()
        e = self.exp(fake)["experiment"]
        for r in e["rows"]:
            qs = {c["key"]: {"type": "noul", "instructions": c["instructions"]} for c in e["columns"]}
            self.post_run(fake, {"input": r["input"], "questions": qs, "experiment_id": e["id"], "model": "jev-latest"})
        plan = server.dispatch(self.ctx(fake), "GET", f"/api/experiments/{e['id']}/plan", {"model": ["jev-latest"]}, None)[1]
        self.assertEqual(plan["requests"], [])
        self.assertEqual(plan["resolved_model"], "jev-1.14.0")
        server.dispatch(self.ctx(fake), "PUT", f"/api/experiments/{e['id']}", {},
                        {**e, "columns": e["columns"] + [{"instructions": "Apple (the fruit)?"}]})
        plan = server.dispatch(self.ctx(fake), "GET", f"/api/experiments/{e['id']}/plan", {"model": ["jev-latest"]}, None)[1]
        self.assertEqual(plan["requests"], [{"row": "r1", "columns": ["c3"]}, {"row": "r2", "columns": ["c3"]}])
        self.assertEqual(plan["estimated_tokens"], 2 * 118)  # average of the experiment's real runs
        self.assertAlmostEqual(plan["estimated_cost_usd"], 236 * 0.042 / 1e6)

    def test_shared_reference_is_sent_and_part_of_cell_identity(self):
        fake = FakeJev()
        e = self.exp(fake, reference="Apples are pome fruit.")["experiment"]
        merged = {"kind": "json", "fields": {"reference": "Apples are pome fruit.", "text": APPLE["text"]}}
        self.assertEqual(e["rows"][0]["input_hash"], jev.input_hash(merged, None))
        self.post_run(fake, {"input": APPLE, "questions": {"c1": NOUL}, "experiment_id": e["id"]})
        self.assertEqual(fake.last["state"], merged["fields"])
        self.assertIn("c1", self.get(e["id"], fake)["cells"]["r1"])
        # an ad-hoc run of the bare text is a different input; changing the reference starts fresh cells
        self.post_run(fake, {"input": APPLE, "questions": {"c1": NOUL}})
        st, out = server.dispatch(self.ctx(fake), "PUT", f"/api/experiments/{e['id']}", {}, {"reference": "Other."})
        self.assertEqual(st, 200, out)
        self.assertEqual(out["cells"], {})
        st, out = server.dispatch(self.ctx(fake), "PUT", f"/api/experiments/{e['id']}", {}, {"reference": "  "})
        self.assertIsNone(out["experiment"]["reference"])
        self.assertIn("r1", out["cells"])  # back to bare text: the ad-hoc run fills r1 again

    def test_invalid_labels_give_per_row_errors(self):
        st, out = server.dispatch(self.ctx(), "POST", "/api/experiments", {},
                                  {"name": "x", "type": "noul", "rows": [{"input": "a", "label": "yes"},
                                   {"input": "b", "label": "maybe"}, {"input": ""}], "columns": []})
        self.assertEqual(st, 400)
        self.assertEqual([r["index"] for r in out["rows"]], [1, 2])

    def test_labels_per_type_on_create_and_update(self):
        cases = [("noul", None, ["yes", "no", None], ["maybe", True, 1]),
                 ("choice", {"apple": None, "pear": None}, ["apple", "pear", None], ["plum", "Apple", 0]),
                 ("score", ["a", "b", "c"], [0, 2, None], [3, -1, "1", 1.0, True])]
        for t, crit, good, bad in cases:
            with self.subTest(type=t):
                rows = [{"input": f"g{i}", "label": l} for i, l in enumerate(good)]
                st, out = server.dispatch(self.ctx(), "POST", "/api/experiments", {},
                                          {"name": t, "type": t, "criteria": crit, "rows": rows, "columns": []})
                self.assertEqual(st, 200, out)
                exp = out["experiment"]
                bad_rows = exp["rows"] + [{"input": f"b{i}", "label": l} for i, l in enumerate(bad)]
                st, out = server.dispatch(self.ctx(), "PUT", f"/api/experiments/{exp['id']}", {}, {"rows": bad_rows})
                self.assertEqual(st, 400)
                self.assertEqual([r["index"] for r in out["rows"]], list(range(len(good), len(good) + len(bad))))
                # a valid label change through PUT (what the grid's label select sends) is saved
                fixed = [{**r, "label": good[1]} for r in exp["rows"]]
                st, out = server.dispatch(self.ctx(), "PUT", f"/api/experiments/{exp['id']}", {}, {"rows": fixed})
                self.assertEqual([r["label"] for r in out["experiment"]["rows"]], [good[1]] * len(good))

    def test_duplicates_merge_with_warning_and_delete_keeps_runs(self):
        fake = FakeJev()
        out = self.exp(fake, rows=[{"input": "a"}, {"input": "a"}])
        self.assertEqual(len(out["experiment"]["rows"]), 1)
        self.assertTrue(out["warnings"])
        e = out["experiment"]
        self.post_run(fake, {"input": {"kind": "text", "text": "a"}, "questions": {"c1": NOUL}, "experiment_id": e["id"]})
        st, dup = server.dispatch(self.ctx(fake), "POST", f"/api/experiments/{e['id']}/duplicate", {}, None)
        self.assertEqual(dup["experiment"]["name"], "apple-wording copy")
        self.assertEqual(server.dispatch(self.ctx(fake), "DELETE", f"/api/experiments/{e['id']}", {}, None)[0], 204)
        self.assertEqual(self.run_count(), 1)
        self.assertIsNone(self.conn.execute("SELECT experiment_id FROM runs").fetchone()[0])
        self.assertEqual(server.dispatch(self.ctx(), "POST", "/api/experiments", {},
                                         {"name": "apple-wording copy", "type": "noul"})[0], 409)


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
