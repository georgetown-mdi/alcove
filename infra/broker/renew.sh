#!/bin/bash
# Renew the broker's certificate by ACME DNS-01 (README.md, Certificates) and
# restart the TLS front only when the certificate or key changed. When
# ALCOVE_BROKER_RESTART_MARK names a file, a restart writes to it.
set -euo pipefail

ETC=/etc/alcove-broker
ENV_FILE="${ALCOVE_BROKER_ENV_FILE:-$ETC/broker.env}"
ACME_HOME="${ALCOVE_BROKER_ACME_HOME:-$ETC/acme}"
TLS="${ALCOVE_BROKER_TLS_DIR:-$ETC/tls}"
DAYS="${ALCOVE_BROKER_RENEW_DAYS:-30}"

die() { printf 'ABORTING: %s\n' "$*" >&2; exit 1; }
log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }

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

if cmp -s "$SRC_CRT" "$TLS/fullchain.pem" && cmp -s "$SRC_KEY" "$TLS/privkey.pem"; then
  log "certificate unchanged; the TLS front is left running"
  exit 0
fi
install -m 600 "$SRC_KEY" "$TLS/privkey.pem"
install -m 644 "$SRC_CRT" "$TLS/fullchain.pem"
# On a first install the front has not started yet; install.sh starts it.
if systemctl is-active --quiet alcove-broker-tls.service; then
  log "installed a new certificate; restarting alcove-broker-tls.service"
  systemctl restart alcove-broker-tls.service
  [ -z "${ALCOVE_BROKER_RESTART_MARK:-}" ] || echo restarted > "$ALCOVE_BROKER_RESTART_MARK"
else
  log "installed a new certificate; alcove-broker-tls.service is not running and was not started"
fi
