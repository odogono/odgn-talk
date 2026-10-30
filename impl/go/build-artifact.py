#!/usr/bin/env python3
"""Maintainer-only artifact build; consumers use the checked-in embedded bytes.

With no argument, builds the Zig Core at HEAD and records `git describe`'s
version, such as 0.15.0-3-gabc1234, for a Zig change not yet released. With a
reactor-v* tag, builds that release's tree and records its version, as a Go
release should."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile

here = Path(__file__).resolve().parent
root = here.parent.parent
destination = here / "internal/zigwasm"

def output(*args, cwd=root):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()

def build(tree):
    subprocess.run(["zig", "build", "-Dtarget=wasm32-wasi", "-Doptimize=safe"], cwd=tree / "impl/zig", check=True)
    return (tree / "impl/zig/zig-out/bin/talk.wasm").read_bytes()

with tempfile.TemporaryDirectory() as scratch:
    if len(sys.argv) > 1:
        tag = sys.argv[1]
        if not tag.startswith("reactor-v"):
            raise SystemExit(f"{tag} is not a reactor-v* tag")
        commit = output("git", "rev-parse", f"{tag}^{{commit}}")
        tree = Path(scratch) / "tree"
        subprocess.run(["git", "worktree", "add", "--detach", str(tree), commit], cwd=root, check=True)
        try:
            artifact = build(tree)
        finally:
            subprocess.run(["git", "worktree", "remove", "--force", str(tree)], cwd=root, check=True)
        reactor = tag.removeprefix("reactor-v")
    else:
        # Never label a locally modified Core as a build of an unmodified commit.
        if output("git", "status", "--porcelain", "--", "impl/zig", "spec", "GLOSSARY.md"):
            raise SystemExit("Commit Core/spec changes before recording artifact provenance")
        commit = output("git", "rev-parse", "HEAD")
        artifact = build(root)
        reactor = output("git", "describe", "--tags", "--match", "reactor-v*", commit).removeprefix("reactor-v")

metadata = {
    "reactor": reactor,
    "sourceCommit": commit,
    "zig": output("zig", "version"),
    "target": "wasm32-wasi",
    "optimize": "safe",
    "sha256": hashlib.sha256(artifact).hexdigest(),
}
binary = destination / "talk.wasm"
binary.write_bytes(artifact)
binary.chmod(0o644)
(destination / "artifact.json").write_text(json.dumps(metadata, indent=2) + "\n")
