#!/bin/sh
# Checks that each named Go module is tidy. `go mod tidy` ignores go.work, so
# this adds a replace for every workspace module to a copy of the module and
# tidies that, with the workspace off. Usage: tidy-check.sh <module dir>...
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
replaces=$(go -C "$root" work edit -json | sed -n 's/.*"DiskPath": "\.\/\(.*\)".*/\1/p' | while read -r dir; do
  echo "-replace=$(GOWORK=off go -C "$root/$dir" list -m)=$root/$dir"
done)
status=0
for m in "$@"; do
  copy="$work/$(echo "$m" | tr / _)"
  mkdir -p "$copy"
  cp -R "$root/$m/." "$copy"
  # shellcheck disable=SC2086
  GOWORK=off go -C "$copy" mod edit $replaces
  if ! GOWORK=off go -C "$copy" mod tidy -diff; then
    echo "$m is not tidy" >&2
    status=1
  fi
done
exit "$status"
