#!/bin/bash
# Install the standalone broker, its TLS front and the front's certificate
# renewal on this host. Idempotent: run it again after an edit to a unit, the
# template or renew.sh and it converges.
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
IMAGE=nginx:1.29-alpine
PORT=8443

[ "$#" -eq 0 ] || { printf 'usage: install.sh\n' >&2; exit 2; }

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
die() { printf '[%s] ABORTING: %s\n' "$(date -u +%FT%TZ)" "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "install.sh writes under /etc; run it as root"

# --- preconditions --------------------------------------------------------------
install -d -m 700 "$ETC"
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

log "installing the broker for $NAME"

# put_file SOURCE DEST MODE: install SOURCE at DEST, setting CHANGED=1 when the
# content differs.
CHANGED=0
put_file() {
  if [ -f "$2" ] && cmp -s "$1" "$2"; then
    chmod "$3" "$2"
    return
  fi
  install -m "$3" "$1" "$2"
  CHANGED=1
}

# --- the broker -----------------------------------------------------------------
CHANGED=0
put_file "$HERE/alcove-broker.service" "$UNIT_DIR/alcove-broker.service" 644
BROKER_UNIT_CHANGED=$CHANGED
BROKER_WAS_ACTIVE=0
systemctl is-active --quiet alcove-broker.service && BROKER_WAS_ACTIVE=1
systemctl daemon-reload
systemctl enable --now alcove-broker.service
if [ "$BROKER_WAS_ACTIVE" = 1 ] && [ "$BROKER_UNIT_CHANGED" = 1 ]; then
  log "alcove-broker.service changed; restarting it"
  systemctl restart alcove-broker.service
fi
log "waiting for the broker's health endpoint on 127.0.0.1:9411"
for _ in $(seq 1 60); do
  curl -fsS http://127.0.0.1:9411/api/health >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS http://127.0.0.1:9411/api/health >/dev/null \
  || die "the broker did not answer on 127.0.0.1:9411/api/health within 120 s; journalctl -u alcove-broker.service"

# --- the certificate --------------------------------------------------------------
put_file "$HERE/renew.sh" "$ETC/renew.sh" 700
TLS="$ETC/tls"
CANDIDATE="$(mktemp "$ETC/nginx.conf.XXXXXX")"
RESTART_MARK="$(mktemp "$ETC/restart.XXXXXX")"
trap 'rm -f "$CANDIDATE" "$RESTART_MARK"' EXIT
# renew [MARK]: run renew.sh, which writes to MARK when it restarts the front.
renew() {
  ALCOVE_BROKER_ENV_FILE="$ENV_FILE" ALCOVE_BROKER_ACME_HOME="$ETC/acme" ALCOVE_BROKER_TLS_DIR="$TLS" \
    ALCOVE_BROKER_RESTART_MARK="${1:-}" "$ETC/renew.sh"
}
# nginx -t loads the certificate, so a first install obtains it before the
# configuration is checked. No restart mark: it would precede the new file.
CERT_OBTAINED=0
if [ ! -s "$TLS/fullchain.pem" ] || [ ! -s "$TLS/privkey.pem" ]; then
  log "no certificate in $TLS yet; obtaining one to check the configuration against"
  renew
  CERT_OBTAINED=1
fi

# --- the front's configuration ----------------------------------------------------
# Checked by nginx -t in the front's image, mounted as the unit mounts it,
# before it reaches the live file.
docker pull -q "$IMAGE" >/dev/null
printf '%s\n' "$RENDERED" > "$CANDIDATE"
docker run --rm --network host --read-only --tmpfs /tmp \
  -v "$CANDIDATE:/etc/nginx/nginx.conf:ro" \
  -v "$TLS:/etc/nginx/tls:ro" \
  --entrypoint nginx "$IMAGE" -t \
  || die "the rendered configuration fails nginx -t; $ETC/nginx.conf and the running front are unchanged. Fix nginx.conf.tmpl and run again"
# Copied in place when it exists: the front bind-mounts the file, and a new
# inode would leave the running container reading the old one.
CONF="$ETC/nginx.conf"
CONF_CHANGED=0
if [ ! -f "$CONF" ]; then
  install -m 644 "$CANDIDATE" "$CONF"
  CONF_CHANGED=1
elif ! cmp -s "$CANDIDATE" "$CONF"; then
  cat "$CANDIDATE" > "$CONF"
  CONF_CHANGED=1
fi
chmod 644 "$CONF"

# --- a renewal due now ------------------------------------------------------------
[ "$CERT_OBTAINED" = 1 ] || renew "$RESTART_MARK"
FRONT_RESTARTED=0
[ -s "$RESTART_MARK" ] && FRONT_RESTARTED=1

# --- the front --------------------------------------------------------------------
CHANGED=0
put_file "$HERE/alcove-broker-tls.service" "$UNIT_DIR/alcove-broker-tls.service" 644
FRONT_UNIT_CHANGED=$CHANGED
FRONT_WAS_ACTIVE=0
systemctl is-active --quiet alcove-broker-tls.service && FRONT_WAS_ACTIVE=1
systemctl daemon-reload
systemctl enable --now alcove-broker-tls.service
if [ "$FRONT_WAS_ACTIVE" = 1 ]; then
  if [ "$FRONT_UNIT_CHANGED" = 1 ]; then
    log "alcove-broker-tls.service changed; restarting it"
    systemctl restart alcove-broker-tls.service
  elif [ "$CONF_CHANGED" = 1 ] && [ "$FRONT_RESTARTED" = 1 ]; then
    # The configuration was written before renew.sh restarted the front.
    log "alcove-broker-tls.service restarted onto the new configuration with the certificate"
  elif [ "$CONF_CHANGED" = 1 ]; then
    for _ in $(seq 1 30); do
      docker exec alcove-broker-tls true >/dev/null 2>&1 && break
      sleep 1
    done
    docker exec alcove-broker-tls true >/dev/null 2>&1 \
      || die "the alcove-broker-tls container did not accept docker exec within 30 s; journalctl -u alcove-broker-tls.service"
    # A reload keeps open WebSockets; a restart would drop them.
    docker exec alcove-broker-tls nginx -s reload
    log "alcove-broker-tls.service reloaded onto the new configuration"
  fi
fi

# --- renewal ----------------------------------------------------------------------
CHANGED=0
put_file "$HERE/alcove-broker-cert.service" "$UNIT_DIR/alcove-broker-cert.service" 644
put_file "$HERE/alcove-broker-cert.timer" "$UNIT_DIR/alcove-broker-cert.timer" 644
systemctl daemon-reload
systemctl enable --now alcove-broker-cert.timer
if [ "$CHANGED" = 1 ]; then
  systemctl restart alcove-broker-cert.timer
fi

# --- check ------------------------------------------------------------------------
# Through the front on this host, under the certificate's own name.
for _ in $(seq 1 15); do
  curl -fsS --resolve "$NAME:$PORT:127.0.0.1" "https://$NAME:$PORT/api/health" >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS --resolve "$NAME:$PORT:127.0.0.1" "https://$NAME:$PORT/api/health" >/dev/null \
  || die "the front did not answer https://$NAME:$PORT/api/health within 30 s; journalctl -u alcove-broker-tls.service"
log "the front answers https://$NAME:$PORT/api/health"
