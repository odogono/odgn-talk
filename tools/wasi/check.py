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
        return json.loads(self.raw_reply(packed))

    def raw_reply(self, packed):
        # wasmtime represents i64 as signed; unpack the underlying u64 bits.
        packed &= (1 << 64) - 1
        pointer, size = packed >> 32, packed & 0xFFFFFFFF
        assert pointer > 0 and size > 0, (pointer, size)
        assert pointer + size <= self.memory.data_len(self.store)
        # Copy the reply before another export can replace it. Memory.read/write
        # fetch the current memory base, including after a Go memory.grow.
        return bytes(self.memory.read(self.store, pointer, pointer + size))

    def frame(self, data):
        return json.loads(self.frame_raw(data))

    def frame_raw(self, data):
        pointer = self.exports["talk_buffer"](self.store, len(data)) & 0xFFFFFFFF
        assert pointer > 0
        self.memory.write(self.store, data, pointer)
        return self.raw_reply(self.exports["talk_send"](self.store, len(data)))

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


def check_instance_memory(engine, module):
    # #585: compiling the stdlib on the first Group used to permanently grow
    # each fresh instance past 16 MiB, even for an empty Handler.
    measurements = []
    # Exercise independent Go map seeds: randomized stdlib compilation order
    # could push some otherwise identical instances over the limit.
    for _ in range(12):
        h = Host(engine, module)
        h.ok("hello", protocol=1)
        h.ok("new-group", group="g", name="g")
        h.ok("load", group="g", name="s", source="on ping\nend ping\n")
        h.ok("deliver", group="g", to={"script": "s"}, message={"name": "ping"})
        end = run_end(h.send("pump", group="g", now="2026-10-10T12:00:00Z"))
        assert end["outcome"] == "completed", end
        size = h.memory.data_len(h.store)
        assert size <= 16 << 20, f"fresh instance holds {size} bytes (>16 MiB)"
        measurements.append(size)
    return measurements


def check(engine, module):
    # The reactor has only WASI imports; Host operations need no callbacks.
    assert all(i.module == "wasi_snapshot_preview1" for i in module.imports)
    h = Host(engine, module)
    hello = h.ok("hello", protocol=1)
    assert hello["core"].startswith(("go/", "zig/")), hello
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

    # Frames and Values have no transport nesting cap. Use raw reply bytes
    # beyond Python's own JSON nesting ceiling; do not mistake a Host decoder
    # limit for a reactor refusal. Error data must preserve the entire Value.
    for opening, closing in (("[", "]"), ('{"a":', "}")):
        for depth in (63, 64, 10_000, 100_000):
            value = opening * depth + "1" + closing * depth
            frame = ('{"m":"hello","ref":1,"protocol":1,"ignored":' + value + '}').encode()
            assert "ok" in h.frame(frame)
            frame = ('{"m":"add","ref":1,"a":' + value + ',"b":1}').encode()
            reply = h.frame_raw(frame)
            assert b'"wrong kind"' in reply and value.encode() in reply
            # Malformed deep input is still refused, and the instance recovers.
            assert h.frame(frame[:-1])["err"]["kind"] == "protocol error"
            assert h.ok("add", a=20, b=22)["value"] == 42

    # Force memory growth while keeping a reply reachable through Go's GC.
    # JSON whitespace pads a valid frame without growing Script state.
    # Use a fresh instance: the deep-input checks may already have grown h's
    # memory beyond the size this allocation is meant to cross.
    growth = Host(engine, module)
    retained = growth.exports["talk_send"](growth.store, 0)
    previous = growth.read_reply(retained)
    before = growth.memory.data_len(growth.store)
    large = b' {"m":"hello","ref":100,"protocol":1}' + b" " * (16 << 20)
    pointer = growth.exports["talk_buffer"](growth.store, len(large)) & 0xFFFFFFFF
    assert pointer > 0
    assert growth.memory.data_len(growth.store) > before
    assert growth.read_reply(retained) == previous
    growth.memory.write(growth.store, large, pointer)
    assert growth.reply(len(large))["ok"] == hello
    assert growth.ok("hello", protocol=1) == hello

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
    deep_result = (
        '{"m":"op-result","ref":' + str(h.ref) + ',"result":'
        + '[' * 100_000 + '1' + ']' * 100_000
    ).encode()
    rejected = h.frame(deep_result)
    assert rejected["err"]["kind"] == "protocol error", rejected
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

    # Round-trip a Host-provided Value through a real Run and an immediate
    # Host exchange, well beyond encoding/json's former ceiling. This also
    # exercises Group ownership, Trace rendering, logical size and AnyShape.
    exchange = Host(engine, module)
    exchange.ok("define-capability", name="echo", ops=[
        {"name": "echo", "mode": "immediate", "args": ["any"],
         "result": "any", "cost": {"fuel": 1}}
    ])
    grant = exchange.ok("grant", capability="echo", ops="all")["grant"]
    exchange.ok("new-group", group="g", name="g", trace=True)
    exchange.ok("load", group="g", name="s", grants={"echo": grant},
                source="on echo v\nask echo to echo v\nreturn it\nend echo\n")
    deep = '[' * 20_000 + '1' + ']' * 20_000
    queued = exchange.frame((
        '{"m":"request","ref":1,"group":"g","to":{"script":"s"},'
        '"message":{"name":"echo","args":[' + deep + ']}}'
    ).encode())
    assert "ok" in queued, queued
    need = exchange.frame_raw((
        '{"m":"pump","ref":2,"group":"g","now":"' + now + '"}'
    ).encode())
    assert b'"need"' in need and deep.encode() in need
    ended = exchange.frame_raw((
        '{"m":"op-result","ref":2,"result":' + deep + '}'
    ).encode())
    assert b'"completed"' in ended and deep.encode() in ended
    assert exchange.ok("add", a=20, b=22)["value"] == 42

    # Script-produced Values are equally deep on outbound frames.
    # Exercise both an interim Operation's args and a final Report's result.
    h.ok(
        "define-capability", name="sink",
        ops=[{"name": "take", "mode": "immediate", "args": ["any"],
              "result": "number", "cost": {"fuel": 1}}],
    )
    grant = h.ok("grant", capability="sink", ops="all")["grant"]
    h.ok(
        "load", group="g", name="deep-reply", grants={"sink": grant},
        source="""on go
  put 1 into v
  repeat 200 times
    put [v] into v
  end repeat
  ask sink to take v
  return v
end go
""",
    )
    h.ok("request", group="g", to={"script": "deep-reply"}, message={"name": "go"})
    def check_value(value):
        for _ in range(200):
            assert isinstance(value, list) and len(value) == 1
            value = value[0]
        assert value == 1
    need = h.send("pump", group="g", now=now)["need"]
    check_value(need["args"][0])
    end = run_end(h.send("op-result", is_result=True, result=42))
    assert end["outcome"] == "completed", end
    check_value(end["result"])
    assert h.ok("add", a=20, b=22)["value"] == 42
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
    instance_memory = check_instance_memory(engine, module)
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
                "instanceMemoryBytes": instance_memory,
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
