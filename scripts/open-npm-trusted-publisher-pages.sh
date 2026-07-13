#!/usr/bin/env bash
# Open every @vibecook/mille package's npm Settings page so you can add a
# Trusted Publisher in the browser (no CLI OTP needed if you're already
# logged in on npmjs.com).
#
# Usage:
#   ./scripts/open-npm-trusted-publisher-pages.sh
#   ./scripts/open-npm-trusted-publisher-pages.sh --print   # URLs only, no open

set -euo pipefail

PRINT_ONLY=false
[[ "${1:-}" == "--print" ]] && PRINT_ONLY=true

PACKAGES=(
  @vibecook/mille
  @vibecook/mille-ui
  @vibecook/mille-darwin-arm64
  @vibecook/mille-darwin-x64
  @vibecook/mille-linux-x64-gnu
  @vibecook/mille-linux-x64-musl
  @vibecook/mille-linux-arm64-gnu
  @vibecook/mille-linux-arm64-musl
  @vibecook/mille-win32-x64-msvc
  @vibecook/mille-win32-arm64-msvc
)

echo "Fill in Trusted Publisher on each page with:"
echo "  Provider:            GitHub Actions"
echo "  Organization/user:   jamesyong-42"
echo "  Repository:          mille"
echo "  Workflow filename:   release.yml"
echo "  Environment:         (leave blank)"
echo "  Allowed actions:     npm publish"
echo ""

for pkg in "${PACKAGES[@]}"; do
  # npmjs settings URL encodes scope as %2f
  enc=${pkg//@/%40}
  enc=${enc//\//%2f}
  url="https://www.npmjs.com/package/${enc}/access"
  # /access often redirects to package settings; dedicated settings:
  url="https://www.npmjs.com/package/${pkg}/settings"
  # npm uses unencoded @ in path for some routes; encode slash in scoped names
  scoped_path=$(printf '%s' "$pkg" | sed 's|/|%2F|g')
  url="https://www.npmjs.com/package/${scoped_path}/access"

  echo "$pkg"
  echo "  $url"
  if [[ "$PRINT_ONLY" == false ]]; then
    if command -v open >/dev/null 2>&1; then
      open "$url"
      sleep 0.4
    elif command -v xdg-open >/dev/null 2>&1; then
      xdg-open "$url"
      sleep 0.4
    fi
  fi
done

echo ""
echo "Tip: complete the first package fully, then copy the same fields to the rest."
echo "When done, verify with:  npm trust list @vibecook/mille"
