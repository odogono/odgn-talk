"""Paired ordered Map storage sweeps, with separate allocation probes.

Build both native safe talk.h Hosts before running. Passing the same Host
twice measures control variability; it is not an optimization comparison.
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

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("before", type=Path)
parser.add_argument("after", type=Path)
parser.add_argument("--before-revision", required=True)
parser.add_argument("--pairs", type=int, default=3)
parser.add_argument("--count", type=int, default=3)
parser.add_argument("--out", type=Path, required=True)
parser.add_argument("--filter", default="")
parser.add_argument("--max-size", type=int, default=3000)
args = parser.parse_args()
if args.pairs < 1 or args.count < 1:
    parser.error("pairs and count must be positive")
root = Path(__file__).resolve().parents[2]
env = dict(os.environ)
env.pop("NORTHTALK_BENCH_ALLOCATIONS", None)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source_for(kind, size):
    if kind == "build" and size == 0:
        return "on run n\n return the length of {}\nend run\n", "0"
    if kind == "build":
        return ("on run n\n put {} into values\n repeat for each i in 1..n\n put i into the (i & \"\") of values\n end repeat\n return the length of values\nend run\n", str(size))
    key = "long_key_" * 16 if kind == "long-keys" else "k"
    seed = ", ".join(f'"{key}{i}": {i}' for i in range(size))
    writes = 32 if kind == "snapshots" and size >= 1000 else 128
    source = f"constant seed = {{{seed}}}\non run n\n put seed into values\n put values into original\n"
    source += f" repeat for each i in 1..{writes}"
    if kind == "snapshots":
        source += " collecting values into versions"
    source += "\n"
    if kind == "delete":
        source += f'  delete the ("{key}0") of values\n  put i into the ("{key}0") of values\n'
    else:
        source += f'  put i into the ("{key}0") of values\n'
    source += " end repeat\n"
    if kind == "snapshots":
        source += f' return the ("{key}0") of item 1 of versions + the ("{key}0") of item {writes} of versions\n'
        expected = str(writes + 1)
    else:
        source += f' return the ("{key}0") of original + the ("{key}0") of values\n'
        expected = str(writes)
    return source + "end run\n", expected


def run(host, source, expected, size, probe=False):
    command = [str(host.resolve()), str(source), str(size), expected, "0",
               "1" if probe else str(args.count), "1" if probe else "0"]
    return json.loads(subprocess.check_output(command, env={**env, "NORTHTALK_BENCH_ALLOCATIONS": "1"} if probe else env))


result = {
    "recordedAt": datetime.now(timezone.utc).isoformat(),
    "baselineRevision": args.before_revision,
    "checkoutRevision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip(),
    "platform": platform.platform(),
    "cpu": subprocess.check_output(["sysctl", "-n", "machdep.cpu.brand_string"], text=True).strip() if platform.system() == "Darwin" else platform.processor(),
    "zig": subprocess.check_output(["zig", "version"], text=True).strip(),
    "cc": subprocess.check_output(["cc", "--version"], text=True).splitlines()[0],
    "sourceSha256": {str(p.relative_to(root)): sha(p) for p in (root / "bench/zig/host.c", root / "impl/zig/src/value.zig", Path(__file__).resolve())},
    "mode": "safe", "hostBuild": "cc -std=c11 -O2 -Wall -Wextra -Werror",
    "binarySha256": {label: sha(host) for label, host in (("before", args.before), ("after", args.after))},
    "pairs": args.pairs, "samplesPerProcess": args.count,
    "writesPerRun": {"largeSnapshots": 32, "otherUpdates": 128},
    "measurements": [],
}
args.out.parent.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix="northtalk-map-") as directory:
    for pair in range(args.pairs):
        for kind in ("build", "replace", "snapshots", "delete", "long-keys"):
            for size in (0, 1, 4, 8, 16, 32, 33, 64, 65, 100, 1000, 3000):
                if size > args.max_size:
                    continue
                if size == 0 and kind != "build":
                    continue
                if args.filter and args.filter not in f"{kind}/{size}":
                    continue
                source, expected = source_for(kind, size)
                path = Path(directory) / "probe.talk"
                path.write_text(source)
                hosts = [("before", args.before), ("after", args.after)]
                if pair % 2:
                    hosts.reverse()
                timing = {label: run(host, path, expected, size) for label, host in hosts}
                probes = {label: run(host, path, expected, size, True) for label, host in hosts}
                for key in ("fuel", "logicalAlloc"):
                    assert timing["before"][key] == timing["after"][key] == probes["before"][key] == probes["after"][key], (kind, size, key)
                # Workloads use one loaded Script for all timing samples;
                # counting probes use a separate, fresh Group and single Run.
                result["measurements"].append({
                    "pair": pair + 1, "name": kind, "n": size, "source": source,
                    "expect": expected, **timing,
                    "beforeProbe": probes["before"], "afterProbe": probes["after"],
                })
                args.out.write_text(json.dumps(result, indent=2) + "\n")
                print(f"pair {pair + 1} {kind} {size}: " + " -> ".join(f"{statistics.median(timing[label]['run']) / 1e6:.3f}" for label in ("before", "after")) + " ms", flush=True)

# Timings are advisory. Report gates for review; rerun noisy failures instead
# of making wall-clock measurements a CI assertion.
summary = []
for kind, size in sorted({(m["name"], m["n"]) for m in result["measurements"]}):
    rows = [m for m in result["measurements"] if (m["name"], m["n"]) == (kind, size)]
    ratios = [statistics.median(m["after"]["run"]) / statistics.median(m["before"]["run"]) for m in rows]
    memory_failures = []
    for m in rows:
        for metric in ("hostLivePeakDelta", "groupPeak"):
            before, after = m["beforeProbe"][metric], m["afterProbe"][metric]
            if after - before > max(4096, before * .1):
                memory_failures.append({"pair": m["pair"], "metric": metric, "before": before, "after": after})
    summary.append({"name": kind, "n": size, "medianChangePercent": (statistics.median(ratios) - 1) * 100,
                    "pairChangePercent": [(r - 1) * 100 for r in ratios], "memoryFailures": memory_failures})
result["summary"] = summary
args.out.write_text(json.dumps(result, indent=2) + "\n")
