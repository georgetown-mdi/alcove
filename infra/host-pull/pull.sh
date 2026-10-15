#!/bin/bash
# Bring this host to the tip of main: a tree of that commit with core's signed
# build unpacked into it, then the broker's and the relay's install scripts.
# alcove-host-pull.timer runs the copy install.sh put under /opt/alcove-host-pull,
# never a copy inside a tree this script switches.
#
#   pull.sh
#
# Each run ends with one outcome in the status file (README.md, Outcomes):
# unchanged or updated, skipped when there is nothing to take yet (exit 0),
# refused when the commit or its build fails a check, failed when a step could
# not run, rolled-back when the tip's installs failed and the deployed commit's
# passed again, and rollback-failed when those failed too (all exit 1). It
# holds no credential and builds nothing. Only an updated run rewrites the
# deployed marker, so a commit whose installs did not complete is checked,
# downloaded, staged and installed again by the next run; a tree already on
# disk is never reused. It removes only trees it created and lists in
# $CREATED, never the one $SRC or the marker names.
set -Eeuo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# Literal paths, as in the broker's install.sh. ALCOVE_HOST_PULL_INSTALL_ROOT
# prefixes them for scripts/host-pull.test.mjs.
ROOT="${ALCOVE_HOST_PULL_INSTALL_ROOT:-}"
STATE="$ROOT/var/lib/alcove-host-pull"
STATUS="$STATE/status"
MARKER="$STATE/deployed"
CREATED="$STATE/created-trees"
WORK="$STATE/work"
BROKER_DIR="$ROOT/opt/alcove-broker"
SRC="$BROKER_DIR/src"
TREES="$BROKER_DIR/trees"

REPOSITORY_URL=https://github.com/georgetown-mdi/alcove.git
API_URL=https://api.github.com/repos/georgetown-mdi/alcove
RELEASE_URL=https://github.com/georgetown-mdi/alcove/releases/download/broker-core-build
# Pages of 100 push runs read for one commit before the run gives up.
RUN_PAGES=10

# INSTALL_SHARE and INSTALL_KILL_AFTER_DEFAULT are working values, sized so the
# counted staging bounds (ls-remote 120 s, one run-page download 300 s, the two
# build downloads 2 * 300 s, the fetch 600 s and npm ci 600 s) plus a forward
# attempt and a rollback, two install scripts each, stay near the run's 1-hour
# maximum (alcove-host-pull.service). They do not guarantee every run fits.
# The share holds the --kill-after wait, so the script gets INSTALL_SHARE -
# INSTALL_KILL_AFTER seconds before TERM. The override may only lower either
# wait.
INSTALL_SHARE=345
INSTALL_KILL_AFTER_DEFAULT=30
INSTALL_TIMEOUT_DEFAULT=$((INSTALL_SHARE - INSTALL_KILL_AFTER_DEFAULT))

# Prints the override when it is a positive integer no larger than the default,
# and the default otherwise.
lowered() {
  if [[ "$1" =~ ^[1-9][0-9]{0,8}$ ]] && [ "$1" -le "$2" ]; then printf '%s' "$1"; else printf '%s' "$2"; fi
}
INSTALL_TIMEOUT="$(lowered "${ALCOVE_HOST_PULL_INSTALL_TIMEOUT:-}" "$INSTALL_TIMEOUT_DEFAULT")"
INSTALL_KILL_AFTER="$(lowered "${ALCOVE_HOST_PULL_KILL_AFTER:-}" "$INSTALL_KILL_AFTER_DEFAULT")"

TIP=""
PARTIAL=""
FAILURE=""

[ "$#" -eq 0 ] || { printf 'usage: pull.sh\n' >&2; exit 2; }

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }

[ "$(id -u)" = 0 ] || { log "pull.sh writes under /opt and /var/lib; run it as root"; exit 1; }

linked() {
  local target
  target="$(readlink "$SRC" 2>/dev/null || true)"
  if [[ "$target" =~ ^trees/[0-9a-f]{40}$ ]]; then
    printf '%s' "${target#trees/}"
  fi
}

deployed() {
  local commit
  commit="$(cat "$MARKER" 2>/dev/null || true)"
  if [[ "$commit" =~ ^[0-9a-f]{40}$ ]]; then
    printf '%s' "$commit"
  fi
}

# The commits whose trees this script created and has not removed.
created_trees() {
  grep -Ex '[0-9a-f]{40}' "$CREATED" 2>/dev/null || true
}

# path; the content on stdin. Written to a new file renamed over the old, so a
# reader never sees half a record.
replace() {
  cat > "$1.new"
  chmod 644 "$1.new"
  mv -f "$1.new" "$1"
}

# outcome, exit status, reason.
finish() {
  trap - ERR
  log "$1: $3"
  printf 'deployed_commit=%s\nlinked_commit=%s\nmain_commit=%s\noutcome=%s\nreason=%s\ntime=%s\n' \
    "$(deployed)" "$(linked)" "$TIP" "$1" "$3" "$(date -u +%FT%TZ)" | replace "$STATUS"
  exit "$2"
}

command -v flock >/dev/null 2>&1 || { log "flock is not installed; it comes with util-linux"; exit 1; }
install -d -m 755 "$STATE"
exec 9>> "$STATE/lock"
flock -n 9 || { log "another pull.sh run holds $STATE/lock"; exit 1; }

cleanup() {
  rm -rf "$WORK"
  if [ -n "$PARTIAL" ]; then rm -rf "$PARTIAL"; fi
}
trap cleanup EXIT
trap 'finish failed 1 "pull.sh stopped at line $LINENO"' ERR
trap 'finish failed 1 "pull.sh was stopped by a signal"' TERM INT

for tool in git curl cosign node npm sha256sum tar nice ionice setsid; do
  command -v "$tool" >/dev/null 2>&1 || finish failed 1 "$tool is not installed; see README.md, Install"
done
if [ -L "$SRC" ]; then
  [ -n "$(linked)" ] \
    || finish failed 1 "$SRC links to $(readlink "$SRC"), not to a tree under $TREES; see README.md, Install"
elif [ -e "$SRC" ]; then
  finish failed 1 "$SRC is not a link to a tree under $TREES; see README.md, Install"
fi

remote="$(timeout 120 git ls-remote --exit-code "$REPOSITORY_URL" refs/heads/main)" \
  || finish failed 1 "could not read main from $REPOSITORY_URL"
TIP="${remote%%[[:space:]]*}"
if ! [[ "$TIP" =~ ^[0-9a-f]{40}$ ]]; then
  TIP=""
  finish failed 1 "$REPOSITORY_URL answered no commit for main"
fi
if [ "$(deployed)" = "$TIP" ] && [ "$(linked)" = "$TIP" ]; then
  finish unchanged 0 "main is at $TIP, which is deployed"
fi

rm -rf "$WORK"
install -d -m 700 "$WORK"
export npm_config_cache="$WORK/npm-cache"

# url, output file. Sets CODE to the HTTP status; fails only when no complete
# answer arrived.
download() {
  local status=0
  CODE="$(curl -sS -L --proto =https --proto-redir =https --max-time 300 \
    --max-filesize 16777216 -H 'Accept: application/vnd.github+json' \
    -o "$2" -w '%{http_code}' "$1")" || status=$?
  return "$status"
}

# Every push-triggered workflow run on the tip completed as success; runs of
# other events do not gate (README.md, What a run does).
require_green() {
  local page=1 file verdict
  local pages=()
  while :; do
    file="$WORK/workflow-runs-$page.json"
    download "$API_URL/actions/runs?head_sha=$TIP&event=push&per_page=100&page=$page" "$file" \
      || finish failed 1 "could not read the workflow runs of $TIP"
    [ "$CODE" = 200 ] || finish failed 1 "GitHub answered HTTP $CODE for the workflow runs of $TIP"
    pages+=("$file")
    verdict="$(node "$HERE/workflow-runs.mjs" "$TIP" "${pages[@]}")" \
      || finish failed 1 "could not read the workflow runs of $TIP"
    [ "$verdict" = more ] || break
    [ "$page" -lt "$RUN_PAGES" ] \
      || finish failed 1 "$TIP has more push runs than $RUN_PAGES pages of 100 hold"
    page=$((page + 1))
  done
  case "$verdict" in
    "green "*) log "every push run on $TIP succeeded (${verdict#green })" ;;
    "pending "*) finish skipped 0 "CI has not finished on $TIP: ${verdict#pending }" ;;
    none) finish skipped 0 "no push run has reported on $TIP yet" ;;
    "red "*) finish refused 1 "CI did not pass on $TIP: ${verdict#red }" ;;
    *) finish failed 1 "the workflow runs of $TIP were not read: ${verdict#unread }" ;;
  esac
}

# Downloads and verifies the tip's build and stages its tree.
stage() {
  local archive="alcove-broker-core-$TIP.tar.gz"
  local bundle="$archive.sigstore.json"
  local name fetched dist tree replaced
  for name in "$archive" "$bundle"; do
    download "$RELEASE_URL/$name" "$WORK/$name" || finish failed 1 "could not download $name"
    case "$CODE" in
      200) ;;
      404) finish skipped 0 "the broker-core-build prerelease has no $name yet" ;;
      *) finish failed 1 "GitHub answered HTTP $CODE for $name" ;;
    esac
  done

  # infra/broker/README.md, Install step 5: the identity is the publishing
  # workflow on main, and the workflow SHA refuses a correctly signed build of
  # any other commit.
  cosign verify-blob \
    --bundle "$WORK/$bundle" \
    --certificate-identity https://github.com/georgetown-mdi/alcove/.github/workflows/broker_core_build.yaml@refs/heads/main \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com \
    --certificate-github-workflow-sha "$TIP" \
    "$WORK/$archive" >&2 \
    || finish refused 1 "the signature on $archive does not verify as main's build of $TIP"

  install -d -m 755 "$TREES"
  PARTIAL="$TREES/.$TIP.partial"
  rm -rf "$PARTIAL"
  git init -q "$PARTIAL"
  timeout 600 git -C "$PARTIAL" fetch -q --depth 1 "$REPOSITORY_URL" refs/heads/main \
    || finish failed 1 "could not fetch main from $REPOSITORY_URL"
  fetched="$(git -C "$PARTIAL" rev-parse FETCH_HEAD)"
  [ "$fetched" = "$TIP" ] || finish skipped 0 "main moved from $TIP to $fetched during the run"
  git -C "$PARTIAL" checkout -q --detach FETCH_HEAD

  dist="$PARTIAL/packages/core/dist"
  install -d "$dist"
  tar -xzf "$WORK/$archive" --no-same-owner -C "$dist" || finish refused 1 "$archive does not unpack"
  (cd "$dist" && sha256sum --quiet -c SHA256SUMS) >&2 \
    || finish refused 1 "the files in $archive do not match its SHA256SUMS"
  [ -s "$dist/untrusted-text.esm.js" ] || finish refused 1 "$archive has no untrusted-text.esm.js"

  # No package's install script runs as root (README.md, What a run does).
  (cd "$PARTIAL" && nice -n 10 ionice -c 3 timeout 600 npm ci --no-audit --no-fund --ignore-scripts \
    --workspace packages/peerjs-broker) >&2 \
    || finish failed 1 "npm ci of the broker workspace failed at $TIP"

  # Owned by root and readable by all, so the broker's account cannot rewrite the
  # code it runs (infra/broker/README.md, Install step 6).
  chown -R 0:0 "$PARTIAL"
  chmod -R u=rwX,go=rX "$PARTIAL"
  # A tree already at this path may be the one $SRC links to; it is moved aside
  # rather than deleted in place, so the link dangles only between two renames.
  tree="$TREES/$TIP"
  replaced="$TREES/.$TIP.replaced"
  rm -rf "$replaced"
  if [ -e "$tree" ]; then mv -T "$tree" "$replaced"; fi
  mv -T "$PARTIAL" "$tree"
  PARTIAL=""
  # Listed only once the tree is in place, so a run stopped before then leaves
  # an unlisted tree, which is never removed, rather than a listed tree it did
  # not create.
  { grep -vxF -- "$TIP" "$CREATED" 2>/dev/null || true; printf '%s\n' "$TIP"; } \
    | replace "$CREATED"
  rm -rf "$replaced"
}

# script. Runs it under timeout in a session of its own, and once it fails
# sends KILL to the install's process group: the script and every descendant
# that stays in that group. A descendant that starts its own process group,
# such as a probe run through timeout, is not killed and ends at its own bound.
# The kill-after KILL of uutils timeout, the timeout on Ubuntu 26.04, reaches
# the script alone, so a child ignoring TERM would otherwise outlive the bound.
bounded() {
  local session status=0
  setsid timeout -k "$INSTALL_KILL_AFTER" "$INSTALL_TIMEOUT" "$1" >&2 &
  session=$!
  wait "$session" || status=$?
  if [ "$status" != 0 ]; then kill -KILL -- "-$session" 2>/dev/null || true; fi
  return "$status"
}

# commit. Links $SRC to the commit's tree, restarts the broker and runs the
# tree's two install scripts. Sets FAILURE and returns 1 at the first step that
# fails. Each step tests its own status: the callers run this as a condition,
# where neither set -e nor the ERR trap applies.
install_tree() {
  local tree="$TREES/$1"
  { rm -f "$BROKER_DIR/.src.new" && ln -s "trees/$1" "$BROKER_DIR/.src.new" \
      && mv -fT "$BROKER_DIR/.src.new" "$SRC"; } \
    || { FAILURE="$SRC could not be linked to $tree"; return 1; }
  log "$SRC links to $1"
  # The broker's install.sh restarts the broker only for a changed unit file,
  # and a switched tree is not one.
  systemctl try-restart alcove-broker.service \
    || { FAILURE="alcove-broker.service did not restart on $1"; return 1; }
  bounded "$tree/infra/broker/install.sh" \
    || { FAILURE="infra/broker/install.sh failed at $1"; return 1; }
  # Ends with verify.sh against the relay's private address.
  bounded "$tree/infra/relay/install.sh" \
    || { FAILURE="infra/relay/install.sh or its verify.sh failed at $1"; return 1; }
}

# commit. Removes the commit's tree, by its path under $TREES, only when
# $CREATED lists it and neither $SRC nor the deployed marker names it.
remove_tree() {
  grep -qxF -- "$1" "$CREATED" 2>/dev/null || return 0
  if [ "$1" = "$(linked)" ] || [ "$1" = "$(deployed)" ]; then return 0; fi
  if ! rm -rf -- "$TREES/$1"; then
    log "could not remove $TREES/$1; a later run tries again"
    return 0
  fi
  { grep -vxF -- "$1" "$CREATED" || true; } | replace "$CREATED"
  log "removed $TREES/$1"
}

# The installs at the tip failed: link $SRC back to the tree of the commit the
# deployed marker names, which holds that commit's core build, and run both
# installs from it. A tree the marker does not name is never a rollback target.
roll_back() {
  local failure="$FAILURE" previous
  previous="$(deployed)"
  log "$failure"
  if [ -z "$previous" ] || [ "$previous" = "$TIP" ]; then
    finish failed 1 "$failure; the deployed marker names no commit other than $TIP, so nothing was rolled back"
  fi
  if [ -L "$TREES/$previous" ] || [ ! -d "$TREES/$previous" ]; then
    finish failed 1 "$failure; $TREES/$previous, the deployed commit's tree, is missing, so nothing was rolled back"
  fi
  log "rolling back to $previous"
  install_tree "$previous" \
    || finish rollback-failed 1 "$failure; rolling back to $previous failed: $FAILURE"
  remove_tree "$TIP"
  finish rolled-back 1 "$failure; rolled back to $previous"
}

require_green
# Only the deployed tree stays while the tip's is staged, so at most two trees
# exist at once. After an update the kept pair is the new deployed tree and the
# one before it, which a failed later run rolls back to.
for commit in $(created_trees); do
  remove_tree "$commit"
done
stage

if install_tree "$TIP"; then
  printf '%s\n' "$TIP" | replace "$MARKER"
  finish updated 0 "deployed $TIP"
fi
roll_back
