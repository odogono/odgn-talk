"""Paired safe-native instruction timings and separate macOS CPU samples.

Build bench/zig/host.c against each Core revision before running this script.
Default timings cover every supported manifest workload and the Fibonacci Fuel
Slice sweep. Additional probes isolate straight-line moves, sliced loops/calls,
and a loop protected by finally. Profiles run separately from all timings.
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
import tempfile
import time
import tomllib

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("before", type=Path)
parser.add_argument("after", type=Path)
parser.add_argument("--before-revision", required=True)
parser.add_argument("--pairs", type=int, default=3)
parser.add_argument("--count", type=int, default=5)
parser.add_argument("--filter", action="append", help="keep workload names containing this text; repeat for alternatives")
parser.add_argument("--profiles", type=Path, help="directory for separate macOS sample reports")
parser.add_argument("--out", type=Path, required=True)
parser.add_argument("--profiles-only", action="store_true", help="capture profiles without timings")
parser.add_argument("--profile-filter", action="append", help="profile names containing this text instead of the default selection")
args = parser.parse_args()
if args.pairs < 1 or args.count < 1:
    parser.error("pairs and count must be positive")
if args.profiles_only and not args.profiles:
    parser.error("--profiles-only requires --profiles")
if args.profiles and platform.system() != "Darwin":
    parser.error("CPU samples require macOS sample; timings work on other native targets")
root = Path(__file__).resolve().parents[2]
manifest = root / "bench/scripts/benchmarks.json"
env = dict(os.environ)
env.pop("NORTHTALK_BENCH_ALLOCATIONS", None)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(host, b, *, probe=False):
    command = [str(host.resolve()), str(b["source"]), str(b["n"]), b["expect"],
               str(b["slice"]), str(1 if probe else args.count), "1" if probe else "0"]
    return json.loads(subprocess.check_output(command, env={**env, "NORTHTALK_BENCH_ALLOCATIONS": "1"} if probe else env))


def attribution(report):
    # sample prints inclusive counts in a tree. Subtract immediate children
    # before aggregating leaf samples, avoiding double counting recursive calls.
    nodes, stack = [], []
    graph = report.split("Call graph:\n", 1)[1].split("\nTotal number in stack", 1)[0]
    for line in graph.splitlines():
        m = re.match(r"^([ +!:|]*)(\d+) (.+)$", line)
        if not m:
            continue
        depth, count = len(m[1]), int(m[2])
        symbol = m[3].split("  (in ", 1)[0].split(" + ", 1)[0]
        while stack and nodes[stack[-1]]["depth"] >= depth:
            stack.pop()
        node = {"depth": depth, "self": count, "path": [nodes[i]["symbol"] for i in stack] + [symbol], "symbol": symbol}
        if stack:
            nodes[stack[-1]]["self"] -= count
        stack.append(len(nodes))
        nodes.append(node)
    counts = dict.fromkeys(["pump", "execute", "charging", "formulaEvaluation", "specializedEvaluation", "instruction", "scratchReset", "operandRetention", "decimal", "valueConstruction", "allocator", "chunksSet", "listSet", "valueRelease"], 0)
    for node in nodes:
        path, count = node["path"], node["self"]
        assert count >= 0
        if "talk_pump" not in path:
            continue
        counts["pump"] += count
        # These are overlapping inclusive categories, not additive shares.
        if any("machine.costs.charge" in symbol or "machine.costs.evaluate" in symbol or "generated.rates.evaluateSpecialized" in symbol for symbol in path):
            counts["charging"] += count
        for key, pattern in [("execute", "Group.execute"),
                             ("formulaEvaluation", "machine.costs.evaluate"), ("specializedEvaluation", "generated.rates.evaluateSpecialized"),
                             ("instruction", "Group.instruction"),
                             ("scratchReset", "ArenaAllocator.reset"), ("operandRetention", "Operands."),
                             ("decimal", "decimal.decimal."), ("valueConstruction", "value.scalar"),
                             ("allocator", "Allocator."), ("chunksSet", "machine.chunks.set"),
                             ("listSet", "value.listSet"), ("valueRelease", "value.Value.release")]:
            if any(pattern in symbol for symbol in path):
                counts[key] += count
    return counts


args.out.parent.mkdir(parents=True, exist_ok=True)
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
    "mode": "safe", "hostBuild": "cc -std=c11 -O2 -Wall -Wextra -Werror",
    "samplesPerProcess": args.count, "pairs": args.pairs,
    "binarySha256": {name: sha(host) for name, host in (("before", args.before), ("after", args.after))},
    "sourceSha256": {path: sha(root / path) for path in ("impl/zig/src/machine/machine.zig", "impl/zig/src/machine/costs.zig", "impl/zig/src/value.zig", "impl/zig/src/machine/group_allocator.zig", "bench/zig/host.c")},
    "generatorSha256": sha(root / "tools/zig/generate.ts"),
    "ratesSha256": sha(root / "impl/zig/src/generated/rates.zig"),
    "manifestSha256": sha(manifest), "measurements": [], "profiles": [],
}
result["baselineSourceSha256"] = {
    path: hashlib.sha256(subprocess.check_output(["git", "show", f"{args.before_revision}:{path}"], cwd=root)).hexdigest()
    for path in result["sourceSha256"]
}
with tempfile.TemporaryDirectory() as temporary:
    temporary = Path(temporary)
    straightline = temporary / "straightline.talk"
    straightline.write_text("on run n\n  put n into total\n" + "  put total into total\n" * 256 + "  return total\nend run\n")
    protected = temporary / "protected-loop.talk"
    protected.write_text("on run n\n  put 0 into total\n  try\n    repeat for each i in 1..n\n      put total + i into total\n    end repeat\n  finally\n    put total into total\n  end try\n  return total\nend run\n")
    workloads = []
    for b in json.loads(manifest.read_text())["benchmarks"]:
        if b.get("skip", {}).get("zig"):
            continue
        slices = [b.get("slice", 0), *b.get("slices", [])]
        if b["name"] in ("core/loop", "core/calls"):
            slices.append(100)
        for s in slices:
            workloads.append({**b, "slice": s, "source": root / "bench/scripts" / f"{b.get('script', b['name'])}.talk"})
    workloads.extend([
        {"name": "probe/straightline", "source": straightline, "n": 7, "expect": "7", "slice": 0},
        {"name": "probe/straightline", "source": straightline, "n": 7, "expect": "7", "slice": 100},
        {"name": "probe/protected-loop", "source": protected, "n": 2000, "expect": "2001000", "slice": 0},
        {"name": "probe/protected-loop", "source": protected, "n": 2000, "expect": "2001000", "slice": 100},
    ])
    if args.filter:
        workloads = [b for b in workloads if any(text in b["name"] for text in args.filter)]
        if not workloads:
            parser.error("filter selects no supported workloads")
    for pair in range(0 if args.profiles_only else args.pairs):
        for b in workloads:
            # Alternate order across pairs to reduce first-process bias.
            hosts = [("before", args.before), ("after", args.after)]
            if pair % 2:
                hosts.reverse()
            timings = {label: run(host, b) for label, host in hosts}
            probes = {label: run(host, b, probe=True) for label, host in hosts}
            for key in ("fuel", "logicalAlloc"):
                assert timings["before"][key] == timings["after"][key] == probes["before"][key] == probes["after"][key], (b["name"], b["slice"], key)
            result["measurements"].append({"pair": pair + 1, "name": b["name"], "slice": b["slice"], "n": b["n"], "expect": b["expect"], "sourceSha256": sha(b["source"]), **timings, "beforeProbe": probes["before"], "afterProbe": probes["after"]})
            args.out.write_text(json.dumps(result, indent=2) + "\n")
            print(f"pair {pair + 1} {b['name']} slice={b['slice']}: " + " -> ".join(f"{statistics.median(timings[label]['run']) / 1e6:.3f}" for label in ("before", "after")) + " ms", flush=True)
    if args.profiles:
        args.profiles.mkdir(parents=True, exist_ok=True)
        selected = [b for b in workloads if b["name"] in ("core/loop", "core/calls", "core/fib", "probe/straightline", "probe/protected-loop")]
        if args.profile_filter:
            selected = [b for b in workloads if any(text in b["name"] for text in args.profile_filter)]
        if not selected:
            parser.error("profile filter selects no supported workloads")
        for label, host in (("before", args.before), ("after", args.after)):
            for b in selected:
                name = f"{label}-{b['name'].replace('/', '-')}-slice-{b['slice']}"
                sample_file = temporary / f"{name}.txt"
                # sample's attachment/symbolication can take several seconds.
                # Keep the Host in its Run phase for >=15 seconds so those
                # delays do not silently turn this into a Load/startup profile.
                process = subprocess.Popen([str(host.resolve()), str(b["source"]), str(b["n"]), b["expect"], str(b["slice"]), "300", "0"], env=env, stdout=subprocess.DEVNULL)
                try:
                    time.sleep(.1)
                    subprocess.run(["sample", str(process.pid), "2", "1", "-file", str(sample_file)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    if process.poll() not in (None, 0):
                        raise RuntimeError(f"profile Host failed: {name}")
                finally:
                    if process.poll() is None:
                        process.terminate()
                        process.wait()
                report = sample_file.read_text()
                samples = attribution(report)
                if samples["pump"] < 500:
                    raise RuntimeError(f"too few Pump samples for {name}: {samples['pump']}; retry profiling")
                packed = gzip.compress(report.encode(), mtime=0)
                artifact = args.profiles / f"{name}.txt.gz"
                artifact.write_bytes(packed)
                result["profiles"].append({"binary": label, "name": b["name"], "slice": b["slice"], "durationSeconds": 2, "intervalMs": 1, "report": artifact.name, "reportSha256": sha(artifact), "samples": samples})
                args.out.write_text(json.dumps(result, indent=2) + "\n")
                print(f"profiled {name}", flush=True)
