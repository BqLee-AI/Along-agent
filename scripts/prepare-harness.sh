#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# This repository-owned lock is data expressed as shell assignments, never cjpm hooks.
source "$root/apps/harness/artifacts.lock"
dest="${1:-/opt/along-toolchain}"
mkdir -p "$dest/downloads"
fetch() {
  local url="$1" hash="$2" file="$3"
  if [[ ! -f "$file" ]]; then
    curl --fail --location --retry 3 "$url" -o "$file.partial"
    printf '%s  %s\n' "$hash" "$file.partial" | sha256sum --check --status
    mv "$file.partial" "$file"
  fi
  printf '%s  %s\n' "$hash" "$file" | sha256sum --check --status
}
fetch "$SDK_URL" "$SDK_SHA256" "$dest/downloads/sdk.tar.gz"
fetch "$STDX_URL" "$STDX_SHA256" "$dest/downloads/stdx.zip"
# Always extract verified archives; never trust a pre-existing global compiler.
rm -rf "$dest/cangjie" "$dest/stdx"
tar -xzf "$dest/downloads/sdk.tar.gz" -C "$dest"
mkdir -p "$dest/stdx"
unzip -q "$dest/downloads/stdx.zip" -d "$dest/stdx"
