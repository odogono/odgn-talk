#!/bin/sh
# Cross-compile check, also run in CI: the spike, both sides of the
# native/adapter comparison and the adapter facilities must build without
# cgo for every target, as must the Session Host, drivers and CLI. Builds
# only; nothing runs.
set -eu
cd "$(dirname "$0")"
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
export CGO_ENABLED=0
for target in linux/amd64 linux/arm64 darwin/arm64; do
  export GOOS="${target%/*}" GOARCH="${target#*/}"
  echo "== $target"
  go -C ../../spikes/go-zig-binding test -c -o "$out/probe.test" .
  go test -c -o "$out/native.test" .
  go test -c -tags talk_zig_experimental -o "$out/adapter.test" .
  mkdir -p "$out/facilities" "$out/sqlite"
  go test -c -tags talk_zig_experimental -o "$out/facilities/" ./session ./driver ./store ./internal/storekit ./examples/tenants
  go build -tags talk_zig_experimental -o "$out/northtalk" ./cmd/northtalk
  go build -tags talk_zig_experimental -o "$out/tenants" ./examples/tenants
  (cd sqlite && go test -c -tags talk_zig_experimental -o "$out/sqlite/" ./...)
done
