#!/bin/bash
# Bring this host to the tip of main: a tree of that commit with core's signed
# build unpacked into it, then the broker's and the relay's install scripts.
# alcove-host-pull.timer runs the copy install.sh put under /opt/alcove-host-pull,
# never a copy inside a tree this script switches.
#
#   pull.sh
#
# Each run ends with one outcome in the status file (README.md, The status
# file): unchanged or updated, skipped when there is nothing to take yet (exit
# 0), refused when the commit or its build fails a check, and failed when a
# step could not run (both exit 1). It holds no credential and builds nothing.
set -Eeuo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# Literal paths, as in the broker's install.sh. ALCOVE_HOST_PULL_INSTALL_ROOT
# prefixes them for scripts/host-pull.test.mjs.
ROOT="${ALCOVE_HOST_PULL_INSTALL_ROOT:-}"
STATE="$ROOT/var/lib/alcove-host-pull"
STATUS="$STATE/status"
WORK="$STATE/work"
BROKER_DIR="$ROOT/opt/alcove-broker"
SRC="$BROKER_DIR/src"
TREES="$BROKER_DIR/trees"

REPOSITORY_URL=https://github.com/georgetown-mdi/alcove.git
API_URL=https://api.github.com/repos/georgetown-mdi/alcove
RELEASE_URL=https://github.com/georgetown-mdi/alcove/releases/download/broker-core-build

TIP=""
PARTIAL=""

[ "$#" -eq 0 ] || { printf 'usage: pull.sh\n' >&2; exit 2; }

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }

[ "$(id -u)" = 0 ] || { log "pull.sh writes under /opt and /var/lib; run it as root"; exit 1; }

deployed() {
  local target
  target="$(readlink "$SRC" 2>/dev/null || true)"
  if [[ "$target" =~ ^trees/[0-9a-f]{40}$ ]]; then
    printf '%s' "${target#trees/}"
  fi
}

# outcome, exit status, reason. Written to a new file renamed over the old, so a
# reader never sees half a record.
finish() {
  trap - ERR
  log "$1: $3"
  printf 'deployed_commit=%s\nmain_commit=%s\noutcome=%s\nreason=%s\ntime=%s\n' \
    "$(deployed)" "$TIP" "$1" "$3" "$(date -u +%FT%TZ)" > "$STATUS.new"
  chmod 644 "$STATUS.new"
  mv -f "$STATUS.new" "$STATUS"
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

for tool in git curl cosign node npm sha256sum tar nice ionice; do
  command -v "$tool" >/dev/null 2>&1 || finish failed 1 "$tool is not installed; see README.md, Install"
done
if [ -L "$SRC" ]; then
  [ -n "$(deployed)" ] \
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
if [ "$(deployed)" = "$TIP" ]; then
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

runs="$WORK/check-runs.json"
download "$API_URL/commits/$TIP/check-runs?per_page=100" "$runs" \
  || finish failed 1 "could not read the check runs of $TIP"
[ "$CODE" = 200 ] || finish failed 1 "GitHub answered HTTP $CODE for the check runs of $TIP"
verdict="$(node "$HERE/check-runs.mjs" "$runs")" || finish failed 1 "could not read the check runs of $TIP"
case "$verdict" in
  "green "*) log "every check run on $TIP passed (${verdict#green })" ;;
  "pending "*) finish skipped 0 "CI has not finished on $TIP: ${verdict#pending }" ;;
  none) finish skipped 0 "no check run has reported on $TIP yet" ;;
  "red "*) finish refused 1 "CI did not pass on $TIP: ${verdict#red }" ;;
  *) finish failed 1 "the check runs of $TIP were not read: ${verdict#unread }" ;;
esac

archive="alcove-broker-core-$TIP.tar.gz"
bundle="$archive.sigstore.json"
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

(cd "$PARTIAL" && nice -n 10 ionice -c 3 npm ci --no-audit --no-fund --workspace packages/peerjs-broker) >&2 \
  || finish failed 1 "npm ci of the broker workspace failed at $TIP"

# Owned by root and readable by all, so the broker's account cannot rewrite the
# code it runs (infra/broker/README.md, Install step 6).
chown -R 0:0 "$PARTIAL"
chmod -R u=rwX,go=rX "$PARTIAL"
tree="$TREES/$TIP"
rm -rf "$tree"
mv -T "$PARTIAL" "$tree"
PARTIAL=""

rm -f "$BROKER_DIR/.src.new"
ln -s "trees/$TIP" "$BROKER_DIR/.src.new"
mv -fT "$BROKER_DIR/.src.new" "$SRC"
log "$SRC links to $TIP"

# The broker's install.sh restarts the broker only for a changed unit file, and
# a switched tree is not one.
systemctl try-restart alcove-broker.service \
  || finish failed 1 "alcove-broker.service did not restart on $TIP"
"$tree/infra/broker/install.sh" >&2 \
  || finish failed 1 "infra/broker/install.sh failed at $TIP"
# Ends with verify.sh against the relay's private address.
"$tree/infra/relay/install.sh" >&2 \
  || finish failed 1 "infra/relay/install.sh or its verify.sh failed at $TIP"
finish updated 0 "deployed $TIP"
