#!/bin/sh
# Cross-compile check, also run in CI: the Zig-backed build and
# the facilities must build without cgo for every target, as must the
# Session Host, drivers and CLI. Builds only; nothing runs.
set -eu
cd "$(dirname "$0")"
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
export CGO_ENABLED=0
for target in linux/amd64 linux/arm64 darwin/arm64; do
  export GOOS="${target%/*}" GOARCH="${target#*/}"
  echo "== $target"
  go test -c -o "$out/adapter.test" .
  mkdir -p "$out/facilities" "$out/sqlite"
  go test -c -o "$out/facilities/" ./session ./driver ./store ./internal/storekit ./examples/tenants
  go build -o "$out/northtalk" ./cmd/northtalk
  go build -o "$out/tenants" ./examples/tenants
  (cd sqlite && go test -c -o "$out/sqlite/" ./...)
done
