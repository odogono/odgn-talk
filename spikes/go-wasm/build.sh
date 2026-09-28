#!/usr/bin/env bash
# Builds every variant the spike measures into out/.
# TinyGo 0.42 cannot compile Go 1.27's hash/maphash (needed by starlark-go),
# so TinyGo builds against a Go 1.26 GOROOT: `go install golang.org/dl/go1.26.6@latest && go1.26.6 download`.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p out
G126=${G126:-$HOME/sdk/go1.26.6}
tiny() { GOTOOLCHAIN=local PATH="$G126/bin:$PATH" GOROOT="$G126" tinygo build -target=wasip1 -buildmode=c-shared -no-debug -stack-size=1MB "$@" ./cmd/wasm; }
gow() { GOOS=wasip1 GOARCH=wasm go build -buildmode=c-shared -trimpath -ldflags=-s "$@" ./cmd/wasm; }

# TinyGo's default 64 KiB goroutine stack overflows at Starlark call depth ~15; see the findings.
tiny -o out/tiny-vm.wasm
tiny -tags starlark -o out/tiny-star.wasm
tiny -opt=2 -o out/tiny-vm-o2.wasm
tiny -opt=2 -tags starlark -o out/tiny-star-o2.wasm
tiny -tags starlark -stack-size=64KB -o out/tiny-star-stack64k.wasm
tiny -tags starlark -panic=trap -o out/tiny-star-trap.wasm
# Link-time memory import with a module-declared maximum (64 MiB).
tiny -target=./tiny-importmem.json -tags starlark -o out/tiny-star-importmem.wasm
gow -o out/go-vm.wasm
gow -tags starlark -o out/go-star.wasm
# Reference only: the GOOS=js build most browser users ship.
GOOS=js GOARCH=wasm go build -trimpath -ldflags=-s -tags starlark -o out/go-star-js.wasm ./cmd/wasm
for f in out/go-vm out/go-star; do wasm-opt -Oz --enable-bulk-memory --enable-sign-ext --enable-nontrapping-float-to-int "$f.wasm" -o "$f-wasmopt.wasm"; done
go build -tags starlark -o out/native ./cmd/native
