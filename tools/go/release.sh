#!/bin/sh
# Runs the checks and notes of a Go release (impl/go/README.md, Releasing) in
# order, stopping at the first failure: tools/go/release.sh X.Y.Z [--dry-run].
# Run it from an up-to-date main. It leaves the changelog for review; merging
# and tagging stay manual.
set -eu
version=${1:?usage: release.sh X.Y.Z [--dry-run]}
root=$(git rev-parse --show-toplevel)
cd "$root"

if [ -n "$(git status --porcelain)" ]; then
  echo "release: the working tree is not clean" >&2
  exit 1
fi
if git rev-parse -q --verify "refs/tags/impl/go/v$version" > /dev/null; then
  echo "release: impl/go/v$version already exists" >&2
  exit 1
fi

reactor=$(git describe --tags --abbrev=0 --match 'reactor-v*')
if ! git diff --quiet "$reactor" HEAD -- impl/zig/src; then
  echo "release: impl/zig/src changed since $reactor; tag a reactor release and run impl/go/build-artifact.py first" >&2
  exit 1
fi

echo "== adapter-check"
CGO_ENABLED=0 impl/go/adapter-check.sh
echo "== cross-check"
impl/go/cross-check.sh

previous=$(git describe --tags --abbrev=0 --match 'impl/go/v*')
base=${previous#impl/go/}
echo "== gorelease against $base"
if [ "$base" = v0.1.0 ]; then
  # v0.1.0 requires a sqlite pseudo-version whose own go.mod requires
  # northtalk.org/go v0.0.0, which gorelease can't load; compare by hand.
  echo "release: gorelease can't load v0.1.0; check the API diff by hand" >&2
else
  (cd impl/go && go run golang.org/x/exp/cmd/gorelease@latest -base="$base" -version="v$version")
fi

echo "== release notes"
bun run release-notes:go "$version" ${2:-}

cat <<NEXT

Next:
  1. Merge the CHANGELOG.md section, then tag the merge commit:
     git tag -a impl/go/v$version -m "northtalk.org/go v$version" && git push origin impl/go/v$version
  2. In impl/go/sqlite/go.mod require northtalk.org/go v$version, merge, then tag
     impl/go/sqlite/v$version and push it.
The Go release workflow verifies each tag.
NEXT
