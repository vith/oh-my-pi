#!/usr/bin/env bash
set -euo pipefail
export BUN_INSTALL_CACHE_DIR=/cache/bun BUN_RUNTIME_TRANSPILER_CACHE_PATH=/cache/bun-transpiler XDG_CACHE_HOME=/cache/xdg CARGO_HOME=/cache/cargo CARGO_TARGET_DIR=/cache/target RUSTUP_HOME=/opt/rustup LIBCLANG_PATH=/usr/lib/llvm-19/lib
export PATH="/opt/cargo/bin:$PATH"
test "$(uname -m)" = aarch64
test "$(bun -e 'console.log(process.arch)')" = arm64
rustc -vV | grep -qx 'host: aarch64-unknown-linux-gnu'
case "$(cc -dumpmachine)" in
  aarch64*-linux-gnu) ;;
  *) echo 'cc must target aarch64 Linux' >&2; exit 1 ;;
esac
test -z "${CARGO_BUILD_TARGET:-}"
test -z "${CROSS_TARGET:-}"
workspace="$(bash /source/scripts/ci-prepare-workspace.sh /source /cache/workspace)"
cd "$workspace"
bun install --frozen-lockfile
# Suites and duplicate cache-probe builds remain deliberately disabled.
bun run check:ts
bun run check:rs
bun run collab:web:build
fork_version="$(bun scripts/prepare-fork-build.ts)"
OMP_NATIVE_BUILD_BACKEND=cargo OMP_NATIVE_CARGO_PROFILE=ci OMP_NATIVE_PIPEWIRE=1 bun run build:native
bun --cwd=packages/coding-agent run build
test "$(packages/coding-agent/dist/omp --version)" = "omp/$fork_version"
