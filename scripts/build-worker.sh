#!/usr/bin/env bash
# Release build for the Rust worker.
# worker-build 0.8.7 invokes wasm-bindgen 0.2.129 without --reference-types.
# Rust 1.94's wasm target emits externref, so that CLI rejects the module.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root/crates/worker"

cargo install worker-build --version 0.8.7

version="0.2.129"
target="x86_64-unknown-linux-musl"
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) target="aarch64-apple-darwin" ;;
  Darwin-x86_64) target="x86_64-apple-darwin" ;;
  Linux-aarch64|Linux-arm64) target="aarch64-unknown-linux-musl" ;;
  Linux-x86_64) target="x86_64-unknown-linux-musl" ;;
  MINGW*|MSYS*|CYGWIN*) target="x86_64-pc-windows-msvc" ;;
esac

cache="${HOME}/.cache/worker-build/wasm-bindgen-${target}-${version}"
real="${cache}/wasm-bindgen"
if [[ ! -x "$real" ]]; then
  mkdir -p "$cache"
  url="https://github.com/wasm-bindgen/wasm-bindgen/releases/download/${version}/wasm-bindgen-${version}-${target}.tar.gz"
  tmp="$(mktemp -d)"
  curl -fsSL "$url" | tar -xz -C "$tmp"
  install -m 755 "$tmp/wasm-bindgen-${version}-${target}/wasm-bindgen" "$real"
  rm -rf "$tmp"
fi

wrapper="${cache}/wasm-bindgen-reference-types"
cat >"$wrapper" <<EOF
#!/bin/sh
exec "$real" "\$@" --reference-types
EOF
chmod +x "$wrapper"

export WASM_BINDGEN_BIN="$wrapper"
worker-build --release
