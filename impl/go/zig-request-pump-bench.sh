#!/bin/sh
# The #1245/#1254 envelope gates on this machine: the unchanged
# BackendRequest and the combined Request (and, recorded only, the combined
# Function call) for native Go and for the Zig adapter over JSON and the
# fields exchange, plus native BackendRequest at BASE (the commit before
# the experiment) for the no-regression check. Samples are interleaved, one
# round per backend at a time, so drift affects every backend alike. Writes
# raw output, the environment, paired ratios and a benchstat comparison to
# the directory given, or to bench/results/go-zig-adapter/. COUNT sets the
# rounds (10); ITERATIONS sets equal work per sample (20000).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
platform=$(go env GOOS)-$(go env GOARCH)
out=${1:-$root/bench/results/go-zig-adapter/$(date +%F)-request-pump-$platform}
count=${COUNT:-10}
iterations=${ITERATIONS:-20000}
for n in "$count" "$iterations"; do
	case "$n" in ''|*[!0-9]*|0*) echo 'COUNT and ITERATIONS must be positive integers without leading zeros' >&2; exit 1 ;; esac
done
base=${BASE:-ff543e29}
benchstat=golang.org/x/perf/cmd/benchstat@v0.0.0-20261009192801-be2c69fb417e
export CGO_ENABLED=0
mkdir -p "$out"
out=$(cd "$out" && pwd)
bin=$(mktemp -d)
trap 'git -C "$root" worktree remove --force "$bin/base" 2>/dev/null || true; rm -rf "$bin"' EXIT

git -C "$root" worktree add --detach "$bin/base" "$base" > /dev/null
go -C "$bin/base/impl/go" test -c -o "$bin/base.test" .
go -C "$here" test -c -o "$bin/native.test" .
go -C "$here" test -c -tags talk_zig_experimental -o "$bin/zig.test" .

{
	echo "commit $(git -C "$root" rev-parse HEAD)"
	echo "base $(git -C "$root" rev-parse "$base")"
	go version
	echo "wazero $(go -C "$here" list -m -f '{{.Version}}' github.com/tetratelabs/wazero)"
	echo "artifact $(tr -d '\n ' < "$here/internal/zigwasm/artifact.json")"
	uname -a
	echo "rounds $count, $iterations iterations each, interleaved"
} > "$out/env.txt"

request='^BenchmarkBackendRequest$'
all='^BenchmarkBackend(Request|RequestPump|CallPump)$'
run() { # file binary pattern [env]
	file=$1 binary=$2 pattern=$3
	shift 3
	env "$@" "$binary" -test.run '^$' -test.bench "$pattern" -test.benchmem -test.benchtime "${iterations}x" -test.count 1 -test.timeout 0 >> "$out/$file.txt"
}
for f in base native zig-json zig-fields; do : > "$out/$f.txt"; done
i=0
while [ "$i" -lt "$count" ]; do
	run base "$bin/base.test" "$request"
	run native "$bin/native.test" "$all"
	run zig-json "$bin/zig.test" "$request" TALK_ZIG_REQUEST_PUMP=
	run zig-fields "$bin/zig.test" "$all" TALK_ZIG_REQUEST_PUMP=fields
	i=$((i + 1))
done

cd "$out"
go -C "$here" run ./cmd/request-pump-report -rounds "$count" "$out" > "$out/paired.txt"
go -C "$here" run "$benchstat" -table '' "$out/base.txt" "$out/native.txt" > "$out/regression.txt" 2>&1 || true
go -C "$here" run "$benchstat" native="$out/native.txt" json="$out/zig-json.txt" fields="$out/zig-fields.txt" > "$out/comparison.txt"
echo "$out"
