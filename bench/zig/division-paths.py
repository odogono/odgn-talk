"""Paired native division and Unit measurements and separate Group allocation probes.

Build two bench/zig/host.c binaries as measure-zig.ts does, then pass them here.
Every supported workload runs by default, including Quantity and macro work.
Timings use the default allocator; untimed probes use the counting allocator.
"""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import statistics
import subprocess
import tempfile
import tomllib

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("before", type=Path)
parser.add_argument("after", type=Path)
parser.add_argument("--before-revision", required=True)
parser.add_argument("--pairs", type=int, default=3)
parser.add_argument("--count", type=int, default=5)
parser.add_argument("--filter", action="append")
parser.add_argument("--out", type=Path, required=True)
args = parser.parse_args()
if args.pairs < 1 or args.count < 1:
    parser.error("pairs and count must be positive")
root = Path(__file__).resolve().parents[2]
benchmarks = json.loads((root / "bench/scripts/benchmarks.json").read_text())["benchmarks"]
temporary = tempfile.TemporaryDirectory(prefix="northtalk-division-")
for name, expression, expected in [
    ("div", "i div 8", "62125"),
    ("mod", "i mod 16", "7476"),
    ("divide-repeating", "i / 3", "166833"),
    ("quantity-factors", "(i * 1000 * 0.001) / 1", "500500"),
]:
    source = Path(temporary.name) / f"{name}.talk"
    source.write_text(f"on run n\n  put 0 into total\n  repeat for each i in 1..n\n    add {expression} to total\n  end repeat\n  return round(total, 0)\nend run\n")
    benchmarks.append({"name": f"probe/{name}", "source": source, "n": 500 if name == "quantity-factors" else 1000, "expect": "125250" if name == "quantity-factors" else expected, "expression": expression})
if args.filter:
    benchmarks = [b for b in benchmarks if any(f in b["name"] for f in args.filter)]
timing_env = dict(os.environ)
timing_env.pop("NORTHTALK_BENCH_ALLOCATIONS", None)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(host, benchmark, probe=False):
    command = [
        str(host.resolve()),
        str(benchmark.get("source", root / "bench/scripts" / f"{benchmark.get('script', benchmark['name'])}.talk")),
        str(benchmark["n"]), benchmark["expect"], str(benchmark.get("slice", 0)),
        "1" if probe else str(args.count), "1" if probe else "0",
    ]
    env = {**timing_env, "NORTHTALK_BENCH_ALLOCATIONS": "1"} if probe else timing_env
    return json.loads(subprocess.check_output(command, env=env))


result = {
    "recordedAt": datetime.now(timezone.utc).isoformat(),
    "baselineRevision": args.before_revision,
    "checkoutRevision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip(),
    "platform": platform.platform(),
    "cpu": subprocess.check_output(["sysctl", "-n", "machdep.cpu.brand_string"], text=True).strip() if platform.system() == "Darwin" else platform.processor(),
    "zig": subprocess.check_output(["zig", "version"], text=True).strip(),
    "cc": subprocess.check_output(["cc", "--version"], text=True).splitlines()[0],
    "language": tomllib.loads((root / "spec/data/version.toml").read_text())["language"],
    "costModel": tomllib.loads((root / "spec/data/costs.toml").read_text())["version"],
    "mode": "safe",
    "hostBuild": "cc -std=c11 -O2 -Wall -Wextra -Werror",
    "samplesPerProcess": args.count,
    "pairs": args.pairs,
    "binarySha256": {name: sha(host) for name, host in (("before", args.before), ("after", args.after))},
    "sourceSha256": {path: sha(root / path) for path in ("impl/zig/src/decimal/decimal.zig", "impl/zig/src/value.zig", "impl/zig/src/units.zig", "bench/zig/host.c")},
    "manifestSha256": sha(root / "bench/scripts/benchmarks.json"),
    "measurements": [],
}
args.out.parent.mkdir(parents=True, exist_ok=True)
for pair in range(args.pairs):
    for b in benchmarks:
        if b.get("skip", {}).get("zig"):
            continue
        # Include the existing Fuel Slice sweep as broader regression evidence.
        for slice_size in [b.get("slice", 0), *b.get("slices", [])]:
            benchmark = {**b, "slice": slice_size}
            name = b["name"] + (f"@slice={slice_size}" if slice_size else "")
            hosts = [("before", args.before), ("after", args.after)]
            if pair % 2:
                hosts.reverse()
            timings = {label: run(host, benchmark) for label, host in hosts}
            before, after = timings["before"], timings["after"]
            before_probe = run(args.before, benchmark, True)
            after_probe = run(args.after, benchmark, True)
            for key in ("fuel", "logicalAlloc"):
                assert before[key] == after[key] == before_probe[key] == after_probe[key], (name, key)
            result["measurements"].append({
                "pair": pair + 1, "name": name,
                "n": benchmark["n"], "expect": benchmark["expect"], "slice": slice_size,
                "expression": benchmark.get("expression"),
                "before": before, "after": after,
                "beforeProbe": before_probe, "afterProbe": after_probe,
            })
            args.out.write_text(json.dumps(result, indent=2) + "\n")
            print(f"pair {pair + 1} {name}: {statistics.median(before['run']) / 1e6:.3f} -> {statistics.median(after['run']) / 1e6:.3f} ms", flush=True)

temporary.cleanup()
