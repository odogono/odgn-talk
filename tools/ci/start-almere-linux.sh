#!/bin/bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:/usr/bin:/bin:/usr/sbin:/sbin"

if docker --context colima-woodpecker info >/dev/null 2>&1; then
  exit 0
fi

colima start woodpecker --cpus 6 --memory 10 --disk 60 --arch aarch64 \
  --vm-type vz --runtime docker --activate=false
