#!/usr/bin/env bash
# Re-point every @vibecook/* package's npm Trusted Publisher at the new repo.
#
# The 0.3.0 release was published from jamesyong-42/mille, so all ten trusted
# publisher configs are bound to that repository. After the transfer, Actions
# in vibecook-dev/mille mints OIDC tokens claiming `vibecook-dev/mille`, which
# no longer matches — the next `npm publish` would 403. This revokes the old
# binding and creates the new one for each package.
#
# Two phases on purpose. `audit` records every existing config ID to disk
# before anything is destroyed; `migrate` reads that record and acts on it.
# Once a config is revoked its ID is gone from the registry, so if the run
# dies partway (2FA window expiry, rate limit) the audit file is the only
# thing that can tell you what the state used to be. Always audit first.
#
# Prerequisites (see `npm help trust`):
#   - npm >= 11.15.0 (currently on 12.x)
#   - `npm login` as a user with write access to @vibecook/*
#   - Account-level 2FA enabled (trust commands require it; granular access
#     tokens with "bypass 2FA" are rejected)
#
# The first write call prompts for 2FA. The npm web prompt offers "skip 2FA
# for the next 5 minutes" — enabling it lets the rest run unattended.
#
# Usage:
#   ./scripts/migrate-trusted-publishers.sh audit     # read-only, writes record
#   ./scripts/migrate-trusted-publishers.sh migrate   # revoke + recreate

set -euo pipefail

OLD_REPO="jamesyong-42/mille"
NEW_REPO="vibecook-dev/mille"
WORKFLOW="release.yml"
AUDIT_FILE="${AUDIT_FILE:-./trusted-publishers-before.tsv}"
# Records packages already migrated, so an interrupted run resumes cleanly
# instead of trying to revoke an id the registry has already dropped.
DONE_FILE="${DONE_FILE:-./trusted-publishers-done.txt}"

PACKAGES=(
  "@vibecook/mille"
  "@vibecook/mille-ui"
  "@vibecook/mille-darwin-arm64"
  "@vibecook/mille-darwin-x64"
  "@vibecook/mille-linux-x64-gnu"
  "@vibecook/mille-linux-arm64-gnu"
  "@vibecook/mille-linux-x64-musl"
  "@vibecook/mille-linux-arm64-musl"
  "@vibecook/mille-win32-x64-msvc"
  "@vibecook/mille-win32-arm64-msvc"
)

# `npm trust list --json` prints one pretty-printed object per config via
# logOptions() — NOT a JSON array, and concatenated (invalid JSON) if there
# were ever several. Scraping the id/repository pairs out of the raw text is
# what actually survives that format. Empty output means no config exists:
# the "none found" message is dialogue(), which is suppressed under --json.
parse_configs () {
  node -e '
    let s = "";
    process.stdin.on("data", d => s += d);
    process.stdin.on("end", () => {
      const ids = [...s.matchAll(/"id"\s*:\s*"([^"]+)"/g)].map(m => m[1]);
      const repos = [...s.matchAll(/"repository"\s*:\s*"([^"]+)"/g)].map(m => m[1]);
      ids.forEach((id, i) => console.log(`${id}\t${repos[i] || "-"}`));
    });
  '
}

require_login () {
  if ! npm whoami >/dev/null 2>&1; then
    echo "Not logged in to npm (token in ~/.npmrc returns 401). Run: npm login" >&2
    exit 1
  fi
}

# Read a package's configs, distinguishing "no config" from "could not read".
# Conflating those is what produced the create-before-revoke 409, so every
# caller must be able to tell them apart. Prints configs on stdout; returns 1
# if the read itself failed.
trust_list_checked () {
  local pkg="$1" out rc=0
  out=$(npm trust list "$pkg" --json 2>/dev/null) || rc=$?
  if [[ $rc -ne 0 ]] || printf '%s' "$out" | grep -q '"error"'; then
    return 1
  fi
  printf '%s' "$out" | parse_configs
}

is_eotp () {
  printf '%s' "$1" | grep -q 'EOTP\|one-time password'
}

resume_hint () {
  echo >&2
  echo "  The 2FA skip window expired. Nothing is broken — re-authenticate and" >&2
  echo "  re-run; packages already migrated are skipped automatically:" >&2
  echo >&2
  echo "      npm trust list @vibecook/mille   # tick 'skip 2FA for 5 minutes'" >&2
  echo "      $0 migrate" >&2
}

cmd_audit () {
  require_login
  echo "Logged in as: $(npm whoami)"
  echo "Recording current trusted publishers to ${AUDIT_FILE}"
  echo

  local tmp_out; tmp_out=$(mktemp)
  local tmp_err; tmp_err=$(mktemp)
  trap 'rm -f "$tmp_out" "$tmp_err"' RETURN

  : > "$AUDIT_FILE"
  local found=0
  for pkg in "${PACKAGES[@]}"; do
    local raw parsed rc=0
    npm trust list "$pkg" --json >"$tmp_out" 2>"$tmp_err" || rc=$?
    raw=$(cat "$tmp_out")

    # A failed list must never be recorded as "no config exists" — that would
    # make migrate skip the revoke and hit a 409 on create. npm reports auth
    # failures as an error object on stdout AND a non-zero exit, so check both.
    if [[ $rc -ne 0 ]] || printf '%s' "$raw" | grep -q '"error"'; then
      echo >&2
      echo "ERROR: could not read trusted publisher for ${pkg}" >&2
      grep -v 'Unknown project config' < "$tmp_err" | head -12 >&2
      printf '%s' "$raw" | head -12 >&2
      if printf '%s' "$raw" | grep -q 'EOTP'; then
        echo >&2
        echo "This needs a one-time password. Run one command interactively first:" >&2
        echo "    npm trust list ${pkg}" >&2
        echo "then tick 'skip 2FA for the next 5 minutes' on the npm page and re-run." >&2
      fi
      echo "Aborting without writing a partial record; ${AUDIT_FILE} left unchanged." >&2
      exit 1
    fi

    parsed=$(printf '%s' "$raw" | parse_configs)

    if [[ -z "$parsed" ]]; then
      printf '%s\t-\t-\n' "$pkg" >> "$AUDIT_FILE"
      echo "  ${pkg}: no trusted publisher configured"
      continue
    fi

    while IFS=$'\t' read -r id repo; do
      [[ -z "$id" ]] && continue
      printf '%s\t%s\t%s\n' "$pkg" "$id" "$repo" >> "$AUDIT_FILE"
      echo "  ${pkg}: id=${id} repo=${repo}"
      found=$((found + 1))
    done <<< "$parsed"
  done

  echo
  echo "Recorded ${found} config(s) to ${AUDIT_FILE}"
  echo "Review it, then run: $0 migrate"
}

cmd_migrate () {
  require_login

  if [[ ! -s "$AUDIT_FILE" ]]; then
    echo "No audit record at ${AUDIT_FILE}. Run '$0 audit' first." >&2
    exit 1
  fi

  # A short audit file would silently skip packages and still look like a
  # clean run. Every package must be accounted for before anything is touched.
  local missing=()
  for pkg in "${PACKAGES[@]}"; do
    grep -qF "$(printf '%s\t' "$pkg")" "$AUDIT_FILE" || missing+=("$pkg")
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "ERROR: ${AUDIT_FILE} is missing ${#missing[@]} of ${#PACKAGES[@]} packages:" >&2
    printf '  %s\n' "${missing[@]}" >&2
    echo "Re-run '$0 audit' until it completes without read failures." >&2
    exit 1
  fi

  echo "Logged in as: $(npm whoami)"
  echo "Target: ${NEW_REPO} / .github/workflows/${WORKFLOW}"
  echo "Audit covers all ${#PACKAGES[@]} packages"
  echo

  while IFS=$'\t' read -r pkg id repo; do
    [[ -z "$pkg" ]] && continue
    echo "── ${pkg}"

    if [[ "$repo" == "$NEW_REPO" ]]; then
      echo "   already bound to ${NEW_REPO} — skipping"
      echo
      continue
    fi

    if grep -qxF "$pkg" "$DONE_FILE" 2>/dev/null; then
      echo "   already migrated in an earlier run — skipping"
      echo
      continue
    fi

    if [[ "$id" == "-" ]]; then
      # Never assume "no id recorded" means "no config exists" — that is how
      # the create-before-revoke 409 happens. Make the operator confirm.
      echo "   ERROR: no config id recorded for ${pkg}." >&2
      echo "   Re-run '$0 audit' to capture it. If audit genuinely reports no" >&2
      echo "   config, set the id to 'none' in ${AUDIT_FILE} to create fresh." >&2
      exit 1
    fi

    if [[ "$id" != "none" ]]; then
      if [[ "$repo" != "$OLD_REPO" && "$repo" != "-" ]]; then
        echo "   WARNING: recorded repo is '${repo}', expected '${OLD_REPO}'" >&2
      fi
      # Revoke before create: the registry permits one config per package,
      # so creating first returns 409 Conflict.
      echo "   revoking ${id} (${repo})"
      local rrc=0 rerr
      rerr=$(mktemp)
      npm trust revoke "$pkg" --id="$id" 2> >(tee "$rerr" >&2) || rrc=$?
      if [[ $rrc -ne 0 ]]; then
        local errtext; errtext=$(cat "$rerr"); rm -f "$rerr"
        # A re-run after a partial migration will find the id already gone;
        # that is benign. Anything else is not, so read the live state to
        # tell the two apart — and treat an unreadable state as fatal rather
        # than assuming the config is gone.
        local still
        if ! still=$(trust_list_checked "$pkg"); then
          echo "   revoke failed and live state is unreadable — stopping here." >&2
          is_eotp "$errtext" && resume_hint
          exit 1
        fi
        if [[ -n "$still" ]]; then
          echo "   revoke failed; config is still present: ${still}" >&2
          if is_eotp "$errtext"; then
            resume_hint
          else
            echo "   Aborting — resolve manually before continuing." >&2
          fi
          exit 1
        fi
        echo "   already revoked; continuing"
      else
        rm -f "$rerr"
      fi
      sleep 1
    fi

    echo "   creating github --repo ${NEW_REPO} --file ${WORKFLOW}"
    local crc=0 cerr; cerr=$(mktemp)
    npm trust github "$pkg" \
      --repo "$NEW_REPO" \
      --file "$WORKFLOW" \
      --allow-publish \
      --yes 2> >(tee "$cerr" >&2) || crc=$?
    if [[ $crc -ne 0 ]]; then
      local errtext; errtext=$(cat "$cerr"); rm -f "$cerr"
      # The revoke already succeeded, so this package now has NO config.
      # Say so plainly — a re-run recreates it, but until then it cannot
      # publish at all.
      echo >&2
      echo "   ERROR: create failed after the revoke succeeded." >&2
      echo "   ${pkg} currently has NO trusted publisher and cannot publish." >&2
      echo "   Re-running restores it." >&2
      is_eotp "$errtext" && resume_hint
      exit 1
    fi
    rm -f "$cerr"
    echo "$pkg" >> "$DONE_FILE"
    sleep 1
    echo
  done < "$AUDIT_FILE"

  echo "Done. Verify with:"
  echo "  for p in ${PACKAGES[*]}; do npm trust list \"\$p\" --json; done"
}

case "${1:-}" in
  audit)   cmd_audit ;;
  migrate) cmd_migrate ;;
  *)       echo "Usage: $0 {audit|migrate}" >&2; exit 1 ;;
esac
