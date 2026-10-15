"""Paired local List ownership sweeps, with separate allocation probes.

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
args = parser.parse_args()
if args.pairs < 1 or args.count < 1:
    parser.error("pairs and count must be positive")
root = Path(__file__).resolve().parents[2]
env = dict(os.environ)
env.pop("NORTHTALK_BENCH_ALLOCATIONS", None)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source_for(kind, size):
    seed = ", ".join(str(i) for i in range(1, size + 1))
    nested = kind == "nested"
    target = "item -1 of " + ("item 1 of " if nested else "") + "values"
    source = f"constant seed = [{seed}]\non run n\n put "
    source += "[seed]" if nested else "seed"
    source += " into values\n put values into original\n"
    if kind == "protected":
        source += " try\n"
    # Full snapshot collecting charges the growing result at each iteration.
    # 64 keeps the 3,000-item probe within the unchanged 256 MiB Run budget.
    writes = 64 if kind == "snapshots" else 128
    source += f" repeat for each i in 1..{writes}"
    if kind == "snapshots":
        source += " collecting values into versions"
    source += "\n"
    if kind == "alias":
        source += "  put values into alias\n"
    source += f"  put i into {target}\n end repeat\n"
    if kind == "protected":
        source += " finally\n  put 0 into done\n end try\n"
    if kind == "snapshots":
        result = f"item -1 of item 1 of versions + item -1 of item {writes} of versions"
        expected = str(writes + 1)
    elif kind == "alias":
        result = "item -1 of alias + item -1 of values"
        expected = "255"
    elif nested:
        result = "item -1 of item 1 of original + item -1 of item 1 of values"
        expected = str(size + 128)
    else:
        result = "item -1 of original + item -1 of values"
        expected = str(size + 128)
    return source + f" return {result}\nend run\n", expected


def run(host, source, expected, probe=False):
    command = [str(host.resolve()), str(source), "128", expected, "0",
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
    "mode": "safe", "hostBuild": "cc -std=c11 -O2 -Wall -Wextra -Werror",
    "binarySha256": {label: sha(host) for label, host in (("before", args.before), ("after", args.after))},
    "pairs": args.pairs, "samplesPerProcess": args.count,
    "writesPerRun": {"snapshots": 64, "other": 128},
    "measurements": [],
}
args.out.parent.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix="northtalk-local-list-") as directory:
    for pair in range(args.pairs):
        for kind in ("retained", "alias", "snapshots", "protected", "nested"):
            for size in (8, 100, 1000, 3000):
                source, expected = source_for(kind, size)
                path = Path(directory) / "probe.talk"
                path.write_text(source)
                hosts = [("before", args.before), ("after", args.after)]
                if pair % 2:
                    hosts.reverse()
                timing = {label: run(host, path, expected) for label, host in hosts}
                probes = {label: run(host, path, expected, True) for label, host in hosts}
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
