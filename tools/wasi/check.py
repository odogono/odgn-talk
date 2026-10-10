# /// script
# requires-python = ">=3.11"
# dependencies = ["wasmtime==49.0.0", "brotli==1.2.0"]
# ///
"""Check the Message Layer reactor in wasmtime and measure its payload.

Build as documented in impl/go/README.md, then run:
    uv run tools/wasi/check.py .cache/messagelayer.wasm

The Python bindings use the wasmtime C API:
https://bytecodealliance.github.io/wasmtime-py/
"""

import gzip
import hashlib
import importlib.metadata
import json
import sys
import time
import zlib
from pathlib import Path

import brotli
import wasmtime


class Host:
    def __init__(self, engine, module, *, memory_limit=None):
        self.store = wasmtime.Store(engine)
        if memory_limit is not None:
            self.store.set_limits(memory_size=memory_limit)
        wasi = wasmtime.WasiConfig()
        wasi.inherit_stderr()
        self.store.set_wasi(wasi)
        linker = wasmtime.Linker(engine)
        linker.define_wasi()
        instance = linker.instantiate(self.store, module)
        self.exports = instance.exports(self.store)
        self.exports["_initialize"](self.store)
        self.memory = self.exports["memory"]
        self.ref = 0

    def reply(self, length):
        return self.read_reply(self.exports["talk_send"](self.store, length))

    def read_reply(self, packed):
        # wasmtime represents i64 as signed; unpack the underlying u64 bits.
        packed &= (1 << 64) - 1
        pointer, size = packed >> 32, packed & 0xFFFFFFFF
        assert pointer > 0 and size > 0, (pointer, size)
        assert pointer + size <= self.memory.data_len(self.store)
        # Copy the reply before another export can replace it. Memory.read/write
        # fetch the current memory base, including after a Go memory.grow.
        return json.loads(self.memory.read(self.store, pointer, pointer + size))

    def frame(self, data):
        pointer = self.exports["talk_buffer"](self.store, len(data)) & 0xFFFFFFFF
        assert pointer > 0
        self.memory.write(self.store, data, pointer)
        return self.reply(len(data))

    def send(self, message, /, *, is_result=False, **fields):
        if not is_result:
            self.ref += 1
        frame = json.dumps({"m": message, "ref": self.ref, **fields}).encode()
        reply = self.frame(frame)
        assert reply["ref"] == self.ref, reply
        return reply

    def ok(self, message, /, **fields):
        reply = self.send(message, **fields)
        assert "ok" in reply, reply
        return reply["ok"]


def run_end(reply):
    assert "ok" in reply, reply
    ends = [r for r in reply["ok"]["reports"] if r["kind"] == "run end"]
    assert len(ends) == 1, reply
    return ends[0]


def check(engine, module):
    # The reactor has only WASI imports; Host operations need no callbacks.
    assert all(i.module == "wasi_snapshot_preview1" for i in module.imports)
    h = Host(engine, module)
    hello = h.ok("hello", protocol=1)
    assert hello["core"].startswith("go/"), hello
    assert all(hello[k] for k in ("language", "costModel", "unicode", "saveFormat"))
    assert h.send("hello", protocol=2)["err"]["kind"] == "protocol error"

    # Invalid lengths, including an i32 whose high bit is set, never slice
    # beyond the buffer or trap. A later valid request still works.
    assert h.reply(1)["err"]["kind"] == "protocol error"
    for length in (0, (64 << 20) + 1, 0xFFFFFFFF):
        assert h.exports["talk_buffer"](h.store, length) == 0
        assert h.reply(length)["err"]["kind"] == "protocol error"
    assert h.frame(b"{")["err"]["kind"] == "protocol error"
    assert h.ok("add", a=20, b=22)["value"] == 42

    # Hostile nesting must be refused before it exhausts wasmtime's stack.
    # A good request after each refusal proves the same instance remains usable.
    for opening, closing in (("[", "]"), ('{"a":', "}")):
        for depth in (63, 64, 100_000):
            value = opening * depth + "1" + closing * depth
            frame = ('{"m":"hello","ref":1,"protocol":1,"ignored":' + value + '}').encode()
            reply = h.frame(frame)
            if depth == 63:  # The envelope is the 64th level.
                assert "ok" in reply, reply
                frame = ('{"m":"add","ref":1,"a":' + value + ',"b":1}').encode()
                decoded = h.frame(frame)  # Decode the value, then refuse its kind.
                assert decoded["ok"]["fail"]["code"] == "wrong kind", decoded
            else:
                assert reply["err"]["kind"] == "protocol error", reply
            assert h.ok("add", a=20, b=22)["value"] == 42

    # Force memory growth while keeping a reply reachable through Go's GC.
    # JSON whitespace pads a valid frame without growing Script state.
    retained = h.exports["talk_send"](h.store, 0)
    previous = h.read_reply(retained)
    before = h.memory.data_len(h.store)
    large = b' {"m":"hello","ref":100,"protocol":1}' + b" " * (16 << 20)
    pointer = h.exports["talk_buffer"](h.store, len(large)) & 0xFFFFFFFF
    assert pointer > 0
    assert h.memory.data_len(h.store) > before
    assert h.read_reply(retained) == previous
    h.memory.write(h.store, large, pointer)
    assert h.reply(len(large))["ok"] == hello
    assert h.ok("hello", protocol=1) == hello

    h.ok(
        "define-capability",
        name="api",
        ops=[
            {
                "name": "double",
                "mode": "immediate",
                "args": ["number"],
                "result": "number",
                "cost": {"fuel": 7},
            },
            {
                "name": "fetch",
                "mode": "suspending",
                "result": "number",
                "maxPending": 5000,
            },
        ],
    )
    grant = h.ok("grant", capability="api", ops="all")["grant"]
    h.ok("new-group", group="g", name="g", trace=True)
    expressions = [
        "(" * 100_000 + "1" + ")" * 100_000,
        "[" * 100_000 + "1" + "]" * 100_000,
        "{a:" * 100_000 + "1" + "}" * 100_000,
        "f(" * 100_000 + "1" + ")" * 100_000,
        "- " * 100_000 + "1",
        "not " * 100_000 + "true",
        "1 ^ " * 100_000 + "1",
        "1 + " * 100_000 + "1",
        "the a of " * 100_000 + "1",
        "1" + "'s a" * 100_000,
        "given x: " * 100_000 + "1",
        "`" + "${`" * 1000 + "x" + "`}" * 1000 + "`",
        "<" + "1 " * 100_000 + "digit>",
        "<" + "x:" * 100_000 + "digit>",
        "<" * 100_000 + "digit" + ">" * 100_000,
    ]
    sources = ["on deep\nreturn " + e + "\nend deep\n" for e in expressions]
    for opening, closing in (
        ("if true then\n", "end if\n"),
        ("repeat forever\n", "end repeat\n"),
    ):
        sources.append("on deep\n" + opening * 10_000 + closing * 10_000 + "end deep\n")
    sources.append("on deep\nlet " + "[" * 100_000 + "x" + "]" * 100_000 + " be []\nend deep\n")
    for source in sources:
        reply = h.send("load", group="g", name="deep", source=source)
        assert reply["err"]["kind"] == "load error", reply
        diagnostic = reply["err"]["diagnostics"][0]
        assert diagnostic["code"] == "source nesting too deep", reply
        assert diagnostic["unit"] == "deep" and diagnostic["line"] > 0 and diagnostic["col"] > 0, reply
        assert h.ok("add", a=20, b=22)["value"] == 42
    # Ordinary nesting still reaches checking, lowering and execution.
    h.ok(
        "load", group="g", name="deep",
        source="on go\nreturn " + "(" * 61 + "42" + ")" * 61 + "\nend go\n",
    )
    h.ok("request", group="g", to={"script": "deep"}, message={"name": "go"})
    nested = run_end(h.send("pump", group="g", now="2026-10-10T12:00:00Z"))
    assert nested["outcome"] == "completed" and nested["result"] == 42, nested
    h.ok(
        "load",
        group="g",
        name="s",
        grants={"api": grant},
        limits={"fuelPerRun": 1000},
        source="""on double n
  ask api to double n
  return it + 1
end double
on fetch
  ask api to fetch and wait
  return it
end fetch
on bad
  return 1 / 0
end bad
""",
    )
    now = "2026-10-10T12:00:00Z"
    h.ok(
        "request",
        group="g",
        to={"script": "s"},
        message={"name": "double", "args": [20]},
    )
    need = h.send("pump", group="g", now=now)["need"]
    assert need["m"] == "op" and need["args"] == [20], need
    assert 0 < need["fuelLeft"] < 1000, need
    # Bad exchanges leave the parked worker available for the right result.
    assert (
        h.send("hello", is_result=True, protocol=1)["err"]["kind"] == "protocol error"
    )
    wrong_ref = json.dumps(
        {"m": "op-result", "ref": h.ref + 100, "result": 40}
    ).encode()
    assert h.frame(wrong_ref)["err"]["kind"] == "protocol error"
    done = h.send("op-result", is_result=True, result=40, charged=3)
    end = run_end(done)
    assert end["outcome"] == "completed" and end["result"] == 41, end
    assert any("charged=3" in line for line in done["ok"]["trace"]), done

    h.ok("request", group="g", to={"script": "s"}, message={"name": "fetch"})
    need = h.send("pump", group="g", now=now)["need"]
    assert need["mode"] == "suspending", need
    parked = h.send("op-result", is_result=True, started=True)["ok"]
    assert not any(r["kind"] == "run end" for r in parked["reports"]), parked
    h.ok("answer", group="g", call=need["call"], value=37)
    end = run_end(h.send("pump", group="g", now=now))
    assert end["outcome"] == "completed" and end["result"] == 37, end

    h.ok("request", group="g", to={"script": "s"}, message={"name": "bad"})
    end = run_end(h.send("pump", group="g", now=now))
    assert end["outcome"] == "errored" and end["error"]["code"] == "division by zero", (
        end
    )
    assert h.ok("hello", protocol=1) == hello
    h.ok(
        "request",
        group="g",
        to={"script": "s"},
        message={"name": "double", "args": [1]},
    )
    assert h.send("pump", group="g", now=now)["need"]["operation"] == "double"
    end = run_end(h.send("op-result", is_result=True, result=2))
    assert end["outcome"] == "completed" and end["result"] == 3, end
    assert "$bytes" in h.ok("save", group="g")["save"]
    assert "$bytes" in h.ok("fingerprint", group="g")["fingerprint"]

    # Another instance starts with an independent Session and handle table.
    other = Host(engine, module)
    assert other.ok("hello", protocol=1) == hello
    assert (
        other.send("counters", group="g", script="s")["err"]["kind"] == "protocol error"
    )
    other.ok("new-group", group="g", name="g")
    return hello


def check_hostile_loads(engine, module):
    # #583: these inputs exhausted a 1 GiB instance, or held it for minutes.
    # Use a fresh instance for each so memory growth measures that Load.
    sources = {
        "blank": "\n" * (1 << 20),
        "handlers": "".join(f"on h{i}\nend h{i}\n" for i in range(100_000)),
        "chain": "on sum\nreturn 1" + " + 1" * 99_999 + "\nend sum\n",
        "powers": "on sum\nreturn 1" + " ^ 1" * 99_999 + "\nend sum\n",
    }
    measurements = {}
    for name, source in sources.items():
        h = Host(engine, module, memory_limit=1 << 30)
        h.ok("new-group", group="g", name="g")
        before = h.memory.data_len(h.store)
        start = time.perf_counter()
        reply = h.send("load", group="g", name=name, source=source)
        if name in ("chain", "powers"):
            assert reply["err"]["kind"] == "load error", reply
            diagnostics = reply["err"]["diagnostics"]
            assert len(diagnostics) == 1, reply
            assert diagnostics[0]["code"] == "source nesting too deep", reply
        else:
            assert "ok" in reply, reply
        elapsed = time.perf_counter() - start
        assert h.ok("add", a=20, b=22)["value"] == 42
        measurements[name] = {
            "sourceBytes": len(source.encode()),
            "outcome": "source nesting too deep" if "err" in reply else "loaded",
            "seconds": round(elapsed, 3),
            "memoryGrowthBytes": h.memory.data_len(h.store) - before,
        }
    return measurements


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: uv run tools/wasi/check.py path/to/messagelayer.wasm")
    path = Path(sys.argv[1])
    payload = path.read_bytes()
    engine = wasmtime.Engine()
    module = wasmtime.Module(engine, payload)
    hello = check(engine, module)
    hostile_loads = check_hostile_loads(engine, module)
    compressed = brotli.compress(payload, quality=11)
    zipped = gzip.compress(payload, compresslevel=9, mtime=0)
    assert brotli.decompress(compressed) == payload
    assert gzip.decompress(zipped) == payload
    print(
        json.dumps(
            {
                "wasm": str(path),
                "sha256": hashlib.sha256(payload).hexdigest(),
                "wasmtime": importlib.metadata.version("wasmtime"),
                "brotli": importlib.metadata.version("brotli"),
                "python": sys.version.split()[0],
                "zlib": zlib.ZLIB_RUNTIME_VERSION,
                "hello": hello,
                "checks": "passed",
                "hostileLoads": hostile_loads,
                "bytes": {
                    "raw": len(payload),
                    "gzip9": len(zipped),
                    "brotli11": len(compressed),
                },
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
