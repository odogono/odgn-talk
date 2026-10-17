#!/bin/sh
# Measures native Go against the Zig adapter on this machine (#1054): the
# Backend benchmarks and Group instantiation in this package, then the
# Benchmark Suite's Load and Run, each built without and with
# talk_zig_experimental. Writes raw output, the versions and a benchstat
# comparison to the directory given, or to bench/results/go-zig-adapter/.
# COUNT sets -count (5 by default).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
platform=$(go env GOOS)-$(go env GOARCH)
out=${1:-$root/bench/results/go-zig-adapter/$(date +%F)-$platform}
count=${COUNT:-5}
benchstat=golang.org/x/perf/cmd/benchstat@v0.0.0-20261009192801-be2c69fb417e
export CGO_ENABLED=0
mkdir -p "$out"

{
	echo "commit $(git -C "$root" rev-parse HEAD)"
	go version
	echo "wazero $(go -C "$here" list -m -f '{{.Version}}' github.com/tetratelabs/wazero)"
	echo "artifact $(tr -d '\n ' < "$here/internal/zigwasm/artifact.json")"
	uname -a
	echo "count $count"
} > "$out/env.txt"

for backend in native zig; do
	tags=
	[ "$backend" = zig ] && tags=talk_zig_experimental
	file="$out/$backend.txt"
	: > "$file"
	# Fixed iteration counts: a deferred call's cost may depend on how many
	# came before it, so b.N must not differ between backends.
	go -C "$here" test -tags "$tags" -run '^$' -bench '^BenchmarkBackend(Request|DeferredCall|MultiGroup)$' -benchmem -benchtime 2000x -count "$count" -timeout 0 . >> "$file"
	go -C "$here" test -tags "$tags" -run '^$' -bench '^BenchmarkGroupInstantiation$' -benchmem -benchtime 200x -count "$count" -timeout 0 . >> "$file"
	go -C "$here" test -tags "$tags" -run '^$' -bench '^BenchmarkBackend(ColdStart|RetainedMemory)$' -benchtime 3x -count "$count" -timeout 0 . >> "$file"
	go -C "$root/bench/go" test -tags "$tags" -run '^$' -bench '^Benchmark(Load|Run)$' -benchmem -count "$count" -timeout 0 . >> "$file"
done

go -C "$here" run "$benchstat" native="$out/native.txt" zig="$out/zig.txt" > "$out/comparison.txt"
echo "$out"
