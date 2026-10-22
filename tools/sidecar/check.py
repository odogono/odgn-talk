"""Executable checks for the native Zig Message Layer (stdlib Python only).

python3 tools/sidecar/check.py impl/zig/zig-out/bin/messagelayer
The dispatcher also has unit coverage in impl/zig/src/message.zig. These
checks exercise the same contracts through pipes, including paused refs.
"""

import json
import os
import selectors
import struct
import subprocess
import sys
import time
import unittest
from pathlib import Path

MAX_FRAME = 64 << 20
NOW = "2026-10-10T12:00:00Z"
BINARY = Path(sys.argv.pop(1)).resolve() if len(sys.argv) > 1 else Path(
    "impl/zig/zig-out/bin/messagelayer"
).resolve()


class Sidecar:
    def __init__(self):
        self.process = subprocess.Popen(
            [str(BINARY)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, bufsize=0,
        )
        self.ref = 0

    def write(self, data):
        while data:
            n = self.process.stdin.write(data)
            assert n, "sidecar stopped reading"
            data = memoryview(data)[n:]

    def read(self, n):
        data = bytearray()
        deadline = time.monotonic() + 30
        with selectors.DefaultSelector() as selector:
            selector.register(self.process.stdout, selectors.EVENT_READ)
            while len(data) < n:
                assert selector.select(max(0, deadline - time.monotonic())), "reply not flushed"
                chunk = os.read(self.process.stdout.fileno(), n - len(data))
                assert chunk, "sidecar exited before its reply"
                data.extend(chunk)
        return bytes(data)

    def reply_raw(self):
        size, = struct.unpack(">I", self.read(4))
        return self.read(size)

    def frame_raw(self, data):
        self.write(struct.pack(">I", len(data)))
        self.write(data)
        return self.reply_raw()

    def frame(self, data):
        return json.loads(self.frame_raw(data))

    def send(self, m, *, ref=None, **fields):
        if ref is None:
            self.ref += 1
            ref = self.ref
        reply = self.frame(json.dumps(dict(m=m, ref=ref, **fields)).encode())
        assert reply["ref"] == ref, reply
        return reply

    def ok(self, m, **fields):
        reply = self.send(m, **fields)
        assert "ok" in reply, reply
        return reply["ok"]

    def close(self):
        self.process.stdin.close()
        try:
            status = self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
            raise
        finally:
            self.process.stdout.close()
        stderr = self.process.stderr.read()
        self.process.stderr.close()
        return status, stderr


def run_end(reply):
    ends = [r for r in reply["ok"]["reports"] if r["kind"] == "run end"]
    assert len(ends) == 1, reply
    return ends[0]


class Checks(unittest.TestCase):
    def setUp(self):
        self.h = Sidecar()

    def tearDown(self):
        status, stderr = self.h.close()
        self.assertEqual((status, stderr), (0, b""))

    def group(self):
        self.h.ok("new-group", group="g", name="g", trace=True)

    def load(self, source, **fields):
        self.h.ok("load", group="g", name="s", source=source, **fields)

    def request(self, **fields):
        self.h.ok("request", group="g", to={"script": "s"}, message={"name": "go", **fields})

    def pump(self):
        return self.h.send("pump", group="g", now=NOW)

    def capability(self, mode="immediate", **fields):
        op = dict(name="read", mode=mode, args=[], result="number", **fields)
        if mode == "suspending":
            op["maxPending"] = 5000
        self.h.ok("define-capability", name="api", ops=[op])
        return self.h.ok("grant", capability="api", ops="all")["grant"]

    def paused(self, mode="immediate", **fields):
        grant = self.capability(mode, **fields)
        self.group()
        wait = " and wait" if mode == "suspending" else ""
        self.load(f"script variable n=0\non go\n put 9 into n\n ask api to read{wait}\n put it into n\n return n\nend go", grants={"api": grant})
        self.request()
        reply = self.pump()
        self.assertEqual(reply["need"]["m"], "op")
        return reply

    def test_frames_refs_and_clean_eof(self):
        hello = self.h.ok("hello", protocol=1)
        self.assertTrue(hello["core"].startswith("zig/"), hello)
        self.assertIn("paused-inputs-v1", hello["features"])
        # Every response arrives with stdin open; an absent flush times out.
        for ref in (0, -5, 9007199254740991, "9007199254740992"):
            self.assertEqual(self.h.send("add", ref=ref, a=20, b=22)["ok"]["value"], 42)
        for frame in (b"", b"{", b"[]", b"\xff", b'{"m":"hello","ref":8,"protocol":1}x'):
            self.assertEqual(self.h.frame(frame)["err"]["kind"], "protocol error")
        self.assertEqual(self.h.ok("add", a=20, b=22)["value"], 42)
        # Arbitrary pipe boundaries and pipelined frames cannot affect framing.
        frame = b'{"m":"add","ref":81,"a":20,"b":22}'
        for byte in struct.pack(">I", len(frame)) + frame:
            self.h.write(bytes([byte]))
        self.assertEqual(json.loads(self.h.reply_raw())["ref"], 81)
        frames = [json.dumps(dict(m="add", ref=ref, a=20, b=22)).encode() for ref in (82, 83)]
        self.h.write(b"".join(struct.pack(">I", len(f)) + f for f in frames))
        for ref in (82, 83):
            self.assertEqual(json.loads(self.h.reply_raw()), dict(ref=ref, ok=dict(value=42)))

    def test_deep_json_values_and_pending_exchange_recovery(self):
        for opening, closing in ((b"[", b"]"), (b'{"a":', b"}")):
            value = opening * 100_000 + b"1" + closing * 100_000
            self.assertIn("ok", self.h.frame(b'{"m":"hello","ref":1,"protocol":1,"ignored":' + value + b"}"))
            reply = self.h.frame_raw(b'{"m":"add","ref":1,"a":' + value + b',"b":1}')
            self.assertIn(b'"wrong kind"', reply)
            self.assertIn(value, reply)
            self.assertEqual(self.h.frame(b'{"ignored":' + value)["err"]["kind"], "protocol error")
        paused = self.paused()
        ref = paused["ref"]
        self.assertEqual(self.h.frame(b'{"m":"op-result","group":"g","ref":1,"result":' + b"[" * 100_000)["err"]["kind"], "protocol error")
        self.assertEqual(self.h.send("op-result", group="g", ref=ref + 100, result=7)["err"]["kind"], "protocol error")
        self.assertEqual(run_end(self.h.send("op-result", group="g", ref=ref, result=42))["result"], 42)

    def test_callback_result_group_refusals(self):
        self.h.ok("new-group", group="other")
        paused = self.paused()
        for fields in ({}, {"group": None}, {"group": 7}, {"group": "unknown"}, {"group": "other"}):
            with self.subTest(fields=fields):
                reply = self.h.send("op-result", ref=paused["ref"], result=42, **fields)
                self.assertEqual(reply["err"]["kind"], "protocol error")
        self.assertEqual(run_end(self.h.send("op-result", group="g", ref=paused["ref"], result=42))["result"], 42)
        self.assertEqual(self.h.ok("inspect", group="g")["scripts"][0]["vars"], [["n", 42]])

    def test_frame_limit_and_bounded_oversize_drain(self):
        self.group()
        # The exact 64 MiB boundary is accepted.
        frame = b'{"m":"hello","ref":1,"protocol":1}'
        self.h.write(struct.pack(">I", MAX_FRAME))
        self.h.write(frame)
        chunk = b" " * (64 << 10)
        remaining = MAX_FRAME - len(frame)
        while remaining:
            n = min(remaining, len(chunk))
            self.h.write(chunk[:n])
            remaining -= n
        self.assertIn("ok", json.loads(self.h.reply_raw()))
        self.h.write(struct.pack(">I", MAX_FRAME + 1))
        for _ in range(MAX_FRAME // len(chunk)):
            self.h.write(chunk)
        self.h.write(b" ")
        reply = json.loads(self.h.reply_raw())
        self.assertEqual((reply["ref"], reply["err"]["kind"]), (-1, "protocol error"))
        self.load("on go\nreturn 42\nend go") # same Session survives
        self.request()
        self.assertEqual(run_end(self.pump())["result"], 42)

    def test_truncation_has_failure_status_and_stderr(self):
        for data, diagnostic in (
            (b"\0", b"TruncatedFrameHeader"),
            (b"\0\0\0", b"TruncatedFrameHeader"),
            (struct.pack(">I", 9) + b"{", b"TruncatedFrameBody"),
            (struct.pack(">I", MAX_FRAME + 1) + b"x", b"TruncatedOversizedFrame"),
        ):
            with self.subTest(diagnostic=diagnostic):
                p = subprocess.run([str(BINARY)], input=data, capture_output=True, timeout=30)
                self.assertNotEqual(p.returncode, 0)
                self.assertEqual(p.stdout, b"")
                self.assertIn(b"messagelayer: " + diagnostic, p.stderr)

    def test_immediate_value_encoding_round_trip(self):
        self.h.ok("define-capability", name="echo", ops=[dict(name="echo", mode="immediate", args=["any"], result="any")])
        grant = self.h.ok("grant", capability="echo", ops="all")["grant"]
        self.group()
        self.load("on go x\nask echo to echo x\nreturn it\nend go", grants={"echo": grant})
        value = {"items": [{"$bytes": "AAH/"}, {"$dec": "1.25"}, [True, None, "héllo"]]}
        self.request(args=[value])
        paused = self.pump()
        self.assertEqual(paused["need"]["args"], [value])
        self.assertEqual(run_end(self.h.send("op-result", group="g", ref=paused["ref"], result=value))["result"], value)

        # Trace, argument admission, interim needs and results retain deep
        # Values; inspect the bytes to avoid Python's own JSON depth ceiling.
        nested = b"[" * 20_000 + b"1" + b"]" * 20_000
        request = b'{"m":"request","ref":90,"group":"g","to":{"script":"s"},"message":{"name":"go","args":[' + nested + b']}}'
        self.assertIn("ok", self.h.frame(request))
        need = self.h.frame_raw(b'{"m":"pump","ref":91,"group":"g","now":"' + NOW.encode() + b'"}')
        self.assertIn(b'"args":[' + nested + b']', need)
        done = self.h.frame_raw(b'{"m":"op-result","group":"g","ref":91,"result":' + nested + b'}')
        self.assertIn(b'"result":' + nested, done)
        self.assertIn(b'"completed"', done)

    def test_suspending_start_accepts_answer_and_charge_then_next_pump(self):
        paused = self.paused("suspending", metering="read-only")
        call = paused["need"]["call"]
        self.assertEqual(self.h.ok("request-charge", group="g", call=call, fuel=1)["request"], "q1")
        self.h.ok("answer", group="g", call=call, value=42)
        parked = self.h.ok("op-result", group="g", ref=paused["ref"], started=True)
        self.assertFalse(any(r["kind"] == "run end" for r in parked["reports"]))
        done = self.pump()
        self.assertEqual(run_end(done)["result"], 42)
        self.assertEqual(done["ok"]["reports"][0]["status"], "accepted")

    def test_paused_stop_cancel_and_rewind_roll_back(self):
        for mode in ("immediate", "suspending"):
            for control, state in (("stop", "stopped"), ("cancel-run", "idle"), ("rewind-run", "rewound")):
                with self.subTest(mode=mode, control=control):
                    h = self.h
                    self.h = Sidecar()
                    try:
                        paused = self.paused(mode)
                        self.h.ok(control, group="g", script="s", run="s/r1", reason="crossing")
                        outcome = {"started": True} if mode == "suspending" else {"result": "wrong shape"}
                        done = self.h.ok("op-result", group="g", ref=paused["ref"], **outcome)
                        self.assertEqual(done["state"], state)
                        scripts = self.h.ok("inspect", group="g")["scripts"]
                        self.assertEqual(scripts[0]["vars"], [["n", 0]])
                        if control == "rewind-run":
                            self.assertEqual(len(scripts[0]["mailbox"]), 1)
                    finally:
                        closed = self.h.close()
                        self.h = h
                        self.assertEqual(closed, (0, b""))

    def test_property_stop_lands_before_conversion(self):
        self.h.ok("define-object-kind", name="box", props=[dict(name="value", shape="number")])
        self.group()
        self.h.ok("object", group="g", kind="box", id="one")
        self.load("script variable n=0\non go o\nput 9 into n\nput the value of o into n\nend go")
        self.request(args=[{"$object": ["box", "one"]}])
        paused = self.pump()
        self.assertEqual(paused["need"]["m"], "prop")
        self.assertEqual(self.h.send("inspect", group="g")["err"]["code"], "reentrant call")
        self.h.ok("stop", group="g", script="s", reason="property")
        self.assertEqual(self.h.ok("prop-result", group="g", ref=paused["ref"], value="wrong shape")["state"], "stopped")
        self.assertEqual(self.h.ok("inspect", group="g")["scripts"][0]["vars"], [["n", 0]])

    def test_save_restore_pending_call_on_fresh_process(self):
        paused = self.paused("suspending")
        self.h.ok("op-result", group="g", ref=paused["ref"], started=True)
        saved = self.h.ok("save", group="g")["save"]
        self.assertEqual(self.h.close(), (0, b""))
        self.h = Sidecar()
        grant = self.capability("suspending")
        reply = self.h.send("restore", group="restored", name="g", save=saved)
        self.assertEqual(reply["need"]["m"], "resolve")
        restored = self.h.ok("resolve-result", ref=reply["ref"], grants=[grant], objects=[])
        self.assertFalse(restored["variablesOnly"])
        call = restored["pending"][0]["call"]
        self.h.ok("settle", group="restored", call=call, settlement={"answer": 42})
        self.assertEqual(run_end(self.h.send("pump", group="restored", now=NOW))["result"], 42)

    def test_effect_cleanup_release_and_paused_input(self):
        ops = [dict(name="open", mode="immediate", result="nothing", segmentBound=True,
                    scope={"opens": "file", "abandon": "close"}),
               dict(name="close", mode="immediate", result="nothing", segmentBound=True,
                    scope={"closes": "file"})]
        self.h.ok("define-capability", name="resource", segmentLifecycle=True, release=True, ops=ops)
        grant = self.h.ok("grant", capability="resource", ops="all")["grant"]
        self.group()
        self.load("on go\nask r to open\nreturn 42\nend go", grants={"r": grant})
        self.request()
        reply = self.pump()
        ref = reply["ref"]
        self.assertEqual(reply["need"]["phase"], "begin")
        reply = self.h.send("effect-result", group="g", ref=ref, status="ok")
        self.assertEqual(reply["need"]["operation"], "open")
        reply = self.h.send("op-result", group="g", ref=ref, result=None)
        self.assertEqual(reply["need"]["operation"], "close")
        self.assertTrue(reply["need"]["automatic"])
        reply = self.h.send("op-result", group="g", ref=ref, result=None)
        self.assertEqual(reply["need"]["phase"], "commit")
        self.assertEqual(run_end(self.h.send("effect-result", group="g", ref=ref, status="ok"))["result"], 42)
        # Cancellation while a resource is open closes it, rolls back, then
        # releases the Grant, all before the enclosing Pump returns.
        self.request()
        reply = self.pump()
        ref = reply["ref"]
        reply = self.h.send("effect-result", group="g", ref=ref, status="ok")
        self.assertEqual(reply["need"]["operation"], "open")
        self.h.ok("stop", group="g", script="s", reason="cleanup")
        reply = self.h.send("op-result", group="g", ref=ref, result=None)
        self.assertEqual(reply["need"]["operation"], "close")
        reply = self.h.send("op-result", group="g", ref=ref, result=None)
        self.assertEqual(reply["need"]["phase"], "rollback")
        reply = self.h.send("effect-result", group="g", ref=ref, status="ok")
        self.assertEqual(reply["need"]["m"], "release")
        self.assertEqual(self.h.send("inspect", group="g")["err"]["code"], "reentrant call")
        self.assertEqual(self.h.ok("release-result", group="g", ref=ref)["state"], "stopped")


if __name__ == "__main__":
    unittest.main(verbosity=2)
