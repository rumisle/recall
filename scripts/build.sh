#!/usr/bin/env bash
# Standalone binaries (Bun's runtime included) into dist/: recall-<os>-<arch>.tar.gz plus the installer.
#   scripts/build.sh                         # all targets
#   scripts/build.sh linux-x64 darwin-arm64  # some
set -euo pipefail
cd "$(dirname "$0")/.."

targets=("$@")
[ ${#targets[@]} -gt 0 ] || targets=(linux-x64 linux-arm64 darwin-arm64 darwin-x64)

rm -rf dist && mkdir -p dist
for target in "${targets[@]}"; do
  dir=$(mktemp -d)
  bun build src/cli.ts --compile --minify --target="bun-$target" --outfile "$dir/recall" >/dev/null
  tar -czf "dist/recall-$target.tar.gz" -C "$dir" recall
  rm -rf "$dir"
  echo "dist/recall-$target.tar.gz $(du -h "dist/recall-$target.tar.gz" | cut -f1)"
done
cp scripts/install dist/install
