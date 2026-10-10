"""Attach provenance and payload sizes to the C Host's raw observations."""

import datetime
import gzip
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import zlib


def command(*args):
    return subprocess.check_output(args, text=True).strip()


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


wasm = Path(sys.argv[1])
result = Path("out/measurements.json")
data = json.loads(result.read_text())
payload = wasm.read_bytes()
# Use Brotli's CLI, at its highest quality, so no Python package is required.
brotli = subprocess.check_output(["brotli", "--quality=11", "--lgwin=22", "--stdout", str(wasm)])
if gzip.decompress(gzip.compress(payload, compresslevel=9, mtime=0)) != payload:
    raise SystemExit("gzip round trip differs")
if subprocess.check_output(["brotli", "--decompress", "--stdout"], input=brotli) != payload:
    raise SystemExit("Brotli round trip differs")
data["payload"] = {
    "sha256": digest(wasm),
    "raw_bytes": len(payload),
    "gzip_9_bytes": len(gzip.compress(payload, compresslevel=9, mtime=0)),
    "brotli_11_bytes": len(brotli),
    "brotli_lgwin": 22,
}
data["provenance"] = {
    "date_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "checkout_commit": command("git", "rev-parse", "HEAD"),
    "checkout_status": command("git", "status", "--short"),
    "go_source_status": command("git", "-C", "../..", "status", "--short", "--", "impl/go"),
    "reactor_revision": os.environ.get("REACTOR_REVISION", "external build; revision unspecified"),
    "host_sha256": digest("host.c"),
    "runner_sha256": digest("run.sh"),
    "metadata_sha256": digest("metadata.py"),
    "executable_sha256": digest("out/host"),
    "cjson_c_sha256": digest("out/cjson/cJSON.c"),
    "cjson_h_sha256": digest("out/cjson/cJSON.h"),
    "os": platform.platform(),
    "arch": platform.machine(),
    "cpu": command("sysctl", "-n", "machdep.cpu.brand_string")
    if sys.platform == "darwin" else platform.processor(),
    "cc": command(os.environ.get("CC", "cc"), "--version"),
    "go": command("go", "version"),
    "python": platform.python_version(),
    "zlib": zlib.ZLIB_RUNTIME_VERSION,
    "brotli": command("brotli", "--version"),
    "cjson": "1.7.19",
    "samples": len(data["idle_pump_us"]),
    "iterations": data["calls_per_pump"],
    "memory_backstop_bytes": 256 * 1024 * 1024,
    "reactor_build_flags": os.environ.get("REACTOR_BUILD_FLAGS", "external build; flags unspecified"),
    "cflags": os.environ.get("CFLAGS", ""),
    "ldflags": os.environ.get("LDFLAGS", ""),
    "wasmtime_prefix": os.environ.get("WASMTIME_PREFIX", ""),
    "threshold_decision": "The thresholds block is judged against #532 in docs/research/message-layer-measurements.md (#554); the rest is descriptive.",
}
source = os.environ.get("REACTOR_SOURCE")
if source:
    data["provenance"]["reactor_source_sha256"] = digest(source)
result.write_text(json.dumps(data, indent=2) + "\n")
print(f"Measurements and provenance: {result}")
