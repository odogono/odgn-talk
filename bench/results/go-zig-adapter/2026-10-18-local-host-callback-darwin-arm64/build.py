"""Build the six binaries used by this recorded callback experiment."""

import argparse
import json
import os
import pathlib
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument("output", type=pathlib.Path)
parser.add_argument("--repo", type=pathlib.Path, default=pathlib.Path.cwd())
parser.add_argument("--base", default="6367550539486ccdbfd2312b3bc0ec2eb56f73e4")
args = parser.parse_args()
repo, out = args.repo.resolve(), args.output.resolve()
out.mkdir(parents=True, exist_ok=True)
replace = {}
for name in ["zig_capability.go", "zig_object.go"]:
    before = out / ("before-" + name)
    before.write_bytes(subprocess.check_output(["git", "show", args.base + ":impl/go/" + name], cwd=repo))
    replace[str(repo / "impl/go" / name)] = str(before)
overlay = out / "before-overlay.json"
overlay.write_text(json.dumps({"Replace": replace}))
for backend in ["native", "before", "after"]:
    for area, package in [("host", "bench/go"), ("backend", "impl/go")]:
        command = ["go", "-C", str(repo / package), "test", "-c"]
        if backend != "native":
            command += ["-tags", "talk_zig_experimental"]
        if backend == "before":
            command += ["-overlay=" + str(overlay)]
        command += ["-o", str(out / (backend + "-" + area + ".test"))]
        subprocess.run(command, env=dict(os.environ, CGO_ENABLED="0"), check=True)
