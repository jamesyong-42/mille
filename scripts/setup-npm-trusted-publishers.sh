#!/usr/bin/env bash
# Configure npm Trusted Publishing (OIDC) for every @vibecook/mille package.
#
# Maps GitHub Actions workflow release.yml → each package so future
# `git push origin v*` runs publish with no long-lived NPM_TOKEN.
#
# Prerequisites:
#   - npm ≥ 11.10.0  (npm install -g npm@latest)
#   - Write access to each package under @vibecook
#   - Account 2FA enabled (first call may open a browser / ask for OTP)
#   - Packages already published (bootstrap-npm-publish.sh)
#
# Usage:
#   ./scripts/setup-npm-trusted-publishers.sh
#   ./scripts/setup-npm-trusted-publishers.sh --dry-run
#   NPM_OTP=123456 ./scripts/setup-npm-trusted-publishers.sh
#
# After the first 2FA prompt, npm may offer “skip 2FA for 5 minutes”
# on the website — enable it so the remaining packages go through.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

REPO="${NPM_TRUST_REPO:-vibecook-dev/mille}"
WORKFLOW="${NPM_TRUST_WORKFLOW:-release.yml}"
DRY_RUN=false

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    -h|--help)
      sed -n '2,25p' "$0"
      exit 0
      ;;
  esac
done

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

# npm trust requires ≥ 11.10
major=$(npm --version | cut -d. -f1)
minor=$(npm --version | cut -d. -f2)
if [[ "$major" -lt 11 ]] || { [[ "$major" -eq 11 ]] && [[ "$minor" -lt 10 ]]; }; then
  echo "npm $(npm --version) is too old for 'npm trust' (need ≥ 11.10)."
  echo "Upgrade: npm install -g npm@latest"
  exit 1
fi

echo "npm user:  $(npm whoami 2>/dev/null || echo 'NOT LOGGED IN')"
echo "repo:      $REPO"
echo "workflow:  $WORKFLOW"
echo "packages:  ${#PACKAGES[@]}"
echo ""

OTP_ARGS=()
if [[ -n "${NPM_OTP:-}" ]]; then
  OTP_ARGS=(--otp "$NPM_OTP")
fi

failed=()
ok=()

for pkg in "${PACKAGES[@]}"; do
  echo ">>> $pkg"

  # Skip if already trusted for this repo/workflow
  if list_json=$(npm trust list "$pkg" --json 2>/dev/null); then
    if echo "$list_json" | grep -q "$WORKFLOW" && echo "$list_json" | grep -q "$REPO"; then
      echo "    already configured — skip"
      ok+=("$pkg (existing)")
      continue
    fi
  fi

  if [[ "$DRY_RUN" == true ]]; then
    echo "    [dry-run] npm trust github $pkg --file $WORKFLOW --repo $REPO --allow-publish --yes"
    ok+=("$pkg (dry-run)")
    continue
  fi

  # npm ≥ 12 requires --allow-publish (and/or --allow-stage-publish)
  trust_cmd=(npm trust github "$pkg" --file "$WORKFLOW" --repo "$REPO" --allow-publish --yes)
  if [[ ${#OTP_ARGS[@]} -gt 0 ]]; then
    trust_cmd+=("${OTP_ARGS[@]}")
  fi

  # Capture output so we can detect 2FA / auth failures early.
  if out=$("${trust_cmd[@]}" 2>&1); then
    echo "$out" | sed 's/^/    /'
    echo "    OK"
    ok+=("$pkg")
  else
    status=$?
    echo "$out" | sed 's/^/    /'
    echo "    FAILED (exit $status)"
    failed+=("$pkg")

    if echo "$out" | grep -qE 'EOTP|E403|Two-factor|one-time password|Forbidden'; then
      echo ""
      echo "Stopped early: npm requires interactive 2FA for 'npm trust'."
      echo ""
      echo "  Automation tokens (bypass-2FA) do NOT work for trust commands."
      echo "  Use your password login + authenticator OTP:"
      echo ""
      echo "    # Option A — one OTP for the batch (re-run after each expiry):"
      echo "    NPM_OTP=123456 $0"
      echo ""
      echo "    # Option B — first call opens browser; enable"
      echo "    # \"Skip 2FA for 5 minutes\" on npmjs.com, then re-run:"
      echo "    $0"
      echo ""
      echo "Already configured packages are skipped on re-run."
      exit 1
    fi
  fi

  # Avoid rate limits during bulk setup
  sleep 2
done

echo ""
echo "=== summary ==="
echo "ok (${#ok[@]}):"
printf '  %s\n' "${ok[@]:-}"
if [[ ${#failed[@]} -gt 0 ]]; then
  echo "failed (${#failed[@]}):"
  printf '  %s\n' "${failed[@]}"
  exit 1
fi

echo ""
echo "All packages trust GitHub Actions workflow: $WORKFLOW"
echo "Verify one:  npm trust list @vibecook/mille"
echo "Future releases: git tag vX.Y.Z && git push origin vX.Y.Z"
