#!/usr/bin/env python3
"""Maintainer-only artifact build; consumers use the checked-in embedded bytes."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

here = Path(__file__).resolve().parent
root = here.parent.parent

def output(*args):
    return subprocess.check_output(args, cwd=root, text=True).strip()

# Never label a locally modified Core as a build of an unmodified commit.
if output("git", "status", "--porcelain", "--", "impl/zig", "spec", "GLOSSARY.md"):
    raise SystemExit("Commit Core/spec changes before recording artifact provenance")
subprocess.run(["zig", "build", "-Dtarget=wasm32-wasi", "-Doptimize=safe"], cwd=root / "impl/zig", check=True)
artifact = here / "talk.wasm"
shutil.copyfile(root / "impl/zig/zig-out/bin/talk.wasm", artifact)
artifact.chmod(0o644)
metadata = {
    "sourceCommit": output("git", "rev-parse", "HEAD"),
    "zig": output("zig", "version"),
    "target": "wasm32-wasi",
    "optimize": "safe",
    "sha256": hashlib.sha256(artifact.read_bytes()).hexdigest(),
}
(here / "artifact.json").write_text(json.dumps(metadata, indent=2) + "\n")
