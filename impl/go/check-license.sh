#!/bin/sh
# Fails when a Go module's LICENSE differs from the repository's, since the
# module zips that pkg.go.dev reads hold only the module's own directory.
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
status=0
for copy in impl/go/LICENSE impl/go/sqlite/LICENSE; do
  if ! cmp -s "$root/LICENSE" "$root/$copy"; then
    echo "$copy differs from LICENSE; run: cp LICENSE $copy" >&2
    status=1
  fi
done
[ "$status" -eq 0 ] && echo "Go module licences match LICENSE"
exit "$status"
