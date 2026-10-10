#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ $# -gt 1 ]]; then
  echo 'Usage: run.sh [reactor.wasm]' >&2
  exit 1
fi
for program in python3 brotli "${CC:-cc}"; do
  command -v "$program" >/dev/null || { echo "Required program missing: $program" >&2; exit 1; }
done

# Use an explicit reactor path when measuring an unmerged #551 build.
wasm=${1:-out/messagelayer.wasm}
if [[ $# == 0 ]]; then
  if [[ ! -d ../../impl/go/cmd/messagelayer-wasi ]]; then
    echo 'The reactor requires #551; pass the path to an explicit reactor build.' >&2
    exit 1
  fi
  mkdir -p out
  GOOS=wasip1 GOARCH=wasm go -C ../../impl/go build -buildmode=c-shared \
    -trimpath -buildvcs=false -ldflags='-s -w' \
    -o ../../bench/message-layer-c/out/messagelayer.wasm ./cmd/messagelayer-wasi
  export REACTOR_REVISION="$(git rev-parse HEAD)"
  export REACTOR_SOURCE=../../impl/go/cmd/messagelayer-wasi/main_wasip1.go
  export REACTOR_BUILD_FLAGS='GOOS=wasip1 GOARCH=wasm -buildmode=c-shared -trimpath -buildvcs=false -ldflags="-s -w"'
fi
export WASMTIME_PREFIX
if [[ ! -f "$wasm" ]]; then
  echo "Reactor not found: $wasm (requires #551)" >&2
  exit 1
fi

if [[ -z ${WASMTIME_PREFIX:-} ]]; then
  if command -v brew >/dev/null; then
    WASMTIME_PREFIX=$(brew --prefix wasmtime)
  else
    echo 'Set WASMTIME_PREFIX to the Wasmtime C API installation.' >&2
    exit 1
  fi
fi

# Keep the JSON dependency outside the checkout; verify the pinned source.
mkdir -p out/cjson
for file in cJSON.c cJSON.h; do
  if [[ ! -f out/cjson/$file ]]; then
    curl -fsSL "https://raw.githubusercontent.com/DaveGamble/cJSON/v1.7.19/$file" -o "out/cjson/$file"
  fi
done
python3 - <<'PY'
import hashlib
from pathlib import Path
for name, expected in {
    'cJSON.c': '298581a04a36c0165da4b0aade235c23088cb2faa58651d720ea2f3706ed0b0d',
    'cJSON.h': '25b0145150d500498e4d209cec69c18c42cf818bffcc54690be3b895a2a16dee',
}.items():
    if hashlib.sha256(Path('out/cjson', name).read_bytes()).hexdigest() != expected:
        raise SystemExit(f'Pinned cJSON checksum mismatch: {name}')
PY

# Apple's SDK deprecates sprintf used by the pinned upstream JSON library.
"${CC:-cc}" -std=c11 -O2 -Wall -Wextra -Werror -Wno-deprecated-declarations ${CFLAGS:-} \
  -Iout/cjson -c out/cjson/cJSON.c -o out/cjson/cJSON.o
"${CC:-cc}" -std=c11 -O2 -Wall -Wextra -Werror ${CFLAGS:-} \
  -I"$WASMTIME_PREFIX/include" -Iout/cjson host.c out/cjson/cJSON.o \
  -L"$WASMTIME_PREFIX/lib" -Wl,-rpath,"$WASMTIME_PREFIX/lib" \
  -lwasmtime -lm ${LDFLAGS:-} -o out/host
out/host "$wasm" "${SAMPLES:-7}" "${ITERATIONS:-1000}" "${INSTANCES:-8}" | tee out/measurements.json
python3 metadata.py "$wasm"
