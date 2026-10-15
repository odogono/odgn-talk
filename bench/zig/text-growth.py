"""Paired Text growth timings, scalar regressions and separate allocation probes.

Build two bench/zig/host.c binaries as measure-zig.ts does. ASCII and Unicode
probes vary the number and length of appends, returning the Character count.
The complete supported manifest suite checks broader regressions. Copy volumes
are derived from the generated inputs, not measured memory-bus traffic.
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
parser.add_argument("--profiles-only", action="store_true", help="add CPU captures to an existing result with the same binaries and sources")
parser.add_argument("--out", type=Path, required=True)
args = parser.parse_args()
if args.pairs < 1 or args.count < 1:
    parser.error("pairs and count must be positive")
root = Path(__file__).resolve().parents[2]
env = dict(os.environ)
env.pop("NORTHTALK_BENCH_ALLOCATIONS", None)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(host, b, probe=False):
    command = [str(host.resolve()), str(b["source"]), str(b["n"]), b["expect"],
               "0", str(1 if probe else args.count), "1" if probe else "0"]
    return json.loads(subprocess.check_output(command, env={**env, "NORTHTALK_BENCH_ALLOCATIONS": "1"} if probe else env))


sources = ["impl/zig/src/value.zig", "impl/zig/src/machine/machine.zig", "impl/zig/src/machine/chunks.zig", "impl/zig/src/machine/costs.zig", "bench/zig/host.c"]
result = {
    "recordedAt": datetime.now(timezone.utc).isoformat(),
    "baselineRevision": args.before_revision,
    "checkoutRevision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip(),
    "platform": platform.platform(),
    "cpu": subprocess.check_output(["sysctl", "-n", "machdep.cpu.brand_string"], text=True).strip() if platform.system() == "Darwin" else platform.processor(),
    "zig": subprocess.check_output(["zig", "version"], text=True).strip(),
    "cc": subprocess.check_output(["cc", "--version"], text=True).splitlines()[0],
    "mode": "safe", "hostBuild": "cc -std=c11 -O2 -Wall -Wextra -Werror",
    "language": tomllib.loads((root / "spec/data/version.toml").read_text())["language"],
    "costModel": tomllib.loads((root / "spec/data/costs.toml").read_text())["version"],
    "samplesPerProcess": args.count, "pairs": args.pairs,
    "binarySha256": {name: sha(host) for name, host in (("before", args.before), ("after", args.after))},
    "sourceSha256": {path: sha(root / path) for path in sources},
    "manifestSha256": sha(root / "bench/scripts/benchmarks.json"),
    "baselineSourceSha256": {path: hashlib.sha256(subprocess.check_output(["git", "show", f"{args.before_revision}:{path}"], cwd=root)).hexdigest() for path in sources},
    "measurementScriptSha256": sha(Path(__file__)),
    "trackedDiffSha256": hashlib.sha256(subprocess.check_output(["git", "diff", "--", *sources], cwd=root)).hexdigest(),
    "measurements": [],
}
if args.profiles_only:
    if not args.profiles or not args.out.exists():
        parser.error("profiles-only requires profiles and an existing out file")
    previous = json.loads(args.out.read_text())
    for key in ("binarySha256", "sourceSha256", "baselineRevision"):
        assert previous[key] == result[key], key
    result = previous
    result["profileScriptSha256"] = sha(Path(__file__))
args.out.parent.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix="northtalk-text-growth-") as temporary:
    workloads = [{**b, "source": root / "bench/scripts" / f"{b.get('script', b['name'])}.talk"}
                 for b in json.loads((root / "bench/scripts/benchmarks.json").read_text())["benchmarks"]
                 if not b.get("skip", {}).get("zig")]
    # Stable grapheme boundaries between copies: four Characters per unit.
    unicode_unit = "éq́👨‍👩‍👧🇬🇧"
    for kind, chunk, characters in (("ascii", "abc", 3), ("unicode", unicode_unit, 4)):
        for n in (32, 256, 2048):
            workloads.append({"name": f"growth/{kind}-{n}", "chunk": chunk,
                              "n": n, "expect": str(n * characters)})
    workloads.append({"name": "growth/ascii-8192", "chunk": "abc", "n": 8192, "expect": str(8192 * 3)})
    for kind, unit, characters in (("ascii", "x", 1), ("unicode", unicode_unit, 4)):
        for length in (1, 16, 256):
            # Unicode length 256 is intentionally omitted: the logical budget
            # would obscure the Run time of a completed large growth probe.
            if kind == "unicode" and length == 256:
                continue
            workloads.append({"name": f"length/{kind}-{length}", "chunk": unit * length,
                              "n": 128, "expect": str(128 * length * characters)})
    for b in workloads:
        if "chunk" not in b:
            continue
        source = Path(temporary) / (b["name"].replace("/", "-") + ".talk")
        source.write_text('on run n\n  put "" into output\n  repeat n times\n'
                          f'    put output & "{b["chunk"]}" into output\n'
                          '  end repeat\n  return the length of output\nend run\n')
        b["source"] = source
        # Both implementations copy the complete prefix into the joined
        # buffer. Unicode then rebuilds it through NFC. This is a lower bound
        # on explicit result byte writes, excluding NFC Entry arrays, nodes,
        # Host copies, allocator movement and scratch.
        b["joinedBytes"] = len(b["chunk"].encode()) * b["n"] * (b["n"] + 1) // 2
        b["explicitTextByteWrites"] = b["joinedBytes"] * (1 if b["chunk"].isascii() else 2)
    if args.filter:
        workloads = [b for b in workloads if any(f in b["name"] for f in args.filter)]
        if not workloads:
            parser.error("filter selects no workloads")
    for pair in range(0 if args.profiles_only else args.pairs):
        for b in workloads:
            hosts = [("before", args.before), ("after", args.after)]
            if pair % 2:
                hosts.reverse()
            timings = {label: run(host, b) for label, host in hosts}
            for key in ("fuel", "logicalAlloc"):
                assert timings["before"][key] == timings["after"][key], (b["name"], key)
            result["measurements"].append({"pair": pair + 1, "name": b["name"], "n": b["n"], "expect": b["expect"],
                                           "sourceSha256": sha(b["source"]), **timings,
                                           "joinedBytes": b.get("joinedBytes"),
                                           "explicitTextByteWrites": b.get("explicitTextByteWrites")})
            args.out.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
            print(f"pair {pair + 1} {b['name']}: " + " -> ".join(f"{statistics.median(timings[label]['run']) / 1e6:.3f}" for label in ("before", "after")) + " ms", flush=True)

    # Counting-allocator probes are a separate phase after every timing.
    for b in ([] if args.profiles_only else workloads):
        probes = {label: run(host, b, True) for label, host in (("before", args.before), ("after", args.after))}
        for row in result["measurements"]:
            if row["name"] != b["name"]:
                continue
            for key in ("fuel", "logicalAlloc"):
                assert row["before"][key] == row["after"][key] == probes["before"][key] == probes["after"][key], (b["name"], key)
            row.update({"beforeProbe": probes["before"], "afterProbe": probes["after"]})
        args.out.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")

    if args.profiles:
        import gzip
        import re
        import time
        args.profiles.mkdir(parents=True, exist_ok=True)
        result["profiles"] = []
        for label, host in (("before", args.before), ("after", args.after)):
            for b in workloads:
                if b["name"] not in ("text/build", "growth/ascii-8192", "growth/unicode-256"):
                    continue
                name = f"{label}-{b['name'].replace('/', '-')}"
                report_path = Path(temporary) / f"{name}.txt"
                source = b.get("source", root / "bench/scripts" / f"{b['name']}.talk")
                process = subprocess.Popen([str(host.resolve()), str(source), str(b["n"]), b["expect"], "0", "100000", "0"], env=env, stdout=subprocess.DEVNULL)
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
                categories = {"pump": (), "concat": ("value.concatText",), "validation": ("unicode.utf8.validate",), "normalization": ("unicode.normalize.",), "charging": ("machine.costs.",), "copy": ("memcpy", "memmove")}
                counts = dict.fromkeys(categories, 0)
                for node in nodes:
                    assert node["self"] >= 0
                    if "talk_pump" not in node["path"]:
                        continue
                    for category, patterns in categories.items():
                        if not patterns or any(pattern in symbol for symbol in node["path"] for pattern in patterns):
                            counts[category] += node["self"]
                artifact = args.profiles / f"{name}.txt.gz"
                artifact.write_bytes(gzip.compress(report.encode(), mtime=0))
                result["profiles"].append({"binary": label, "name": b["name"], "durationSeconds": 2, "intervalMs": 1, "report": artifact.name, "reportSha256": sha(artifact), "samples": counts})
                args.out.write_text(json.dumps(result, indent=2) + "\n")
                assert counts["pump"] >= 500, (name, counts)
                print(f"profiled {name}: {counts}", flush=True)
