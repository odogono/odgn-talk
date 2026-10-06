"""Measures the Benchmark Suite's Python ports in-process and prints their
measurements as JSON. `bun run bench` runs it through uv, which provides the
CPython that .python-version pins. bench/README.md describes the suite."""

import argparse
import importlib.util
import json
import statistics
import sys
import time
import tracemalloc
from pathlib import Path

sys.dont_write_bytecode = True

HERE = Path(__file__).parent
MANIFEST = HERE.parent.parent / "scripts" / "benchmarks.json"

# Each repeat runs the port enough times to take at least this long, as
# timeit's autorange does, so that the timer's resolution doesn't matter.
REPEAT_NS = 50_000_000


def load(benchmark):
    """Compile and import a Benchmark's port, returning its `run`."""
    path = HERE / f"{benchmark['name']}.py"
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.run


def check(benchmark, size):
    """Load a port and confirm one Run produces the Script's expected output."""
    run = load(benchmark)
    output = str(run(size["n"]))
    if output != size["expect"]:
        raise ValueError(
            f"{benchmark['name']} on cpython: output {output}, expected {size['expect']}"
        )
    return run


def per_run_ns(run, n, loops):
    start = time.perf_counter_ns()
    for _ in range(loops):
        run(n)
    return (time.perf_counter_ns() - start) / loops


def autorange(run, n):
    loops = 1
    while per_run_ns(run, n, loops) * loops < REPEAT_NS:
        loops *= 2
    return loops


def peak_bytes(run, n):
    """The most memory one Run holds at once, as tracemalloc traces it."""
    tracemalloc.start()
    run(n)
    peak = tracemalloc.get_traced_memory()[1]
    tracemalloc.stop()
    return peak


def measure(benchmark, smoke, count):
    size = benchmark["smoke"] if smoke else benchmark
    run = check(benchmark, size)
    n = size["n"]
    if smoke:
        samples = [per_run_ns(run, n, 1)]
    else:
        loops = autorange(run, n)
        samples = [per_run_ns(run, n, loops) for _ in range(count)]
    return {
        "benchmark": benchmark["name"],
        "hostBytes": peak_bytes(run, n),
        "run": {
            "medianNs": statistics.median(samples),
            "minNs": min(samples),
            "samples": len(samples),
        },
        "runner": "cpython",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--filter", default="")
    parser.add_argument("--smoke", action="store_true")
    parser.add_argument("--count", type=int, default=10)
    args = parser.parse_args()
    benchmarks = json.loads(MANIFEST.read_text())["benchmarks"]
    try:
        measurements = [
            measure(b, args.smoke, args.count)
            for b in benchmarks
            if args.filter in b["name"] and "peers" not in b.get("skip", {})
        ]
    except (OSError, ValueError) as e:
        sys.exit(str(e))
    print(json.dumps(measurements))


if __name__ == "__main__":
    main()
