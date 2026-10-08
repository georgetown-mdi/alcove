#!/bin/bash
# Renew the broker's certificate by ACME DNS-01 (README.md, Certificates) and
# restart the TLS front only when the certificate or key changed.
#
#   renew.sh [--defer-restart]
#
# A changed certificate is recorded in front-action-pending as a restart owed
# before it is installed, and the mark is cleared once the front restarts. A
# restart owed by an earlier run that did not finish is made here too. With
# --defer-restart the restart and the mark are left to install.sh.
set -euo pipefail

DEFER=0
if [ "$#" -eq 1 ] && [ "$1" = --defer-restart ]; then
  DEFER=1
elif [ "$#" -ne 0 ]; then
  printf 'usage: renew.sh [--defer-restart]\n' >&2
  exit 2
fi

ETC=/etc/alcove-broker
ENV_FILE="${ALCOVE_BROKER_ENV_FILE:-$ETC/broker.env}"
ACME_HOME="${ALCOVE_BROKER_ACME_HOME:-$ETC/acme}"
TLS="${ALCOVE_BROKER_TLS_DIR:-$ETC/tls}"
DAYS="${ALCOVE_BROKER_RENEW_DAYS:-30}"
PENDING="${ALCOVE_BROKER_FRONT_PENDING:-$ETC/front-action-pending}"

die() { printf 'ABORTING: %s\n' "$*" >&2; exit 1; }
log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }

# The front action a run owes and has not made: restart, reload or nothing.
# Anything but reload in the file counts as a restart.
pending_action() {
  [ -e "$PENDING" ] || return 0
  if [ "$(cat "$PENDING")" = reload ]; then echo reload; else echo restart; fi
}

[ -f "$ENV_FILE" ] || die "no $ENV_FILE; copy broker.env.example there and set ALCOVE_BROKER_NAME"
# shellcheck disable=SC1090
. "$ENV_FILE"
NAME="${ALCOVE_BROKER_NAME:-}"
[ -n "$NAME" ] || die "ALCOVE_BROKER_NAME is unset in $ENV_FILE; refusing to guess a name"
ACME_ENV="${ALCOVE_BROKER_ACME_ENV:-/etc/alcove-relay/acme.env}"

[ -f "$ACME_ENV" ] || die "no $ACME_ENV; copy infra/relay/certs/env.example there at mode 600 and fill it in"
# Plain source for this script's own reads: an export-all source here would
# leave the provider credential in the environment of systemctl below.
# shellcheck disable=SC1090
. "$ACME_ENV"
EMAIL="${ALCOVE_RELAY_ACME_EMAIL:-}"
[ -n "$EMAIL" ] || die "ALCOVE_RELAY_ACME_EMAIL is unset in $ACME_ENV"
PROVIDER="${ALCOVE_RELAY_DNS_PROVIDER:-cloudflare}"
case "${ALCOVE_RELAY_ACME_CLIENT:-lego}" in
  lego) ;;
  *) die "ALCOVE_RELAY_ACME_CLIENT is '$ALCOVE_RELAY_ACME_CLIENT' in $ACME_ENV; this script drives lego only" ;;
esac
command -v lego >/dev/null 2>&1 || die "lego is not installed; see Certificates in infra/relay/README.md"

install -d -m 700 "$ACME_HOME"
install -d -m 755 "$TLS"

log "renewing the certificate for $NAME through $PROVIDER (no-op outside the window, renew-days $DAYS)"
(
  set -a
  # shellcheck disable=SC1090
  . "$ACME_ENV"
  set +a
  # shellcheck disable=SC2086
  lego run --accept-tos --email "$EMAIL" --dns "$PROVIDER" --domains "$NAME" \
    --path "$ACME_HOME" --renew-days "$DAYS" ${ALCOVE_BROKER_LEGO_EXTRA:-}
)
SRC_CRT="$ACME_HOME/certificates/$NAME.crt"
SRC_KEY="$ACME_HOME/certificates/$NAME.key"
[ -s "$SRC_CRT" ] && [ -s "$SRC_KEY" ] || die "lego reported success but left no certificate at $SRC_CRT"

CHANGED=0
if ! cmp -s "$SRC_CRT" "$TLS/fullchain.pem" || ! cmp -s "$SRC_KEY" "$TLS/privkey.pem"; then
  MARK="$(mktemp "$PENDING.XXXXXX")"
  echo restart > "$MARK"
  mv -f "$MARK" "$PENDING"
  install -m 600 "$SRC_KEY" "$TLS/privkey.pem"
  install -m 644 "$SRC_CRT" "$TLS/fullchain.pem"
  CHANGED=1
fi

if [ "$DEFER" = 1 ]; then
  if [ "$CHANGED" = 1 ]; then
    log "installed a new certificate; install.sh restarts alcove-broker-tls.service"
  fi
  exit 0
fi
OWED="$(pending_action)"
if [ "$CHANGED" = 0 ] && [ "$OWED" != restart ]; then
  log "certificate unchanged; the TLS front is left running"
  if [ "$OWED" = reload ]; then
    log "an earlier install.sh did not reload alcove-broker-tls.service onto its configuration; run install.sh again"
  fi
  exit 0
fi

if [ "$CHANGED" = 1 ]; then
  WHY="installed a new certificate"
else
  WHY="an earlier run installed the front's certificate, image or unit and did not restart it"
fi
if systemctl is-active --quiet alcove-broker-tls.service; then
  log "$WHY; restarting alcove-broker-tls.service"
  systemctl restart alcove-broker-tls.service
else
  # A stopped front reads the installed state when it starts.
  log "$WHY; alcove-broker-tls.service is not running and was not started"
fi
rm -f "$PENDING"
