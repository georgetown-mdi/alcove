#!/bin/bash
# Install the standalone broker, its TLS front and the front's certificate
# renewal on this host. Idempotent: run it again after an edit to a unit, the
# template or renew.sh and it converges.
#
# Under the lock renew.sh also takes: check the whole target state, renew the
# certificate without restarting anything, write every file the units read,
# then restart each running unit whose inputs are newer than its start
# (unit-state.sh) and start any that is stopped. A run that dies in between
# leaves those inputs newer, so the next run of either script restarts it; the
# renewal timer's own unit is restarted by the next install.sh only.
#
#   install.sh
#
# It installs units and configuration only. The broker's workspace under
# /opt/alcove-broker/src (Node, the clone, the scoped install, core's built
# entry point) is a precondition, set up as README.md, Install, describes; this
# script refuses to run without it.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# Literal paths: the unit files name them too, and cannot read a variable.
# ALCOVE_BROKER_INSTALL_ROOT prefixes them for scripts/broker-front.test.mjs.
ROOT="${ALCOVE_BROKER_INSTALL_ROOT:-}"
ETC="$ROOT/etc/alcove-broker"
SRC="$ROOT/opt/alcove-broker/src"
UNIT_DIR="$ROOT/etc/systemd/system"
ENV_FILE="$ETC/broker.env"
PORT=8443

[ "$#" -eq 0 ] || { printf 'usage: install.sh\n' >&2; exit 2; }

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
die() { printf '[%s] ABORTING: %s\n' "$(date -u +%FT%TZ)" "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "install.sh writes under /etc; run it as root"

install -d -m 700 "$ETC"
command -v flock >/dev/null 2>&1 || die "flock is not installed; it comes with util-linux"
(umask 077 && : >> "$ETC/lock")
exec 9>> "$ETC/lock"
if ! flock -n 9; then
  log "waiting for another install.sh or renew.sh run to finish"
  flock 9
fi

# --- preconditions --------------------------------------------------------------
[ -f "$ENV_FILE" ] || die "no $ENV_FILE. Copy broker.env.example there at mode 600, set ALCOVE_BROKER_NAME, and run again"
# shellcheck disable=SC1090
. "$ENV_FILE"
NAME="${ALCOVE_BROKER_NAME:-}"
# Renders before anything is written, so a bad name stops the run here.
RENDERED="$(ALCOVE_BROKER_ENV_FILE="$ENV_FILE" "$HERE/render-config.sh")"
ACME_ENV="${ALCOVE_BROKER_ACME_ENV:-/etc/alcove-relay/acme.env}"
[ -f "$ACME_ENV" ] || die "no $ACME_ENV, which has the ACME contact and the DNS provider credential; see broker.env.example"

[ -x "$ROOT/usr/local/bin/npm" ] || die "alcove-broker.service runs /usr/local/bin/npm, which this host does not have; see README.md, Install"
[ -x "$SRC/node_modules/.bin/tsx" ] || die "no broker workspace install at $SRC; see README.md, Install"
[ -s "$SRC/packages/core/dist/untrusted-text.esm.js" ] \
  || die "$SRC has no built core entry point the broker imports; see README.md, Install"
[ "$(command -v docker || true)" = "$ROOT/usr/bin/docker" ] \
  || die "alcove-broker-tls.service runs /usr/bin/docker, which is not docker on this host"
command -v lego >/dev/null 2>&1 || die "lego is not installed; see Certificates in infra/relay/README.md"
command -v curl >/dev/null 2>&1 || die "curl is not installed; the end-of-install check needs it"
# The front's image, by digest: Dockerfile's FROM line is its one home.
IMAGE="$(sed -n 's/^FROM //p' "$HERE/Dockerfile")"
[[ "$IMAGE" =~ ^docker\.io/library/nginx:[^@[:space:]]+@sha256:[0-9a-f]{64}$ ]] \
  || die "$HERE/Dockerfile names no nginx image pinned by digest (FROM $IMAGE). Set its FROM to docker.io/library/nginx:<tag>@sha256:<index digest> and run again"

log "installing the broker for $NAME"

TLS="$ETC/tls"
# shellcheck source=unit-state.sh
. "$HERE/unit-state.sh"
CANDIDATE="$(mktemp "$ETC/nginx.conf.XXXXXX")"
IMAGE_ENV="$(mktemp "$ETC/front-image.env.XXXXXX")"
STAGED=()
trap 'rm -f "$CANDIDATE" "$IMAGE_ENV" "${STAGED[@]}"' EXIT

differs() { ! { [ -f "$2" ] && cmp -s "$1" "$2"; }; }
# A changed file is staged beside its target and renamed over it, so nothing
# reads it half-written.
put_file() {
  local staged
  if differs "$1" "$2"; then
    staged="$(mktemp "$(dirname "$2")/.$(basename "$2").XXXXXX")"
    STAGED+=("$staged")
    install -m "$3" "$1" "$staged"
    go_live "$staged" "$2"
  else
    chmod "$3" "$2"
  fi
}
renew() {
  put_file "$HERE/renew.sh" "$ETC/renew.sh" 700
  put_file "$HERE/unit-state.sh" "$ETC/unit-state.sh" 600
  ALCOVE_BROKER_LOCK_FD=9 "$ETC/renew.sh" --no-restart
}

# --- a first install's certificate --------------------------------------------------
# nginx -t loads the certificate, so a first install obtains it before the
# check. The front must be stopped: the next renew.sh would restart a running
# one onto the new certificate whether or not the check passed.
CERT_OBTAINED=0
if [ ! -s "$TLS/fullchain.pem" ] || [ ! -s "$TLS/privkey.pem" ]; then
  if systemctl is-active --quiet alcove-broker-tls.service; then
    die "alcove-broker-tls.service is running but $TLS has no certificate. Stop it (systemctl stop alcove-broker-tls.service) and run install.sh again"
  fi
  log "no certificate in $TLS yet; obtaining one to check the configuration against"
  renew
  CERT_OBTAINED=1
fi

# --- the front's configuration ----------------------------------------------------
# Checked by nginx -t in the front's image, mounted as the unit mounts it, before
# anything restarts: a failure leaves the units, the certificate and the live
# file as they were.
docker pull -q "$IMAGE" >/dev/null
printf '%s\n' "$RENDERED" > "$CANDIDATE"
docker run --rm --network host --read-only --tmpfs /tmp \
  -v "$CANDIDATE:/etc/nginx/nginx.conf:ro" \
  -v "$TLS:/etc/nginx/tls:ro" \
  --entrypoint nginx "$IMAGE" -t \
  || die "the rendered configuration fails nginx -t; the units, the certificate, $ETC/nginx.conf and the running front are unchanged. Fix nginx.conf.tmpl and run again"

# --- a renewal due now ------------------------------------------------------------
# Before the target state is written, so a failed renewal leaves it unchanged.
[ "$CERT_OBTAINED" = 1 ] || renew

# --- the target state -------------------------------------------------------------
# A file is written only when its content changes: its mtime, stamped after
# it goes live, is what makes the unit that reads it count as stale.
printf 'ALCOVE_BROKER_FRONT_IMAGE=%s\n' "$IMAGE" > "$IMAGE_ENV"
put_file "$HERE/alcove-broker.service" "$UNIT_DIR/alcove-broker.service" 644
put_file "$HERE/alcove-broker-tls.service" "$UNIT_DIR/alcove-broker-tls.service" 644
put_file "$IMAGE_ENV" "$ETC/front-image.env" 644
put_file "$HERE/alcove-broker-cert.service" "$UNIT_DIR/alcove-broker-cert.service" 644
put_file "$HERE/alcove-broker-cert.timer" "$UNIT_DIR/alcove-broker-cert.timer" 644
CONF="$ETC/nginx.conf"
if differs "$CANDIDATE" "$CONF"; then
  chmod 644 "$CANDIDATE"
  go_live "$CANDIDATE" "$CONF"
fi
chmod 644 "$CONF"

# --- the units ----------------------------------------------------------------------
restart_stale_units --install
for unit in "$BROKER" "$FRONT" "$TIMER"; do
  if systemctl is-active --quiet "$unit"; then
    systemctl enable "$unit"
  else
    systemctl enable --now "$unit"
  fi
done

# --- check ------------------------------------------------------------------------
log "waiting for the broker's health endpoint on 127.0.0.1:9411"
for _ in $(seq 1 60); do
  curl -fsS http://127.0.0.1:9411/api/health >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS http://127.0.0.1:9411/api/health >/dev/null \
  || die "the broker did not answer on 127.0.0.1:9411/api/health within 120 s; journalctl -u alcove-broker.service"
# Through the front on this host, under the certificate's own name.
for _ in $(seq 1 15); do
  curl -fsS --resolve "$NAME:$PORT:127.0.0.1" "https://$NAME:$PORT/api/health" >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS --resolve "$NAME:$PORT:127.0.0.1" "https://$NAME:$PORT/api/health" >/dev/null \
  || die "the front did not answer https://$NAME:$PORT/api/health within 30 s; journalctl -u alcove-broker-tls.service"
log "the front answers https://$NAME:$PORT/api/health"
