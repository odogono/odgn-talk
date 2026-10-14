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


def contained(engine, module, cap, name, source):
    """Run `source` until the Pump is refused at the Group's physical `cap`,
    then show the instance goes on to run a fresh Group."""
    h = Host(engine, module, memory_limit=64 << 20)
    core = h.call("talk_new") & 0xFFFFFFFF
    group = h.new_group(core, cap=cap)
    code, script = h.load(group, name, source)
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


def containment(engine, module):
    """A Script that doubles a text past the Group's physical cap."""
    source = 'script variable s\non grow\n  put "x" into s\n  repeat 40 times\n    put s & s into s\n  end repeat\nend grow\n'
    return contained(engine, module, 1 << 20, "hog", source)


def map_containment(engine, module):
    """Map construction uses the Group allocator and cannot exceed its cap."""
    source = ('on grow\n  put {} into values\n'
              '  repeat for each i in 1..1000\n'
              '    put i into the (i as text) of values\n'
              '  end repeat\nend grow\n')
    return contained(engine, module, 64 << 10, "maps", source)


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
    1 MiB stack, and deeper source is refused: never a crash (ADR 0078; the
    Go Core's #582). Values nested far deeper run, save and restore."""
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
    # Values nest without a cap (#871): a list and a map nested far past
    # the old 128-level guard, within the default Allocation Budget, are
    # compared and copied, then saved and restored, which walk them to the
    # bottom on the 1 MiB stack.
    source = (
        "script variable v\nscript variable m\non go\n  put 1 into v\n  put 1 into m\n"
        "  repeat 900 times\n    put [v] into v\n  end repeat\n"
        "  repeat 500 times\n    put {x: m} into m\n  end repeat\n"
        "  put [v = v, m = m, v, m] into v\nend go\n"
    )
    code, script = loads(source)
    assert code == OK, code
    assert h.deliver(script, "go") == OK
    code, _ = h.pump(group, 1791633600)
    assert code == OK, code
    saved = h.out()
    assert h.call("talk_save", group, saved) == OK
    data, size = struct.unpack("<2I", h.read(saved, 8))
    # A fault would have rolled the variables back: the save holds every
    # level, at least two bytes for each list and four for each map.
    assert size > 900 * 2 + 500 * 4, size
    # talk_restore_options: name, name_len, trace, trace_context, libraries,
    # libraries_len, grants, grants_context, resolve, resolve_context,
    # mismatch, allocator, memory_cap.
    name, name_len = h.text("restored")
    options = h.alloc(struct.pack("<13I", name, name_len, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0))
    restored, result = h.out(), h.out()
    assert h.call("talk_restore", core, data, size, options, restored, result) == OK
    h.call("talk_restore_result_release", h.pointer_at(result))
    h.call("talk_owned_bytes_release", saved)
    code, _ = h.pump(h.pointer_at(restored), 1791633601)
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
    h.ok(
        "load", group="g", name="maps",
        source=('on go\n  put {"é": 1, tail: 2} into values\n'
                '  put values into original\n  put values into values\'s self\n'
                '  put 3 into the ("e\u0301") of values\n'
                '  return [the keys of values, original, values]\nend go\n'),
    )
    h.ok("request", group="g", to={"script": "maps"}, message={"name": "go"})
    mapped = h.ok("pump", group="g", now=now)
    ends = [r for r in mapped["reports"] if r["kind"] == "run end"]
    assert len(ends) == 1 and ends[0]["outcome"] == "completed", mapped
    assert ends[0]["result"] == [
        ["é", "tail", "self"], {"é": 1, "tail": 2},
        {"é": 3, "tail": 2, "self": {"é": 1, "tail": 2}},
    ], mapped
    h.ok("deliver", group="g", to={"script": "s"}, message={"name": "spin"})
    spun = [r for r in h.ok("pump", group="g", now=now)["reports"] if r["kind"] == "run end"]
    assert len(spun) == 1 and spun[0]["outcome"] == "limit fault" and spun[0]["limit"] == "fuel", spun
    assert h.ok("hello", protocol=1) == hello
    size = h.memory.data_len(h.store)
    assert size <= MEMORY_LIMIT, f"an instance holds {size} bytes (> 16 MiB)"
    return {"hello": hello, "linearMemory": size}


def metered_operations(engine, module):
    """Zig-only metering transport acceptance while shared catalogues are staged."""
    h = MessageHost(engine, module)
    h.ok("define-capability", name="metered", ops=[{
        "name": "fetch", "mode": "suspending", "metering": "read-only",
        "result": "number",
    }])
    grant = h.ok("grant", capability="metered", ops="all")["grant"]
    h.ok("new-group", group="g", name="g", trace=True)
    h.ok("load", group="g", name="s", grants={"api": grant},
         limits={"fuelPerRun": 1000},
         source="on go\n ask api to fetch and wait\n return it\nend go\n")
    now = "2026-10-10T12:00:00Z"
    h.ok("request", group="g", to={"script": "s"}, message={"name": "go"})
    need = h.send("pump", group="g", now=now)["need"]
    call = need["call"]
    assert h.send("op-result", is_result=True, started=True).get("ok") is not None
    assert h.send("save", group="g")["err"]["code"] == "effects pending"
    for fuel in (-1, 1.5, 9007199254740992):
        assert h.send("request-charge", group="g", call=call, fuel=fuel)["err"]["code"] == "invalid value"
    assert h.ok("request-charge", group="g", call=call, fuel=17)["request"] == "q1"
    assert h.send("request-charge", group="g", call=call, fuel=0)["err"]["code"] == "invalid value"
    paid = h.ok("pump", group="g", now=now)
    charges = [r for r in paid["reports"] if r["kind"] == "charge result"]
    assert charges == [{"kind": "charge result", "request": "q1", "call": call, "fuel": 17, "status": "accepted"}], paid
    assert paid["fuelUsed"] == 17, paid
    assert h.ok("request-charge", group="g", call=call, fuel=1000)["request"] == "q2"
    limited = h.ok("pump", group="g", now=now)
    assert limited["reports"][0]["kind"] == "charge result" and limited["reports"][0]["status"] == "limit", limited
    ends = [r for r in limited["reports"] if r["kind"] == "run end"]
    assert len(ends) == 1 and ends[0]["limit"] == "fuel" and ends[0]["at"]["line"] == 2, limited
    assert limited["abandoned"] == [call] and limited["fuelUsed"] == 0, limited
    assert not any(line.startswith("seg ") for line in limited["trace"]), limited
    assert h.ok("request-charge", group="g", call=call, fuel=0)["request"] == "q3"
    inactive = h.ok("pump", group="g", now=now)
    assert inactive["reports"][0]["status"] == "inactive" and inactive["fuelUsed"] == 0, inactive
    h.ok("save", group="g")
    return {"acceptedFuel": 17, "outcomes": ["accepted", "limit", "inactive"]}


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


def text_containment(engine, module):
    """#804: text doubling must reach the logical Allocation Limit Fault
    under #532's instance caps, including repeated Runs on one instance."""
    measurements = []
    for alloc, persistent, cap in ((16 << 20, 1 << 20, 128 << 20), (256 << 20, 64 << 20, 1 << 30)):
        h = MessageHost(engine, module, memory_limit=cap)
        hello = h.ok("hello", protocol=1)
        h.ok("new-group", group="g", name="g")
        h.ok(
            "load",
            group="g",
            name="s",
            limits={"fuelPerRun": 1_000_000_000, "allocPerRun": alloc, "persistentState": persistent},
            source='on double\n  put "x" into s\n  repeat forever\n    put s & s into s\n  end repeat\nend double\non ping\n  return 42\nend ping\n',
        )
        peaks = []
        for _ in range(3):
            h.ok("deliver", group="g", to={"script": "s"}, message={"name": "double"})
            reports = h.ok("pump", group="g", now="2026-10-10T12:00:00Z")["reports"]
            ends = [r for r in reports if r["kind"] == "run end"]
            assert len(ends) == 1, reports
            end = ends[0]
            assert end["outcome"] == "limit fault" and end["limit"] == "alloc", end
            peaks.append(h.memory.data_len(h.store))
            assert h.ok("hello", protocol=1) == hello
            h.ok("request", group="g", to={"script": "s"}, message={"name": "ping"})
            reports = h.ok("pump", group="g", now="2026-10-10T12:00:00Z")["reports"]
            ends = [r for r in reports if r["kind"] == "run end"]
            assert len(ends) == 1 and ends[0]["outcome"] == "completed" and ends[0]["result"] == 42, reports
        measurements.append({"allocPerRun": alloc, "cap": cap, "linearMemory": peaks})
    return measurements


def character_indexing(engine, module):
    """Forward reads retain Character boundaries and handle i64 indexes on wasm32."""
    h = MessageHost(engine, module)
    h.ok("hello", protocol=1)
    h.ok("new-group", group="g", name="g")
    h.ok("load", group="g", name="s", source=(
        'on go\n'
        '  return [character 2 of (<<0x61, 0x0d, 0x0a, 0x62>> as text), character 2 of "aq́z", '
        'character 2 of "a👨‍👩‍👧z", character 2 of "a🇬🇧z", '
        'character -1 of "abc", character 1 of "", character 0 of "abc", '
        'character 9223372036854775807 of "abc", '
        'characters 9223372036854775807..9223372036854775807 of "abc", '
        'characters 1..9223372036854775807 of "aq́🇬🇧", '
        'characters 2..9 of "abc", characters 3..2 of "abc", '
        'characters -2..-1 of "abc"]\nend go\n'
    ))
    expected = ["\r\n", "q́", "👨‍👩‍👧", "🇬🇧", "c", "", "", "", "", "aq́🇬🇧", "bc", "", "bc"]
    accounting = []
    for _ in range(3):
        h.ok("request", group="g", to={"script": "s"}, message={"name": "go"})
        reports = h.ok("pump", group="g", now="2026-10-14T12:00:00Z")["reports"]
        ends = [r for r in reports if r["kind"] == "run end"]
        assert len(ends) == 1 and ends[0]["outcome"] == "completed" and ends[0]["result"] == expected, reports
        accounting.append({key: ends[0][key] for key in ("fuel", "alloc")})
    assert accounting[1:] == accounting[:1] * 2, accounting
    return {"runs": len(accounting), **accounting[0]}


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
    maps = map_containment(engine, module)
    nesting = deep(engine, module)
    loads = large_loads(engine, module)
    messages = message_layer(engine, module)
    metering = metered_operations(engine, module)
    profiles = supported_limits(engine, module)
    texts = text_containment(engine, module)
    characters = character_indexing(engine, module)
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
                "mapContainment": maps,
                "nesting": nesting,
                "largeLoads": loads,
                "messageLayer": messages,
                "metering": metering,
                "supportedLimits": profiles,
                "textContainment": texts,
                "characterIndexing": characters,
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
