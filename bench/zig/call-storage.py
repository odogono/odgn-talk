"""Paired native call-storage and compact-Value measurements and separate Group allocation probes.

Build two bench/zig/host.c binaries as measure-zig.ts does, then pass them here.
Call, scalar and Quantity workloads run by default; --all includes the full suite.
Timings use the default allocator; untimed probes use the counting allocator.
"""

import argparse
from datetime import datetime, timezone
import gzip
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import statistics
import subprocess
import time
import tomllib

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("before", type=Path)
parser.add_argument("after", type=Path)
parser.add_argument("--before-revision", required=True)
parser.add_argument("--pairs", type=int, default=3)
parser.add_argument("--count", type=int, default=5)
parser.add_argument("--out", type=Path, required=True)
parser.add_argument("--all", action="store_true")
parser.add_argument("--filter", help="one workload substring")
parser.add_argument("--profiles-only", action="store_true", help="replace profiles in an existing measurement JSON")
parser.add_argument("--before-source-root", type=Path, help="source checkout for an uncommitted baseline")
parser.add_argument("--after-source-root", type=Path, help="source checkout for a prototype")
parser.add_argument("--profiles", type=Path, help="separate macOS CPU samples")
args = parser.parse_args()
if args.pairs < 1 or args.count < 1:
    parser.error("pairs and count must be positive")
if args.profiles and platform.system() != "Darwin":
    parser.error("CPU profiles require macOS sample")
root = Path(__file__).resolve().parents[2]
benchmarks = json.loads((root / "bench/scripts/benchmarks.json").read_text())["benchmarks"]
if not args.all and not args.filter:
    names = {"core/loop", "core/calls", "core/fib", "core/lambdas", "numbers/add", "numbers/multiply", "numbers/divide", "numbers/quantity", "macro/game-tick"}
    benchmarks = [b for b in benchmarks if b["name"] in names]
if args.filter:
    benchmarks = [b for b in benchmarks if args.filter in b["name"]]
if args.profiles_only and not args.profiles:
    parser.error("--profiles-only requires --profiles")
timing_env = dict(os.environ)
timing_env.pop("NORTHTALK_BENCH_ALLOCATIONS", None)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(host, benchmark, probe=False):
    command = [
        str(host.resolve()),
        str(root / "bench/scripts" / f"{benchmark.get('script', benchmark['name'])}.talk"),
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
    "beforeSourceSha256": {path: sha(args.before_source_root / path) if args.before_source_root else hashlib.sha256(subprocess.check_output(["git", "show", f"{args.before_revision}:{path}"], cwd=root)).hexdigest() for path in ("impl/zig/src/machine/group_allocator.zig", "impl/zig/src/machine/machine.zig", "impl/zig/src/value.zig")},
    "afterSourceSha256": {path: sha((args.after_source_root or root) / path) for path in ("impl/zig/src/machine/group_allocator.zig", "impl/zig/src/machine/machine.zig", "impl/zig/src/value.zig")},
    "hostSourceSha256": sha(root / "bench/zig/host.c"),
    "manifestSha256": sha(root / "bench/scripts/benchmarks.json"),
    "measurements": [],
    "profiles": [],
}
args.out.parent.mkdir(parents=True, exist_ok=True)
if args.profiles_only:
    result = json.loads(args.out.read_text())
    result["profiles"] = []
for pair in range(0 if args.profiles_only else args.pairs):
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
            timings = {name: run(host, benchmark) for name, host in hosts}
            before, after = timings["before"], timings["after"]
            before_probe = run(args.before, benchmark, True)
            after_probe = run(args.after, benchmark, True)
            for key in ("fuel", "logicalAlloc"):
                assert before[key] == after[key] == before_probe[key] == after_probe[key], (name, key)
            result["measurements"].append({
                "pair": pair + 1, "name": name,
                "n": benchmark["n"], "expect": benchmark["expect"], "slice": slice_size,
                "before": before, "after": after,
                "beforeProbe": before_probe, "afterProbe": after_probe,
            })
            args.out.write_text(json.dumps(result, indent=2) + "\n")
            print(f"pair {pair + 1} {name}: {statistics.median(before['run']) / 1e6:.3f} -> {statistics.median(after['run']) / 1e6:.3f} ms", flush=True)

# Timings above are complete before sampling starts. Inclusive categories
# overlap; inlining can hide the allocator's call-site attribution.
def attribution(report):
    nodes, stack = [], []
    graph = report.split("Call graph:\n", 1)[1].split("\nTotal number in stack", 1)[0]
    for line in graph.splitlines():
        match = re.match(r"^([ +!:|]*)(\d+) (.+)$", line)
        if not match:
            continue
        depth, count = len(match[1]), int(match[2])
        symbol = match[3].split("  (in ", 1)[0].split(" + ", 1)[0]
        while stack and nodes[stack[-1]]["depth"] >= depth:
            stack.pop()
        node = {"depth": depth, "self": count, "path": [nodes[i]["symbol"] for i in stack] + [symbol], "symbol": symbol}
        if stack:
            nodes[stack[-1]]["self"] -= count
        stack.append(len(nodes))
        nodes.append(node)
    patterns = {"framePush": "pushFrameIn", "framePop": "popFrame", "valueConstruction": "value.scalar",
                "valueRelease": "Value.release", "decimal": "decimal.decimal.", "allocator": "Allocator.", "copy": "memcpy"}
    counts = dict.fromkeys(["pump", *patterns], 0)
    for node in nodes:
        if "talk_pump" not in node["path"]:
            continue
        assert node["self"] >= 0
        counts["pump"] += node["self"]
        for category, pattern in patterns.items():
            if any(pattern in symbol for symbol in node["path"]):
                counts[category] += node["self"]
    return counts

if args.profiles:
    args.profiles.mkdir(parents=True, exist_ok=True)
    for b in benchmarks:
        if b["name"] not in ("core/calls", "core/fib", "core/lambdas", "numbers/quantity"):
            continue
        for label, host in (("before", args.before), ("after", args.after)):
            name = f"{label}-{b['name'].replace('/', '-')}"
            raw = args.profiles / f"{name}.txt"
            command = [str(host.resolve()), str(root / "bench/scripts" / f"{b['name']}.talk"), str(b["n"]), b["expect"], "0", "600", "0"]
            process = subprocess.Popen(command, env=timing_env, stdout=subprocess.DEVNULL)
            try:
                time.sleep(.1)
                subprocess.run(["sample", str(process.pid), "2", "1", "-file", str(raw)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                if process.poll() is not None:
                    raise RuntimeError(f"profile Host ended before capture: {name}")
            finally:
                if process.poll() is None:
                    process.terminate()
                    process.wait()
            report = raw.read_text()
            artifact = raw.with_suffix(".txt.gz")
            artifact.write_bytes(gzip.compress(report.encode(), mtime=0))
            raw.unlink()
            result["profiles"].append({"binary": label, "name": b["name"], "durationSeconds": 2, "intervalMs": 1, "runSamplesRequested": 600, "terminatedAfterSample": True, "report": artifact.name, "reportSha256": sha(artifact), "samples": attribution(report)})
            args.out.write_text(json.dumps(result, indent=2) + "\n")
            print(f"profiled {name}", flush=True)
