#!/usr/bin/env bash
# Builds the reactor and the sidecar stand-in, then runs every check.
# Bun uses the go-wasm spike's WASI shim; the .exs files fetch Wasmex 0.15.1.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p out
GOOS=wasip1 GOARCH=wasm go build -buildmode=c-shared -trimpath -o out/spike.wasm .
go build -o out/sidecar ./sidecar
bun host.js
bun bench.js
elixir wasmex_check.exs
elixir wasmex_bench.exs
elixir wasmex_frame.exs
elixir wasmex_timeout.exs
elixir port_bench.exs
