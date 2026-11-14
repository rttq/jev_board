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

from jevbench import jev, library, server, store
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
def png_header(w, h):  # enough of a PNG for validation: signature + IHDR with the size
    return b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\x0dIHDR" + w.to_bytes(4, "big") + h.to_bytes(4, "big") + b"\x08\x02\x00\x00\x00"


def jpeg_header(w, h):  # SOI, an APP0 segment, then SOF0 with the size
    return b"\xff\xd8" + b"\xff\xe0\x00\x04ab" + b"\xff\xc0\x00\x11\x08" + h.to_bytes(2, "big") + w.to_bytes(2, "big") + b"\x03" + b"\x00" * 9


PNG = png_header(400, 300)


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
        self.headers = req.headers
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
        self.assertEqual(jev.validate_image(base64.b64encode(jpeg_header(1568, 280)).decode())[1], "jpg")
        b64 = lambda b: base64.b64encode(b).decode()
        for bad in (png_header(279, 400), png_header(400, 1569), jpeg_header(4032, 3024)):
            with self.assertRaisesRegex(ValueError, "between 280 and 1568"):
                jev.validate_image(b64(bad))
        with self.assertRaisesRegex(ValueError, "cannot read the image size"):
            jev.validate_image(b64(b"\xff\xd8\xff\xe0rest"))
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

    def test_totals_session_all_time_and_unknown(self):
        ctx = self.ctx()
        _, old = self.post_run(FakeJev(), {"input": APPLE, "questions": {"q1": NOUL}})  # before this session
        # Windows clocks tick in ~1-15 ms steps, so "now" can equal the run's timestamp; make it unambiguously older
        self.conn.execute("UPDATE runs SET created_at = '2000-01-01T00:00:00.000000Z' WHERE id = ?", (old["id"],))
        ctx["started_at"] = store.now()
        _, a = self.post_run(FakeJev(), {"input": APPLE, "questions": {"q1": NOUL}})
        _, b = self.post_run(FakeJev(input_tokens=None), {"input": APPLE, "questions": {"q1": NOUL}})
        self.post_run(FakeJev(fail=(401, {"error": {"message": "bad key"}})), {"input": APPLE, "questions": {"q1": NOUL}})
        store.put_prefs(self.conn, {"price_per_mtok": 9.0})  # must not change recorded costs
        st, t = server.dispatch(ctx, "GET", "/api/totals", {}, None)
        self.assertEqual(st, 200)
        self.assertEqual(t["session"], {"runs": 3, "cost_usd": a["cost_usd"], "unknown_cost_runs": 1})  # error run: no cost, not unknown
        self.assertEqual(t["all_time"]["runs"], 4)
        self.assertAlmostEqual(t["all_time"]["cost_usd"], 2 * 118 * 0.042 / 1e6)
        self.assertIsNone(b["cost_usd"])


    def test_box_run_with_image(self):
        fake = FakeJev()
        box = {"type": "box", "instructions": "the apple in `image`"}
        body = {"input": APPLE, "image_base64": base64.b64encode(PNG).decode(), "questions": {"b": box}}
        status, run = self.post_run(fake, body)
        self.assertEqual((status, run["status"]), (200, "ok"))
        self.assertEqual(run["answers"]["b"], CANNED["box"])
        self.assertTrue((self.data / "images" / f"{run['image_sha']}.png").read_bytes() == PNG)
        self.assertEqual(store.get_run(self.conn, run["id"])["answers"]["b"]["box"], CANNED["box"]["box"])
        self.assertEqual(fake.headers.get("typesafe-danger-zone-images"), "true")
        self.post_run(fake, {"input": APPLE, "questions": {"q1": NOUL}})
        self.assertIsNone(fake.headers.get("typesafe-danger-zone-images"))  # text-only runs do not opt in

    def test_box_rejected_without_image_or_on_1_13(self):
        fake = FakeJev()
        box = {"type": "box", "instructions": "the apple in `image`"}
        status, _ = self.post_run(fake, {"input": APPLE, "questions": {"b": box}})
        self.assertEqual(status, 400)
        status, body = self.post_run(fake, {"input": APPLE, "image_base64": base64.b64encode(PNG).decode(),
                                            "model": "jev-1.13.0", "questions": {"b": box}})
        self.assertEqual(status, 400)
        self.assertIn("1.14", body["error"])
        self.assertEqual((fake.calls, self.run_count()), (0, 0))

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


class TestHistory(Base):
    def setUp(self):
        super().setUp()
        fake = FakeJev()
        st, e = server.dispatch(self.ctx(fake), "POST", "/api/experiments", {}, {"name": "e", "type": "noul", "rows": [], "columns": []})
        self.exp_id = e["experiment"]["id"]
        self.r1 = self.post_run(fake, {"input": APPLE, "questions": {"q1": NOUL}, "experiment_id": self.exp_id})[1]
        self.r2 = self.post_run(fake, {"input": {"kind": "text", "text": "Красное яблоко"}, "questions": {"c": CHOICE, "s": SCORE}})[1]
        self.r3 = self.post_run(FakeJev(fail=(500, {"error": {"message": "boom"}})), {"input": APPLE, "questions": {"q1": CHOICE}})[1]
        server.dispatch(self.ctx(), "PATCH", f"/api/runs/{self.r2['id']}", {}, {"note": "russian", "tags": ["ru", "fruit"]})

    def ids(self, **q):
        st, out = server.dispatch(self.ctx(), "GET", "/api/runs", {k: [str(v)] for k, v in q.items()}, None)
        self.assertEqual(st, 200, out)
        self.assertEqual(out["total"], len(out["runs"]))
        return [r["id"] for r in out["runs"]]

    def test_filters_narrow(self):
        r1, r2, r3 = self.r1["id"], self.r2["id"], self.r3["id"]
        self.assertEqual(self.ids(), [r3, r2, r1])  # newest first
        self.assertEqual(self.ids(type="noul"), [r1])
        self.assertEqual(self.ids(type="choice"), [r3, r2])  # the error run matches by what was sent
        self.assertEqual(self.ids(status="error"), [r3])
        self.assertEqual(self.ids(model="jev-1.14.0"), [r2, r1])
        self.assertEqual(self.ids(experiment_id=self.exp_id), [r1])
        self.assertEqual(self.ids(tag="ru"), [r2])
        self.assertEqual(self.ids(tag="r"), [])  # whole tags only
        self.assertEqual(self.ids(q="crisp"), [r3, r1])
        self.assertEqual(self.ids(q="яблоко"), [r2])  # non-ASCII text is stored escaped
        self.assertEqual(self.ids(q="russian"), [r2])  # note
        self.assertEqual(self.ids(ids=f"{r1},{r3}"), [r3, r1])
        today = self.r1["created_at"][:10]
        self.assertEqual(self.ids(**{"from": today, "to": today}), [r3, r2, r1])
        self.assertEqual(self.ids(to="2000-01-01"), [])
        st, page = server.dispatch(self.ctx(), "GET", "/api/runs", {"limit": ["1"], "offset": ["1"]}, None)
        self.assertEqual((page["total"], [r["id"] for r in page["runs"]]), (3, [r2]))

    def test_patch_only_note_and_tags_and_delete_cascades(self):
        st, run = server.dispatch(self.ctx(), "PATCH", f"/api/runs/{self.r1['id']}", {},
                                  {"note": "n", "tags": "a, b", "cost_usd": 99, "status": "error"})
        self.assertEqual((run["note"], run["tags"], run["status"], run["cost_usd"]), ("n", ["a", "b"], "ok", self.r1["cost_usd"]))
        self.assertEqual(server.dispatch(self.ctx(), "PATCH", "/api/runs/999", {}, {"note": "x"})[0], 404)
        st, _ = server.dispatch(self.ctx(), "DELETE", f"/api/runs/{self.r2['id']}", {}, None)
        self.assertEqual(st, 204)
        self.assertEqual(self.conn.execute("SELECT count(*) FROM answers WHERE run_id = ?", (self.r2["id"],)).fetchone()[0], 0)
        self.assertEqual(server.dispatch(self.ctx(), "DELETE", f"/api/runs/{self.r2['id']}", {}, None)[0], 404)

    def test_csv_one_row_per_question_with_exact_header(self):
        import csv, io
        st, d = server.dispatch(self.ctx(), "GET", "/api/export", {"format": ["csv"]}, None)
        self.assertEqual(st, 200)
        self.assertTrue(d.filename.endswith(".csv"))
        self.assertTrue(d.data.startswith("﻿".encode()))
        rows = list(csv.reader(io.StringIO(d.data.decode("utf-8-sig"))))
        self.assertEqual(rows[0], store.EXPORT_COLUMNS)
        self.assertEqual(len(rows) - 1, 4)  # r3: 1 question, r2: 2, r1: 1
        by = {(r[0], r[7]): dict(zip(rows[0], r)) for r in rows[1:]}
        self.assertEqual(by[(str(self.r2["id"]), "s")]["result"], "1.43")
        self.assertEqual(by[(str(self.r2["id"]), "c")]["input_text"], "Красное яблоко")
        self.assertEqual(by[(str(self.r2["id"]), "c")]["tags"], "ru;fruit")
        self.assertEqual(by[(str(self.r3["id"]), "q1")]["result"], "")
        self.assertIn("boom", by[(str(self.r3["id"]), "q1")]["error"])
        st, d = server.dispatch(self.ctx(), "GET", "/api/export", {"format": ["csv"], "type": ["noul"]}, None)
        self.assertEqual(len(d.data.decode("utf-8-sig").strip().splitlines()), 2)  # header + r1
        self.assertEqual(server.dispatch(self.ctx(), "GET", "/api/export", {"format": ["xml"]}, None)[0], 400)

    def test_jsonl_round_trips_get_run(self):
        st, d = server.dispatch(self.ctx(), "GET", "/api/export", {"format": ["jsonl"]}, None)
        lines = [json.loads(x) for x in d.data.decode().splitlines()]
        self.assertEqual([x["id"] for x in lines], [self.r3["id"], self.r2["id"], self.r1["id"]])
        for x in lines:
            self.assertEqual(x, store.get_run(self.conn, x["id"]))


class TestConcurrency(Base):
    def test_parallel_requests_share_the_db_safely(self):
        """The server runs requests on parallel threads (a matrix run sends `concurrency` rows at once).
        A single shared sqlite connection failed here with 'bad parameter or other API misuse'."""
        from concurrent.futures import ThreadPoolExecutor
        fake = FakeJev()
        st, e = server.dispatch(self.ctx(fake), "POST", "/api/experiments", {},
                                {"name": "p", "type": "noul", "rows": [], "columns": []})
        eid = e["experiment"]["id"]

        def work(i):
            st, run = self.post_run(fake, {"input": {"kind": "text", "text": f"t{i}"}, "questions": {"q": NOUL}, "experiment_id": eid})
            assert st == 200 and run["status"] == "ok", run
            for path in (f"/api/experiments/{eid}", "/api/runs", "/api/totals", "/api/prefs"):
                st, out = server.dispatch(self.ctx(fake), "GET", path, {}, None)
                assert st == 200, (path, out)
            return run["id"]

        with ThreadPoolExecutor(8) as pool:
            ids = list(pool.map(work, range(64)))
        self.assertEqual(len(set(ids)), 64)
        self.assertEqual(self.run_count(), 64)


class TestFromRuns(Base):
    WORDINGS = ["Is `text` an apple?", "Does `text` describe an apple?", "Apple (the fruit)?"]
    PEAR = {"kind": "text", "text": "A soft green pear"}

    def setUp(self):
        super().setUp()
        self.fake = FakeJev()
        self.ids = [self.post_run(self.fake, {"input": inp, "questions": {"q": {"type": "noul", "instructions": w}}})[1]["id"]
                    for inp in (APPLE, self.PEAR) for w in self.WORDINGS]
        self.extra = [self.post_run(self.fake, {"input": APPLE, "questions": {"c": CHOICE}})[1]["id"],
                      self.post_run(self.fake, {"input": APPLE, "questions": {"n": {**NOUL, "criteria": {"true": "a real apple"}}}})[1]["id"]]

    def make(self, **body):
        return server.dispatch(self.ctx(self.fake), "POST", "/api/experiments/from-runs", {}, {"name": "from history", "type": "noul", **body})

    def test_six_runs_make_a_full_2x3_matrix_without_calling_jev(self):
        calls = self.fake.calls
        st, out = self.make(run_ids=self.ids)
        self.assertEqual(st, 200, out)
        e = out["experiment"]
        self.assertEqual([r["input"]["text"] for r in e["rows"]], [APPLE["text"], self.PEAR["text"]])
        self.assertEqual([c["instructions"] for c in e["columns"]], self.WORDINGS)
        self.assertEqual({r: sorted(cols) for r, cols in out["cells"].items()}, {"r1": ["c1", "c2", "c3"], "r2": ["c1", "c2", "c3"]})
        self.assertEqual(self.fake.calls, calls)
        self.assertEqual(out["skipped"], {"other_types": 0, "other_criteria": 0, "with_image": 0})
        plan = server.dispatch(self.ctx(self.fake), "GET", f"/api/experiments/{e['id']}/plan", {"model": ["jev-1.14.0"]}, None)[1]
        self.assertEqual(plan["requests"], [])

    def test_mixed_types_and_criteria_are_counted_as_skipped(self):
        st, out = self.make(filter={"model": "jev-1.14.0"})
        self.assertEqual(st, 200, out)
        self.assertEqual(out["skipped"], {"other_types": 1, "other_criteria": 1, "with_image": 0})
        self.assertEqual(len(out["experiment"]["columns"]), 3)
        self.assertTrue(any("other types" in w for w in out["warnings"]))
        st, out = self.make(name="choice one", type="choice", run_ids=self.extra)
        self.assertEqual((st, len(out["experiment"]["rows"]), out["skipped"]["other_types"]), (200, 1, 1))
        self.assertEqual(self.make(name="score", type="score", run_ids=self.ids)[0], 400)  # nothing to build from
        self.assertEqual(self.make(run_ids=self.ids)[0], 409)  # "from history" exists already


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


TICKET = {"ticket": {"subject": "Refund", "priority": 2, "tags": ["billing"]}}
TRIAGE = {
    "urgent": {"type": "noul", "instructions": "Is the customer blocked right now?",
               "criteria": {"true": "cannot use the product", "false": "a question or a wish"}},
    "area": {"type": "choice", "instructions": "Which team owns `ticket.subject`?",
             "criteria": {"billing": "money, invoices, refunds", "tech": None, "sales": None}},
    "mood": {"type": "score", "instructions": "How upset is the customer?", "criteria": ["calm", "annoyed", "angry"]},
}


class TestLibrary(Base):
    """data/json library: listing, containment, strict reading, field tree, question checks (SC-003 set)."""

    def write(self, kind, rel, data):
        p = self.data / "json" / kind / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data if isinstance(data, bytes) else data.encode("utf-8"))
        return p

    def wj(self, kind, rel, obj):
        return self.write(kind, rel, json.dumps(obj, ensure_ascii=False))

    def an(self, kind, rel):
        return library.analyze(self.data, kind, rel)

    def get(self, url, **query):
        return server.dispatch(self.ctx(), "GET", url, {k: [v] for k, v in query.items()}, None)

    # --- foundation ---
    def test_listing_creates_folders_lists_nested_json_only_sorted(self):
        st, out = self.get("/api/library/inputs")
        self.assertEqual((st, out["files"]), (200, []))
        self.assertTrue((self.data / "json" / "questions").is_dir())
        self.write("inputs", "b.json", "{}")
        self.write("inputs", "A/z.JSON", "{}")
        self.write("inputs", "notes.txt", "x")
        self.write("inputs", "big.json", b" " * (library.MAX_BYTES + 1))
        files = self.get("/api/library/inputs")[1]["files"]
        self.assertEqual([f["path"] for f in files], ["A/z.JSON", "b.json", "big.json"])
        self.assertEqual([f["too_large"] for f in files], [False, False, True])
        self.assertEqual(self.get("/api/library/other")[0], 404)

    def test_paths_must_stay_inside_the_folder(self):
        self.write("inputs", "ok.json", "{}")
        (self.data / "json" / "secret.json").write_text("{}")
        for bad in ("../secret.json", str(self.data / "json" / "secret.json"), "/ok.json", "ok.txt", "", "C:ok.json"):
            with self.subTest(bad=bad):
                st, out = self.get("/api/library/inputs/file", path=bad)
                self.assertEqual((st, out["field"]), (400, "path"))
        self.assertEqual(self.get("/api/library/inputs/file", path="gone.json")[0], 404)
        self.assertEqual(self.get("/api/library/inputs/file", path="ok.json")[0], 200)

    def test_link_pointing_outside_is_neither_listed_nor_read(self):
        outside = self.data / "outside.json"
        outside.write_text("{}")
        link = library.root(self.data, "inputs") / "link.json"
        try:
            os.symlink(outside, link)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks need extra rights on this system")
        self.assertEqual(self.get("/api/library/inputs")[1]["files"], [])
        self.assertEqual(self.get("/api/library/inputs/file", path="link.json")[0], 400)

    def test_syntax_error_has_line_and_column(self):
        self.write("inputs", "bad.json", '{\n  "a": 1,\n  "b": 2\n  "c": 3\n}')
        out = self.an("inputs", "bad.json")
        self.assertFalse(out["ok"])
        self.assertEqual((out["error"]["line"], out["error"]["col"]), (4, 3))
        self.assertTrue(out["pretty"].startswith('{\n  "a": 1'))  # raw text shown, so line 4 can be found

    # --- US1 ---
    def test_object_file_is_one_record_identical_to_the_file(self):
        rec = {"z": 1, "a": {"имя": "Ольга", "emoji": "🙂", "list": [{"x": None}, True, 1.5, -3]}}
        self.wj("inputs", "one.json", rec)
        out = self.an("inputs", "one.json")
        self.assertTrue(out["ok"])
        self.assertEqual(out["inputs"]["shape"], "object")
        self.assertEqual(out["inputs"]["records"], [rec])
        self.assertEqual(list(out["inputs"]["records"][0]), ["z", "a"])  # key order kept
        self.assertEqual(json.loads(out["pretty"]), rec)

    def test_list_file_and_rejected_shapes(self):
        self.wj("inputs", "three.json", [{"n": 1}, {"n": 2}, {"n": 3}])
        out = self.an("inputs", "three.json")
        self.assertEqual((out["inputs"]["shape"], [r["n"] for r in out["inputs"]["records"]]), ("list", [1, 2, 3]))
        for name, value, msg in (("empty.json", [], "holds no records"), ("mixed.json", [{}, 5], "item 2 is a number"),
                                 ("text.json", "hello", "top level is a text")):
            with self.subTest(name=name):
                self.wj("inputs", name, value)
                out = self.an("inputs", name)
                self.assertFalse(out["ok"])
                self.assertIn(msg, out["error"]["message"])

    # --- US2 ---
    def test_field_tree_paths_types_samples_counts(self):
        self.wj("inputs", "t.json", TICKET)
        out = self.an("inputs", "t.json")["inputs"]
        self.assertEqual(out["fields"], [
            {"path": "ticket", "type": "object", "count": 1},
            {"path": "ticket.subject", "type": "text", "count": 1, "sample": "Refund"},
            {"path": "ticket.priority", "type": "number", "count": 1, "sample": 2},
            {"path": "ticket.tags", "type": "list", "count": 1, "items": {"n": 1, "type": "text"}},
        ])
        self.assertEqual(out["depth"], 3)

    def test_field_tree_over_records_partial_mixed_and_list_items(self):
        recs = [{"ticket": {"priority": 1}, "messages": [{"author": "a"}]},
                {"ticket": {"priority": "high"}, "messages": []},
                {"ticket": {}, "late": True}]
        self.wj("inputs", "r.json", recs)
        f = {d["path"]: d for d in self.an("inputs", "r.json")["inputs"]["fields"]}
        self.assertEqual(f["ticket.priority"]["count"], 2)
        self.assertEqual((f["ticket.priority"]["type"], f["ticket.priority"]["types"]), ("mixed", ["number", "text"]))
        self.assertEqual(f["messages[].author"]["count"], 1)
        self.assertEqual(f["late"]["count"], 1)
        order = list(f)
        self.assertLess(order.index("ticket.priority"), order.index("messages"))  # children stay under their parent

    # --- US3 ---
    def test_list_records_become_experiment_rows_unchanged(self):
        recs = [{"t": "a", "n": 1}, {"t": "b", "nested": {"x": [1, 2]}}, {"t": "a", "n": 1}]
        self.wj("inputs", "rows.json", recs)
        records = self.an("inputs", "rows.json")["inputs"]["records"]
        st, out = server.dispatch(self.ctx(), "POST", "/api/experiments", {}, {
            "name": "lib", "type": "noul", "rows": [{"input": {"kind": "json", "fields": r}} for r in records]})
        self.assertEqual(st, 200)
        self.assertEqual([r["input"]["fields"] for r in out["experiment"]["rows"]], recs[:2])
        self.assertTrue(any("merged" in w for w in out["warnings"]))

    # --- US4 ---
    def test_question_file_valid_invalid_and_box_note(self):
        self.wj("questions", "triage.json", TRIAGE)
        out = self.an("questions", "triage.json")
        self.assertTrue(out["ok"])
        self.assertEqual(list(out["questions"]), ["urgent", "area", "mood"])
        self.assertEqual({k: v["wire"] for k, v in out["questions"].items()}, TRIAGE)
        self.assertTrue(all(v["valid"] for v in out["questions"].values()))
        self.wj("questions", "mixed.json", {"one": {"type": "choice", "instructions": "x", "criteria": {"a": None}},
                                            "box": {"type": "box", "instructions": "Where is the cat?"}})
        q = self.an("questions", "mixed.json")["questions"]
        self.assertEqual((q["one"]["valid"], q["one"]["errors"]), (False, ["a Choice needs at least 2 options"]))
        self.assertEqual((q["box"]["valid"], q["box"]["notes"]), (True, [library.BOX_NOTE]))

    def test_question_file_structural_rejections(self):
        cases = (("list.json", [TRIAGE["urgent"]], "top level is a list"),
                 ("noinstr.json", {"q1": {"type": "noul"}}, "`q1` has no instructions"),
                 ("unwrapped.json", {"type": "noul", "instructions": "x"}, '{"my_id"'),
                 ("badtype.json", {"q1": {"type": "rank", "instructions": "x"}}, "type 'rank'"),
                 ("notobj.json", {"q1": "Is it?"}, "`q1` is a text"),
                 ("none.json", {}, "no questions"))
        for name, value, msg in cases:
            with self.subTest(name=name):
                self.wj("questions", name, value)
                out = self.an("questions", name)
                self.assertFalse(out["ok"])
                self.assertIn(msg, out["error"]["message"])

    # --- US5: the SC-003 set (with the files above, well over 20) ---
    def test_reading_rules(self):
        deep = '{"a": ' * 100_000 + "1" + "}" * 100_000
        cases = [  # (name, bytes, ok, error substring, warning substring)
            ("bom.json", b"\xef\xbb\xbf" + '{"a": "б"}'.encode(), True, None, None),
            ("u16le.json", '{"a": 1}'.encode("utf-16"), False, "UTF-16", None),
            ("u16be.json", b"\xfe\xff" + '{"a": 1}'.encode("utf-16-be"), False, "UTF-16", None),
            ("latin1.json", '{"a": "café"}'.encode("latin-1"), False, "not UTF-8 (first bad byte at position 10)", None),
            ("unicode.json", '{"имя": "Ольга 🙂"}'.encode(), True, None, None),
            ("nan.json", b'{"a": "NaN in text",\n "b": NaN}', False, "NaN/Infinity", None),
            ("inf.json", b'[{"a": -Infinity}]', False, "NaN/Infinity", None),
            ("dup.json", b'{"a": 1, "a": 2, "b": {"c": 1, "c": 1}}', True, None, "key `a` appears twice"),
            ("bigint.json", b'{"id": 12345678901234567890}', True, None, "12345678901234567890 becomes 12345678901234567000"),
            ("floats.json", b'{"a": 1.5e300, "b": -0, "c": 9007199254740992}', True, None, None),
            ("deep.json", deep.encode(), False, "nested too deeply", None),
            ("empty.json", b"", False, "file is empty", None),
            ("blank.json", b" \r\n\t ", False, "file is empty", None),
            ("emptyobj.json", b"{}", True, None, "record 1 has no fields"),
            ("looksq.json", json.dumps(TRIAGE).encode(), True, None, "looks like a question file"),
            ("surrogate.json", b'{"a": "\\ud800"}', False, "lone surrogate", None),
            ("toolarge.json", b'{"a": "' + b"x" * library.MAX_BYTES + b'"}', False, "the limit is 1 MB", None),
        ]
        for name, data, ok, err, warn in cases:
            with self.subTest(name=name):
                self.write("inputs", name, data)
                out = self.an("inputs", name)
                self.assertEqual(out["ok"], ok, out["error"])
                if err:
                    self.assertIn(err, out["error"]["message"])
                if warn:
                    self.assertTrue(any(warn in w for w in out["warnings"]), out["warnings"])
                if ok and not warn:
                    self.assertEqual(out["warnings"], [])
        nan = self.an("inputs", "nan.json")["error"]
        self.assertEqual((nan["line"], nan["col"]), (2, 7))  # the real NaN, not the one inside a string
        self.assertEqual(self.an("inputs", "bom.json")["inputs"]["records"], [{"a": "б"}])
        self.assertEqual(self.an("inputs", "bigint.json")["inputs"]["records"][0]["id"], 12345678901234567890)


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
