#!/bin/sh
# Swaps an uncommitted Zig Core into the Go adapter's embedded copy, with the
# digest NewEngine checks. Never commit the result: restore it with
# `git checkout -- impl/go/internal/zigwasm`, then, once the Zig change is
# committed, run `python3 impl/go/build-artifact.py`.
set -eu
root="$(cd "$(dirname "$0")/../.." && pwd)"
(cd "$root/impl/zig" && zig build -Dtarget=wasm32-wasi -Doptimize=safe)
cp "$root/impl/zig/zig-out/bin/talk.wasm" "$root/impl/go/internal/zigwasm/talk.wasm"
python3 - "$root/impl/go/internal/zigwasm" <<'EOF'
import hashlib, json, sys
from pathlib import Path
d = Path(sys.argv[1])
meta = json.loads((d / "artifact.json").read_text())
meta["sha256"] = hashlib.sha256((d / "talk.wasm").read_bytes()).hexdigest()
# The bytes are no longer the recorded build, so say so in CoreVersions.
meta["reactor"] = meta.get("reactor", "0.0.0").split("+")[0] + "+hand-swap"
(d / "artifact.json").write_text(json.dumps(meta, indent=2) + "\n")
EOF
echo "hand-swap: impl/go/internal/zigwasm now holds the working tree's Zig Core; restore with git checkout -- impl/go/internal/zigwasm" >&2
