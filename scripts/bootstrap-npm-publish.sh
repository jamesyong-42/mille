#!/usr/bin/env bash
# One-time bootstrap: publish all @vibecook/mille packages using local npm auth
# (or NPM_TOKEN). After this, configure Trusted Publishers on npmjs.com and
# use the OIDC Release workflow for subsequent versions.
#
# Usage:
#   # With automation token (no OTP):
#   NPM_TOKEN=npm_xxx ./scripts/bootstrap-npm-publish.sh
#
#   # With classic token + 2FA:
#   NPM_OTP=123456 ./scripts/bootstrap-npm-publish.sh
#
#   # Binaries from a CI run (default: /tmp/mille-rel-artifacts):
#   ARTIFACTS_DIR=/path/to/gh-run-download ./scripts/bootstrap-npm-publish.sh
#
# Prerequisite: gh run download <run-id> -D /tmp/mille-rel-artifacts

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ARTIFACTS_DIR="${ARTIFACTS_DIR:-/tmp/mille-rel-artifacts}"
OTP_ARGS=()
if [[ -n "${NPM_OTP:-}" ]]; then
  OTP_ARGS=(--otp "$NPM_OTP")
fi

if [[ -n "${NPM_TOKEN:-}" ]]; then
  export NODE_AUTH_TOKEN="$NPM_TOKEN"
  npm config set "//registry.npmjs.org/:_authToken" "$NPM_TOKEN"
  echo "Using NPM_TOKEN for auth"
elif [[ -n "${NPM_OTP:-}" ]]; then
  echo "Using NPM_OTP for 2FA"
else
  echo "Using existing npm login (may prompt for OTP)"
fi

echo "npm user: $(npm whoami 2>/dev/null || echo 'NOT LOGGED IN')"

# Place platform binaries
if [[ ! -d "$ARTIFACTS_DIR" ]]; then
  echo "ERROR: ARTIFACTS_DIR not found: $ARTIFACTS_DIR"
  echo "Download with: gh run download <run-id> -D $ARTIFACTS_DIR"
  exit 1
fi

placed=0
shopt -s nullglob
for f in "$ARTIFACTS_DIR"/bindings-*/packages/mille/mille.*.node; do
  base=$(basename "$f")
  triple=${base#mille.}
  triple=${triple%.node}
  dest="packages/mille-${triple}"
  cp -f "$f" "$dest/"
  placed=$((placed + 1))
  echo "  $dest/$base"
done
if [[ "$placed" -ne 8 ]]; then
  echo "ERROR: expected 8 binaries, got $placed"
  exit 1
fi

# Stamp optionalDependencies for the registry (not for commit)
python3 - <<'PY'
import json, pathlib
root = pathlib.Path("packages/mille/package.json")
data = json.loads(root.read_text())
ver = data["version"]
opts = data.get("optionalDependencies", {})
for k in list(opts):
    if str(opts[k]).startswith("workspace:"):
        opts[k] = ver
data["optionalDependencies"] = opts
pc = data.setdefault("publishConfig", {})
pc["access"] = "public"
root.write_text(json.dumps(data, indent=2) + "\n")
print("stamped optionalDependencies ->", ver)
PY

# Ensure dist exists
pnpm --filter @vibecook/mille run build:ts
pnpm --filter @vibecook/mille-ui run build

publish_one() {
  local filter="$1"
  shift
  echo ""
  echo ">>> publishing $filter"
  # Under set -u, empty arrays need ${arr[@]+"${arr[@]}"} — or use "$@" after shift.
  local -a cmd=(pnpm --filter "$filter" publish --access public --no-git-checks)
  if [[ ${#OTP_ARGS[@]} -gt 0 ]]; then
    cmd+=("${OTP_ARGS[@]}")
  fi
  if [[ $# -gt 0 ]]; then
    cmd+=("$@")
  fi
  "${cmd[@]}"
}

# Platform packages first, then umbrella, then UI
for pkg in \
  @vibecook/mille-darwin-arm64 \
  @vibecook/mille-darwin-x64 \
  @vibecook/mille-linux-x64-gnu \
  @vibecook/mille-linux-x64-musl \
  @vibecook/mille-linux-arm64-gnu \
  @vibecook/mille-linux-arm64-musl \
  @vibecook/mille-win32-x64-msvc \
  @vibecook/mille-win32-arm64-msvc
do
  publish_one "$pkg"
done

# Umbrella: skip prepublishOnly (napi prepublish) — already stamped
publish_one @vibecook/mille --ignore-scripts

# UI: allow prepublishOnly (material + build)
publish_one @vibecook/mille-ui

echo ""
echo "=== registry check ==="
for name in @vibecook/mille @vibecook/mille-ui @vibecook/mille-darwin-arm64; do
  echo -n "$name: "
  npm view "$name" version 2>/dev/null || echo "(missing)"
done

# Restore workspace protocol for local monorepo
python3 - <<'PY'
import json, pathlib
root = pathlib.Path("packages/mille/package.json")
data = json.loads(root.read_text())
opts = data.get("optionalDependencies", {})
for k in list(opts):
    opts[k] = "workspace:*"
data["optionalDependencies"] = opts
root.write_text(json.dumps(data, indent=2) + "\n")
print("restored optionalDependencies to workspace:*")
PY

echo ""
echo "Bootstrap publish complete."
echo "Next: configure Trusted Publisher on npmjs.com for each package"
echo "  (GitHub user jamesyong-42 / repo mille / workflow release.yml)"
echo "Then future tags v* publish via OIDC with no token."
