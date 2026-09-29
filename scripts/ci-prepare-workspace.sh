#!/usr/bin/env bash
# Keep unchanged source mtimes stable across fresh CI checkouts so Cargo can
# reuse build scripts and local-crate artifacts, not only registry dependencies.
# Jobs sharing this workspace must be serialized by the runner.
set -euo pipefail

source_dir="$(realpath "${1:?source checkout is required}")"
workspace="$(realpath -m "${2:?cached workspace is required}")"
if [[ "$workspace" == / || "$workspace" == "$source_dir" || "$workspace" == "$source_dir/"* || "$source_dir" == "$workspace/"* ]]; then
  printf 'Source and cached workspace must be separate, non-overlapping directories\n' >&2
  exit 1
fi

mkdir -p "$workspace"
# Deliberately omit --times: --checksum decides whether source content changed,
# and an unchanged destination keeps its original mtime. Changed/deleted sources
# and changed permissions/symlinks still propagate. Preserve only build outputs.
rsync --recursive --links --perms --checksum --delete \
  --exclude='/node_modules/' \
  --exclude='/packages/*/node_modules/' \
  --exclude='/packages/*/dist/' \
  --exclude='/packages/natives/native/*.node' \
  "$source_dir/" "$workspace/"
printf '%s\n' "$workspace"
