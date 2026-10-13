# /// script
# requires-python = ">=3.11"
# dependencies = ["wasmtime==49.0.0", "brotli==1.2.0"]
# ///
"""Run the Zig Core's wasm32-wasi build in wasmtime and measure it.

It drives talk.h's exports directly: a Core, a Group, a small Script and
one Pump, as tools/wasi/check.py measures the Go reactor (ADR 0078), and
then the Message Layer's talk_buffer/talk_send through one Operation
round trip and a fault (issue #635); check.py runs the same module
unchanged for the full protocol check. Build with
`zig build -Dtarget=wasm32-wasi` in impl/zig, then run:
    uv run tools/wasi/zig.py impl/zig/zig-out/bin/talk.wasm

The Python bindings use the wasmtime C API:
https://bytecodealliance.github.io/wasmtime-py/
"""

import gzip
import hashlib
import importlib.metadata
import json
import struct
import sys
import time
import tomllib
import zlib
from pathlib import Path

import brotli
import wasmtime

# talk_host_error_code's TALK_OK, TALK_LOAD_REFUSED and TALK_OUT_OF_MEMORY.
OK = 0
LOAD_REFUSED = 20
OUT_OF_MEMORY = 21


class Host:
    """One instance, called through talk.h. wasm32 pointers and size_t are
    32 bits, so the structs below are packed by hand to talk.h's layout."""

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
        self.memory = self.exports["memory"]

    def call(self, name, *args):
        return self.exports[name](self.store, *args)

    def alloc(self, data):
        """Copies bytes into the instance's memory, from talk_alloc."""
        pointer = self.call("talk_alloc", max(len(data), 1)) & 0xFFFFFFFF
        assert pointer > 0
        self.memory.write(self.store, data, pointer)
        return pointer

    def read(self, pointer, size):
        return self.memory.read(self.store, pointer, pointer + size)

    def out(self, size=8):
        """An out parameter, zeroed."""
        return self.alloc(bytes(size))

    def pointer_at(self, pointer):
        return struct.unpack("<I", self.read(pointer, 4))[0]

    def text(self, value):
        data = value.encode()
        return self.alloc(data), len(data)

    def new_group(self, core, cap=0):
        name, name_len = self.text("g")
        # talk_group_options: name, name_len, trace, trace_context,
        # allocator, memory_cap.
        options = self.alloc(struct.pack("<6I", name, name_len, 0, 0, 0, cap))
        out = self.out()
        assert self.call("talk_new_group", core, options, out) == OK
        return self.pointer_at(out)

    def load(self, group, name, source):
        name, name_len = self.text(name)
        source, source_len = self.text(source)
        # talk_load_options: name, name_len, source, source_len, grants,
        # grants_len, grants_as_used and its padding, owner, objects,
        # objects_len, limits.
        options = self.alloc(struct.pack("<6I?3x4I", name, name_len, source, source_len, 0, 0, False, 0, 0, 0, 0))
        out = self.out()
        code = self.call("talk_load", group, options, out)
        return code, self.pointer_at(out)

    def deliver(self, script, message):
        name, name_len = self.text(message)
        # talk_message: name, name_len, args, args_len, limits.
        packed = self.alloc(struct.pack("<5I", name, name_len, 0, 0, 0))
        return self.call("talk_script_deliver", script, packed, 0)

    def pump(self, group, seconds):
        # talk_pump_result: state, has_next_deadline, next_deadline_seconds
        # at 8, next_deadline_nanos at 16, fuel_used at 24, reports at 32.
        result = self.out(40)
        code = self.call("talk_pump", group, seconds, 0, 0, result)
        fuel = struct.unpack("<q", self.read(result + 24, 8))[0]
        reports = self.pointer_at(result + 32)
        self.call("talk_reports_release", reports)
        return code, fuel

    def group_memory(self, group):
        # talk_memory: used, peak, cap, refused.
        out = self.out(16)
        self.call("talk_group_memory", group, out)
        used, peak, cap, refused = struct.unpack("<3I?3x", self.read(out, 16))
        return {"used": used, "peak": peak, "cap": cap, "refused": refused}


# #532's thresholds for an instance under WASI, which ADR 0078 measures the
# Zig build against: memory per instance, and the payload.
MEMORY_LIMIT = 16 << 20
BROTLI_LIMIT = 3 << 20
RAW_LIMIT = 25 << 20


def instance_memory(engine, module, source="on ping\nend ping\n"):
    """Linear memory after a Core, a Group, a small Script and one Pump, the
    Go reactor's measurement (ADR 0078, docs/research)."""
    h = Host(engine, module)
    core = h.call("talk_new") & 0xFFFFFFFF
    assert core > 0
    group = h.new_group(core)
    code, script = h.load(group, "s", source)
    assert code == OK and script > 0, code
    assert h.deliver(script, "ping") == OK
    code, fuel = h.pump(group, 1791633600)
    assert code == OK, code
    # The Handler's empty clause: its `clause` charge and its return.
    assert fuel > 0, fuel
    size = h.memory.data_len(h.store)
    assert size <= MEMORY_LIMIT, f"an instance holds {size} bytes (> 16 MiB)"
    return {"linearMemory": size, "group": h.group_memory(group), "fuel": fuel}


def containment(engine, module):
    """A Script that doubles a text past the Group's physical cap: the Pump
    is refused, and the instance goes on to run a fresh Group."""
    h = Host(engine, module, memory_limit=64 << 20)
    core = h.call("talk_new") & 0xFFFFFFFF
    group = h.new_group(core, cap=1 << 20)
    source = 'script variable s\non grow\n  put "x" into s\n  repeat 40 times\n    put s & s into s\n  end repeat\nend grow\n'
    code, script = h.load(group, "hog", source)
    assert code == OK, code
    assert h.deliver(script, "grow") == OK
    code, _ = h.pump(group, 1791633600)
    assert code == OUT_OF_MEMORY, code
    memory = h.group_memory(group)
    assert memory["refused"] and memory["peak"] <= memory["cap"], memory
    h.call("talk_group_release", group)
    fresh = h.new_group(core)
    code, script = h.load(fresh, "s", "on ping\nend ping\n")
    assert code == OK, code
    assert h.deliver(script, "ping") == OK
    assert h.pump(fresh, 1791633600)[0] == OK
    return memory


def large_loads(engine, module):
    """#790: large honest sources load within a 256 MiB instance and retain
    source/code, rather than the front end's working storage. Time bounds
    leave room for slow CI Hosts, but catch the former ~80 s Handler load.
    Each measurement starts in a fresh instance."""
    sources = {
        "blank": "\n" * (1 << 20),
        "handlers50000": "".join(f"on h{i}\nend h{i}\n" for i in range(50_000)),
        "handlers100000": "".join(f"on h{i}\nend h{i}\n" for i in range(100_000)),
    }
    measured = {}
    for name, source in sources.items():
        h = Host(engine, module, memory_limit=256 << 20)
        core = h.call("talk_new") & 0xFFFFFFFF
        group = h.new_group(core)
        before = h.group_memory(group)["used"]
        start = time.perf_counter()
        code, script = h.load(group, name, source)
        elapsed = time.perf_counter() - start
        assert code == OK and script > 0, (name, code)
        memory = h.group_memory(group)
        retained = memory["used"] - before
        limit = (4 if name == "blank" else 64) << 20
        assert retained <= limit, (name, retained, limit)
        assert elapsed < 10, (name, elapsed)
        if name != "blank":
            # Both ends of the body table run after compiler storage is gone.
            last = "h49999" if name == "handlers50000" else "h99999"
            assert h.deliver(script, "h0") == OK
            assert h.deliver(script, last) == OK
            assert h.pump(group, 1791633600)[0] == OK
        measured[name] = {
            "sourceBytes": len(source.encode()),
            "seconds": round(elapsed, 4),
            "retainedBytes": retained,
            "groupPeakBytes": memory["peak"],
            "linearMemory": h.memory.data_len(h.store),
        }
        h.call("talk_group_release", group)
        # Destruction frees retained code, and the capped instance remains
        # usable for another Group and Script.
        fresh = h.new_group(core)
        code, script = h.load(fresh, "s", "on ping\nend ping\n")
        assert code == OK and h.deliver(script, "ping") == OK
        assert h.pump(fresh, 1791633600)[0] == OK
    return measured


def deep(engine, module):
    """The deepest source the depth guards accept loads and runs on the
    1 MiB stack, a Value nested until its guard stops it raises, and deeper
    source is refused: never a crash (ADR 0078; the Go Core's #582)."""
    h = Host(engine, module)
    core = h.call("talk_new") & 0xFFFFFFFF
    group = h.new_group(core)
    count = 0

    def loads(source):
        nonlocal count
        count += 1
        return h.load(group, f"s{count}", source)

    def deepest(make):
        low, high = 1, 512
        while low < high:
            mid = (low + high + 1) // 2
            if loads(make(mid))[0] == OK:
                low = mid
            else:
                high = mid - 1
        return low

    shapes = {
        "parentheses": lambda d: "on go\n  put " + "(" * d + "1" + ")" * d + " into x\nend go\n",
        "lists": lambda d: "on go\n  put " + "[" * d + "1" + "]" * d + " into x\nend go\n",
        "blocks": lambda d: "on go\n" + "  if true then\n" * d + "  put 1 into y\n" + "  end if\n" * d + "end go\n",
    }
    depths = {}
    for name, make in shapes.items():
        depths[name] = deepest(make)
        code, script = loads(make(depths[name]))
        assert code == OK, (name, code)
        assert h.deliver(script, "go") == OK
        code, _ = h.pump(group, 1791633600)
        assert code == OK, (name, code)
        assert loads(make(depths[name] * 50))[0] == LOAD_REFUSED, name
    # A list nested at run time just inside the Value depth guard, then
    # compared and copied, which walk it to the bottom.
    source = "script variable v\non go\n  put 1 into v\n  repeat 120 times\n    put [v] into v\n  end repeat\n  put [v = v, v] into v\nend go\n"
    code, script = loads(source)
    assert code == OK, code
    assert h.deliver(script, "go") == OK
    code, _ = h.pump(group, 1791633600)
    assert code == OK, code
    return depths


class MessageHost:
    """One instance spoken to through the Message Layer (#635): frames in
    through talk_buffer/talk_send, interim op needs answered under the
    Pump's own ref."""

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

    def frame(self, data):
        pointer = self.exports["talk_buffer"](self.store, len(data)) & 0xFFFFFFFF
        assert pointer > 0
        self.memory.write(self.store, data, pointer)
        packed = self.exports["talk_send"](self.store, len(data)) & (1 << 64) - 1
        out, size = packed >> 32, packed & 0xFFFFFFFF
        assert out > 0 and size > 0
        return json.loads(self.memory.read(self.store, out, out + size))

    def send(self, message, /, *, is_result=False, **fields):
        if not is_result:
            self.ref += 1
        reply = self.frame(json.dumps({"m": message, "ref": self.ref, **fields}).encode())
        assert reply["ref"] == self.ref, reply
        return reply

    def ok(self, message, /, **fields):
        reply = self.send(message, **fields)
        assert "ok" in reply, reply
        return reply["ok"]


def message_layer(engine, module):
    """Hello byte-identical, an immediate op answered through a need, a
    Fuel fault, malformed frames, and a healthy instance after each."""
    h = MessageHost(engine, module)
    hello = h.ok("hello", protocol=1)
    assert hello["core"].startswith("zig/"), hello
    assert h.send("hello", protocol=2)["err"]["kind"] == "protocol error"
    assert h.frame(b"{")["err"]["kind"] == "protocol error"
    for length in (0, (64 << 20) + 1, 0xFFFFFFFF):
        assert h.exports["talk_buffer"](h.store, length) == 0
    h.ok(
        "define-capability",
        name="api",
        ops=[{"name": "double", "mode": "immediate", "args": ["number"], "result": "number", "cost": {"fuel": 7}}],
    )
    grant = h.ok("grant", capability="api", ops="all")["grant"]
    h.ok("new-group", group="g", name="g")
    h.ok(
        "load",
        group="g",
        name="s",
        grants={"api": grant},
        source="on double n\n  ask api to double n\n  return it + 1\nend double\non spin\n  repeat forever\n  end repeat\nend spin\n",
    )
    now = "2026-10-10T12:00:00Z"
    h.ok("request", group="g", to={"script": "s"}, message={"name": "double", "args": [20]})
    need = h.send("pump", group="g", now=now)["need"]
    assert need["m"] == "op" and need["operation"] == "double" and need["args"] == [20], need
    done = h.send("op-result", is_result=True, result=40, charged=3)["ok"]
    ends = [r for r in done["reports"] if r["kind"] == "run end"]
    assert len(ends) == 1 and ends[0]["outcome"] == "completed" and ends[0]["result"] == 41, done
    h.ok("deliver", group="g", to={"script": "s"}, message={"name": "spin"})
    spun = h.ok("pump", group="g", now=now)["reports"][-1]
    assert spun["outcome"] == "limit fault" and spun["limit"] == "fuel", spun
    assert h.ok("hello", protocol=1) == hello
    size = h.memory.data_len(h.store)
    assert size <= MEMORY_LIMIT, f"an instance holds {size} bytes (> 16 MiB)"
    return {"hello": hello, "linearMemory": size}


def supported_limits(engine, module):
    """Reject unsupported profiles before they can exhaust the reactor,
    then load and run on the same Group after repeated refusals (#807)."""
    h = MessageHost(engine, module, memory_limit=16 << 20)
    h.ok("hello", protocol=1)
    h.ok("new-group", group="g", name="g")
    source = (
        "on dive\n  return recurse()\nend dive\n"
        "function recurse\n  return recurse()\nend recurse\n"
        "on ping\n  return 42\nend ping\n"
    )
    data_file = Path(__file__).resolve().parents[2] / "spec/data/limits.toml"
    limits = tomllib.loads(data_file.read_text())["limit"]
    for limit in limits:
        reply = h.send("load", group="g", name="s", source=source, limits={limit["ts"]: limit["minimum"] + 1})
        assert reply.get("err", {}).get("code") == "invalid value", (limit["ts"], reply)
    for _ in range(20):
        reply = h.send("load", group="g", name="s", source=source, limits={"callDepth": 1_000_000})
        assert reply.get("err", {}).get("code") == "invalid value", reply
    h.ok("load", group="g", name="s", source=source, limits={limit["ts"]: limit["minimum"] for limit in limits})
    now = "2026-10-13T12:00:00Z"
    h.ok("request", group="g", to={"script": "s"}, message={"name": "dive"})
    reports = h.ok("pump", group="g", now=now)["reports"]
    ended = [r for r in reports if r["kind"] == "run end"]
    assert len(ended) == 1 and ended[0]["outcome"] == "limit fault" and ended[0]["limit"] == "depth", ended
    h.ok("request", group="g", to={"script": "s"}, message={"name": "ping"})
    reports = h.ok("pump", group="g", now=now)["reports"]
    ended = [r for r in reports if r["kind"] == "run end"]
    assert len(ended) == 1 and ended[0]["outcome"] == "completed" and ended[0]["result"] == 42, ended
    h.ok("load", group="g", name="fresh", source="on ping\nend ping\n")
    return {"refusedProfiles": len(limits) + 20, "callDepth": 1000, "freshLoad": "passed"}


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: uv run tools/wasi/zig.py path/to/talk.wasm")
    path = Path(sys.argv[1])
    payload = path.read_bytes()
    engine = wasmtime.Engine()
    module = wasmtime.Module(engine, payload)
    # Only WASI imports: the Host's callbacks are talk.h function pointers.
    assert all(i.module == "wasi_snapshot_preview1" for i in module.imports)
    measured = instance_memory(engine, module)
    # The same with a stdlib import, which compiles that Library on first
    # use, as the Go reactor's #585 found costly.
    with_stdlib = instance_memory(engine, module, 'use padLeft from text\non ping\n  put padLeft("7", 3, "0") into x\nend ping\n')
    refused = containment(engine, module)
    nesting = deep(engine, module)
    loads = large_loads(engine, module)
    messages = message_layer(engine, module)
    profiles = supported_limits(engine, module)
    compressed = brotli.compress(payload, quality=11)
    zipped = gzip.compress(payload, compresslevel=9, mtime=0)
    assert brotli.decompress(compressed) == payload
    assert len(compressed) <= BROTLI_LIMIT and len(payload) <= RAW_LIMIT, (len(compressed), len(payload))
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
                "checks": "passed",
                "instance": measured,
                "instanceWithStdlib": with_stdlib,
                "containment": refused,
                "nesting": nesting,
                "largeLoads": loads,
                "messageLayer": messages,
                "supportedLimits": profiles,
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
