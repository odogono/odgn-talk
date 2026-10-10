# /// script
# requires-python = ">=3.11"
# dependencies = ["wasmtime==49.0.0", "brotli==1.2.0"]
# ///
"""Check List-growth faults and memory through the actual Message Layer.

uv run tools/wasi/list_memory.py --wasm .cache/messagelayer.wasm
uv run tools/wasi/list_memory.py --sidecar .cache/messagelayer

Each profile/workload gets a fresh process or WASI instance, without Trace.
WASI linear memory is monotonic, so its final size includes the growth peak.
Native peaks use wait4's child max RSS (bytes on macOS, KiB on Linux).
"""

import argparse
import datetime
import hashlib
import json
import os
import platform
import struct
import subprocess
import time
from pathlib import Path

import wasmtime

from check import Host, run_end

MIB = 1 << 20
PROFILES = {
    "default": {
        "fuelPerRun": 10_000_000,
        "allocPerRun": 16 * MIB,
        "persistentState": MIB,
    },
    "minimum": {
        "fuelPerRun": 1_000_000_000,
        "allocPerRun": 256 * MIB,
        "persistentState": 64 * MIB,
    },
}


class Sidecar(Host):
    def __init__(self, path):
        self.process = subprocess.Popen(
            [str(path.resolve())], stdin=subprocess.PIPE, stdout=subprocess.PIPE
        )
        self.ref = 0

    def frame(self, data):
        self.process.stdin.write(struct.pack(">I", len(data)) + data)
        self.process.stdin.flush()
        header = self.process.stdout.read(4)
        assert len(header) == 4, "sidecar exited before its reply"
        (size,) = struct.unpack(">I", header)
        parts = bytearray()
        while len(parts) < size:
            chunk = self.process.stdout.read(size - len(parts))
            assert chunk, "truncated sidecar reply"
            parts.extend(chunk)
        return json.loads(parts)

    def close(self):
        self.process.stdin.close()
        _, status, usage = os.wait4(self.process.pid, 0)
        self.process.returncode = os.waitstatus_to_exitcode(status)
        self.process.stdout.close()
        assert self.process.returncode == 0, self.process.returncode
        return int(usage.ru_maxrss * (1 if platform.system() == "Darwin" else 1024))


def source(workload, item):
    text = '"' + "x" * 64 + '"' if item == "text" else "nothing"
    if workload == "local":
        return f"""on grow
  put [] into xs
  repeat forever
    put {text} after xs
  end repeat
end grow
on healthy
  return 42
end healthy
"""
    return f"""script variable xs = []
on grow
  repeat forever
    repeat 1000 times
      put {text} after xs
    end repeat
    wait 1 ms
  end repeat
end grow
on healthy
  return the length of xs
end healthy
"""


def exercise(host, limits, workload, item):
    hello = host.ok("hello", protocol=1)
    host.ok("new-group", group="g", name="g")
    host.ok("load", group="g", name="s", source=source(workload, item), limits=limits)
    host.ok("request", group="g", to={"script": "s"}, message={"name": "grow"})
    now = datetime.datetime(2026, 10, 10, tzinfo=datetime.timezone.utc)
    started = time.monotonic()
    for pumps in range(1, 10_001):
        now += datetime.timedelta(seconds=1)
        reply = host.send("pump", group="g", now=now.isoformat(), fuelSlice=1_000_000)
        assert "ok" in reply, reply
        if any(r["kind"] == "run end" for r in reply["ok"]["reports"]):
            end = run_end(reply)
            break
    else:
        raise AssertionError("growth did not fault within 10000 Pumps")
    expected = "alloc" if workload == "local" else "persistent"
    assert end["outcome"] == "limit fault" and end["limit"] == expected, end
    # Fault rollback keeps the last committed Script Variable window intact.
    assert host.ok("hello", protocol=1) == hello
    host.ok("request", group="g", to={"script": "s"}, message={"name": "healthy"})
    healthy = run_end(host.send("pump", group="g", now=now.isoformat()))
    assert healthy["outcome"] == "completed", healthy
    if workload == "local":
        assert healthy["result"] == 42, healthy
    else:
        retained = healthy["result"] * (88 if item == "text" else 16) + 16
        assert 0 < retained <= limits["persistentState"], healthy
    return {
        "seconds": round(time.monotonic() - started, 3),
        "pumps": pumps,
        "fault": end,
        "healthy_result": healthy["result"],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    transport = parser.add_mutually_exclusive_group(required=True)
    transport.add_argument("--wasm", type=Path)
    transport.add_argument("--sidecar", type=Path)
    parser.add_argument("--profile", choices=["all", *PROFILES], default="all")
    parser.add_argument("--workload", choices=["all", "local", "persistent"], default="all")
    parser.add_argument("--item", choices=["all", "text", "nothing"], default="all")
    args = parser.parse_args()
    path = args.wasm or args.sidecar
    if args.wasm:
        engine = wasmtime.Engine()
        module = wasmtime.Module.from_file(engine, str(path))
    results = []
    for profile, limits in PROFILES.items():
        if args.profile not in ("all", profile):
            continue
        for workload in ("local", "persistent"):
            if args.workload not in ("all", workload):
                continue
            for item in ("text", "nothing"):
                if args.item not in ("all", item):
                    continue
                # Backstop below wasm32's 4 GiB ceiling, including runtime overhead.
                cap = 64 * MIB + 12 * limits["allocPerRun"]
                host = Host(engine, module, memory_limit=cap) if args.wasm else Sidecar(path)
                result = exercise(host, limits, workload, item)
                peak = host.memory.data_len(host.store) if args.wasm else host.close()
                assert peak <= cap, (profile, workload, peak, cap)
                result.update(
                    profile=profile,
                    workload=workload,
                    item=item,
                    peak_bytes=peak,
                    peak_kind="linear memory" if args.wasm else "process max RSS",
                    allocation_budget=limits["allocPerRun"],
                    cap_bytes=cap,
                    multiple=round(peak / limits["allocPerRun"], 3),
                )
                results.append(result)
                print(json.dumps(result), flush=True)
                del host
    print(json.dumps({
        "artifact": str(path),
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "platform": platform.platform(),
        "results": results,
    }, indent=2))


if __name__ == "__main__":
    main()
