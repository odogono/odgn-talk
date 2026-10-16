#!/bin/sh
# Fails when the Zig Core writes a save format other than the one the Elixir
# package pins, so a format change also tags and pins a new reactor release.
set -eu
root=$(cd "$(dirname "$0")/../../.." && pwd)
pinned=$(sed -n 's/^  @save_format "\(.*\)"$/\1/p' "$root/impl/elixir/lib/north_talk/artifact.ex")
core="zig/$(sed -n 's/^pub const format_version: u32 = \([0-9]*\);$/\1/p' "$root/impl/zig/src/machine/snapshot.zig")"
if [ -z "$pinned" ] || [ "$core" = "zig/" ]; then
  echo "could not read the save formats: pinned '$pinned', Core '$core'" >&2
  exit 1
fi
if [ "$pinned" != "$core" ]; then
  echo "The Zig Core writes $core, but impl/elixir pins a reactor that reads $pinned." >&2
  echo "In this PR: set @save_format to $core in impl/elixir/lib/north_talk/artifact.ex, push a reactor-v* tag" >&2
  echo "on that commit, then pin the release's tag and SHA-256 there too." >&2
  exit 1
fi
echo "save format $core matches the Elixir pin"
