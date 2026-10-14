"""Map construction sweep through the native Host; no third-party dependencies.

Build bench/zig/host.c as in measure-zig.ts, then pass that binary here. Timings
use the default allocator. A separate untimed run probes Group allocations.
"""

import argparse
import json
import os
from pathlib import Path
import statistics
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("host", type=Path)
parser.add_argument("--count", type=int, default=5)
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
script = root / "bench/scripts/collections/map-build.talk"
timing_env = dict(os.environ)
timing_env.pop("NORTHTALK_BENCH_ALLOCATIONS", None)


def run(size, count, smoke, env):
    command = [
        str(args.host.resolve()), str(script), str(size),
        str(size * (size + 1) // 2), "0", str(count), str(smoke),
    ]
    return json.loads(subprocess.check_output(command, env=env))


results = []
for size in (100, 300, 1000, 3000):
    timed = run(size, args.count, 0, timing_env)
    probe = run(size, 1, 1, {**timing_env, "NORTHTALK_BENCH_ALLOCATIONS": "1"})
    assert timed["fuel"] == probe["fuel"]
    assert timed["logicalAlloc"] == probe["logicalAlloc"]
    results.append({
        "n": size, **timed,
        "medianNs": statistics.median(timed["run"]),
        **{key: probe[key] for key in ("hostBytes", "hostAllocs", "groupPeak")},
    })
print(json.dumps(results, indent=2))
