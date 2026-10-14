"""Collecting and point-write size sweeps, with separate allocation probes.

Build bench/zig/host.c as in measure-zig.ts. Run once per binary; --compare
checks output/accounting against the saved baseline. No third-party packages.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import statistics
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("host", type=Path)
parser.add_argument("--count", type=int, default=5)
parser.add_argument("--compare", type=Path)
parser.add_argument("--out", type=Path, required=True)
args = parser.parse_args()
if args.count < 1:
    parser.error("count must be positive")
root = Path(__file__).resolve().parents[2]
timing_env = dict(os.environ)
timing_env.pop("NORTHTALK_BENCH_ALLOCATIONS", None)
result = {
    "binarySha256": hashlib.sha256(args.host.read_bytes()).hexdigest(),
    "measurements": [],
}
baseline = json.loads(args.compare.read_text())["measurements"] if args.compare else None
with tempfile.TemporaryDirectory(prefix="northtalk-list-") as directory:
    for workload in ("collect", "spread", "write"):
        source = root / "bench/scripts/collections/list-build.talk"
        if workload != "collect":
            source = Path(directory) / f"{workload}.talk"
            if workload == "spread":
                source.write_text("on run n\n repeat for each i in 1..n collecting [...[i]] into values\n end repeat\n return the length of values\nend run\n")
        for size in (100, 300, 1000, 3000):
            if workload == "write":
                # Build the retained seed during Load, outside the Run timer;
                # collecting must not obscure point-write size scaling.
                seed = ", ".join(str(i) for i in range(1, size + 1))
                source.write_text(f"constant seed = [{seed}]\non run n\n put seed into values\n put values into original\n repeat 128 times\n  put 0 into item -1 of values\n end repeat\n return item -1 of original + item -1 of values\nend run\n")
            expected = size * (size + 1) // 2 if workload == "collect" else size
            command = [str(args.host.resolve()), str(source), str(size), str(expected), "0"]
            timed = json.loads(subprocess.check_output([*command, str(args.count), "0"], env=timing_env))
            probe = json.loads(subprocess.check_output([*command, "1", "1"], env={**timing_env, "NORTHTALK_BENCH_ALLOCATIONS": "1"}))
            for key in ("fuel", "logicalAlloc"):
                assert timed[key] == probe[key], (workload, size, key)
                if baseline:
                    previous = next(m for m in baseline if m["name"] == workload and m["n"] == size)
                    assert timed[key] == previous["timing"][key], (workload, size, key)
            result["measurements"].append({
                "name": workload, "n": size, "expect": str(expected),
                "source": source.read_text(), "timing": timed,
                "medianNs": statistics.median(timed["run"]), "probe": probe,
            })
            args.out.write_text(json.dumps(result, indent=2) + "\n")
            print(f"{workload} {size}: {statistics.median(timed['run']) / 1e6:.3f} ms, {probe['hostBytes']} bytes", flush=True)
