"""Paired native Decimal comparison measurements and separate Group allocation probes.

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
parser.add_argument("--profiles", type=Path)
parser.add_argument("--out", type=Path, required=True)
args = parser.parse_args()
if args.pairs < 1 or args.count < 1:
    parser.error("pairs and count must be positive")
root = Path(__file__).resolve().parents[2]
benchmarks = json.loads((root / "bench/scripts/benchmarks.json").read_text())["benchmarks"]
temporary = tempfile.TemporaryDirectory(prefix="northtalk-comparisons-")
# Keep compared operands in parameters/locals so the checker cannot fold them.
# The loop adds a common integer comparison cost; profiles separate its stacks.
for name, expression, left, right in [
    ("equal-exponent", "x < y", "12345", "12346"),
    ("cohort", "x = y", "1", "1.00"),
    ("scaled", "x < y", "123.45", "124"),
    ("sign", "x < y", "-123.45", "124"),
    ("zero", "x < y", "0.000", "0.01"),
    ("wide", "x < y", "9999999999999999999999999999999998", "9999999999999999999999999999999999"),
    ("scale-overflow", "x > y", "9999999999999999999999999999999999", "0.000001"),
    ("extreme-gap", "x > y", "1", "0." + "0" * 6175 + "1"),
    ("quantity-comparison", "x < y", "1 mm", "1 m"),
]:
    source = Path(temporary.name) / f"{name}.talk"
    source.write_text(f"on compare n, x, y\n  put 0 into total\n  repeat for each i in 1..n\n    if {expression} then add 1 to total\n  end repeat\n  return total\nend compare\non run n\n  return compare(n, {left}, {right})\nend run\n")
    benchmarks.append({"name": f"probe/{name}", "source": source, "n": 10000, "expect": "10000", "expression": expression})
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
    "sourceSha256": {path: sha(root / path) for path in ("impl/zig/src/decimal/decimal.zig", "impl/zig/src/value.zig", "impl/zig/src/machine/costs.zig", "bench/zig/host.c")},
    "manifestSha256": sha(root / "bench/scripts/benchmarks.json"),
    "measurementScriptSha256": sha(Path(__file__)),
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
            for key in ("hostBytes", "hostAllocs", "hostFrees", "groupUsed", "groupPeak"):
                assert before_probe[key] == after_probe[key], (name, key)
            result["measurements"].append({
                "pair": pair + 1, "name": name,
                "n": benchmark["n"], "expect": benchmark["expect"], "slice": slice_size,
                "expression": benchmark.get("expression"),
                "sourceSha256": sha(benchmark.get("source", root / "bench/scripts" / f"{benchmark.get('script', benchmark['name'])}.talk")),
                "before": before, "after": after,
                "beforeProbe": before_probe, "afterProbe": after_probe,
            })
            args.out.write_text(json.dumps(result, indent=2) + "\n")
            print(f"pair {pair + 1} {name}: {statistics.median(before['run']) / 1e6:.3f} -> {statistics.median(after['run']) / 1e6:.3f} ms", flush=True)

if args.profiles:
    import gzip
    import re
    import time
    args.profiles.mkdir(parents=True, exist_ok=True)
    result["profiles"] = []
    for label, host in (("before", args.before), ("after", args.after)):
        for b in benchmarks:
            if b["name"] not in ("core/loop", "probe/equal-exponent", "probe/cohort", "probe/extreme-gap"):
                continue
            name = f"{label}-{b['name'].replace('/', '-')}"
            report_path = Path(temporary.name) / f"{name}.txt"
            source = b.get("source", root / "bench/scripts" / f"{b['name']}.talk")
            process = subprocess.Popen([str(host.resolve()), str(source), str(b["n"]), b["expect"], "0", "100000", "0"], env=timing_env, stdout=subprocess.DEVNULL)
            try:
                time.sleep(.1)
                subprocess.run(["sample", str(process.pid), "2", "1", "-file", str(report_path)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            finally:
                if process.poll() is None:
                    process.terminate()
                process.wait()
            report = report_path.read_text()
            graph = report.split("Call graph:\n", 1)[1].split("\nTotal number in stack", 1)[0]
            nodes, stack = [], []
            for line in graph.splitlines():
                m = re.match(r"^([ +!:|]*)(\d+) (.+)$", line)
                if not m:
                    continue
                depth, count = len(m[1]), int(m[2])
                symbol = m[3].split("  (in ", 1)[0].split(" + ", 1)[0]
                while stack and nodes[stack[-1]]["depth"] >= depth:
                    stack.pop()
                node = {"depth": depth, "self": count, "symbol": symbol, "path": [nodes[i]["symbol"] for i in stack] + [symbol]}
                if stack:
                    nodes[stack[-1]]["self"] -= count
                stack.append(len(nodes))
                nodes.append(node)
            categories = {"pump": None, "order": "decimal.decimal.Decimal.order", "format": "fmt.", "decimal": "decimal.decimal."}
            counts = dict.fromkeys(categories, 0)
            for node in nodes:
                assert node["self"] >= 0
                if "talk_pump" not in node["path"]:
                    continue
                for category, pattern in categories.items():
                    if pattern is None or any(pattern in symbol for symbol in node["path"]):
                        counts[category] += node["self"]
            assert counts["pump"] >= 500, (name, counts)
            artifact = args.profiles / f"{name}.txt.gz"
            artifact.write_bytes(gzip.compress(report.encode(), mtime=0))
            result["profiles"].append({"binary": label, "name": b["name"], "durationSeconds": 2, "intervalMs": 1, "report": artifact.name, "reportSha256": sha(artifact), "samples": counts})
            args.out.write_text(json.dumps(result, indent=2) + "\n")
            print(f"profiled {name}: {counts}", flush=True)

temporary.cleanup()
