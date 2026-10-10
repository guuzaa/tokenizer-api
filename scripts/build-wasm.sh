#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
bindgen_version="0.2.129"
export PATH="${HOME}/.cargo/bin:${PATH}"

if ! command -v cargo >/dev/null 2>&1 || ! command -v rustup >/dev/null 2>&1; then
  echo "Rust is required. Install rustup, then rerun." >&2
  exit 1
fi

if ! rustup target list --installed | grep -qx "wasm32-unknown-unknown"; then
  rustup target add wasm32-unknown-unknown
fi

if ! command -v wasm-bindgen >/dev/null 2>&1 || [[ "$(wasm-bindgen --version)" != *"${bindgen_version}"* ]]; then
  machine="$(uname -m)"
  case "${machine}" in
    x86_64) target_triple="x86_64-unknown-linux-musl" ;;
    aarch64|arm64) target_triple="aarch64-unknown-linux-musl" ;;
    *)
      echo "no wasm-bindgen binary for ${machine}; install wasm-bindgen ${bindgen_version} yourself" >&2
      exit 1
      ;;
  esac
  archive="wasm-bindgen-${bindgen_version}-${target_triple}.tar.gz"
  url="https://github.com/rustwasm/wasm-bindgen/releases/download/${bindgen_version}/${archive}"
  tmp="$(mktemp -d)"
  mkdir -p "${HOME}/.cargo/bin"
  curl -fsSL "${url}" -o "${tmp}/${archive}"
  tar -xzf "${tmp}/${archive}" -C "${tmp}"
  install -m 755 "${tmp}/wasm-bindgen-${bindgen_version}-${target_triple}/wasm-bindgen" "${HOME}/.cargo/bin/wasm-bindgen"
  rm -rf "${tmp}"
fi

# Cargo reads .cargo/config.toml from the current directory, not from
# --manifest-path. The wasm rustflags live next to this crate.
cd "${root}/tokenizer-wasm"
cargo build --release --target wasm32-unknown-unknown --lib
wasm-bindgen \
  --target web \
  --out-dir pkg \
  target/wasm32-unknown-unknown/release/tokenizer_wasm.wasm
