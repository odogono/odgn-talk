"""Paired Character indexing timings, scaling and separate allocation probes.

Build two bench/zig/host.c binaries as measure-zig.ts does. Fixed-index probes
return the selected Character directly, without modulo, equality or summation.
The manifest workloads retain the full application and text regression checks.
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
env = dict(os.environ)
env.pop("NORTHTALK_BENCH_ALLOCATIONS", None)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(host, b, probe=False):
    command = [str(host.resolve()), str(b["source"]), str(b["n"]), b["expect"],
               "0", str(1 if probe else args.count), "1" if probe else "0"]
    return json.loads(subprocess.check_output(command, env={**env, "NORTHTALK_BENCH_ALLOCATIONS": "1"} if probe else env))


sources = ["impl/zig/src/machine/chunks.zig", "impl/zig/src/unicode/grapheme.zig", "bench/zig/host.c"]
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
    "measurements": [],
}
args.out.parent.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix="northtalk-characters-") as temporary:
    workloads = [{**b, "source": root / "bench/scripts" / f"{b['name']}.talk"}
                 for b in json.loads((root / "bench/scripts/benchmarks.json").read_text())["benchmarks"]
                 if b["name"].startswith("text/")]
    for size in (16, 256, 4096):
        for label, index in (("early", "8"), ("late", str(size)), ("last", "-1")):
            name = f"ascii-{size}-{label}"
            source = Path(temporary) / f"{name}.talk"
            source.write_text('on run n\n  put "" into selected\n  repeat n times\n'
                              f'    put character {index} of "{"x" * size}" into selected\n'
                              '  end repeat\n  return selected\nend run\n')
            workloads.append({"name": f"probe/{name}", "source": source, "n": 1000, "expect": '"x"'})
    source = Path(temporary) / "unicode.talk"
    source.write_text('on run n\n  put "" into selected\n  repeat n times\n'
                      '    put character 3 of "éq́👨‍👩‍👧🇬🇧" into selected\n'
                      '  end repeat\n  return selected\nend run\n')
    workloads.append({"name": "probe/unicode", "source": source, "n": 1000, "expect": '"👨‍👩‍👧"'})
    if args.filter:
        workloads = [b for b in workloads if any(f in b["name"] for f in args.filter)]
        if not workloads:
            parser.error("filter selects no workloads")
    for pair in range(args.pairs):
        for b in workloads:
            hosts = [("before", args.before), ("after", args.after)]
            if pair % 2:
                hosts.reverse()
            timings = {label: run(host, b) for label, host in hosts}
            probes = {label: run(host, b, True) for label, host in hosts}
            for key in ("fuel", "logicalAlloc"):
                assert timings["before"][key] == timings["after"][key] == probes["before"][key] == probes["after"][key], (b["name"], key)
            result["measurements"].append({"pair": pair + 1, "name": b["name"], "n": b["n"], "expect": b["expect"],
                                           "sourceSha256": sha(b["source"]), **timings,
                                           "beforeProbe": probes["before"], "afterProbe": probes["after"]})
            args.out.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
            print(f"pair {pair + 1} {b['name']}: " + " -> ".join(f"{statistics.median(timings[label]['run']) / 1e6:.3f}" for label in ("before", "after")) + " ms", flush=True)
