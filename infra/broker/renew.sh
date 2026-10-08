#!/bin/bash
# Renew the broker's certificate by ACME DNS-01 (README.md, Certificates), then
# restart each running unit whose inputs are newer than its start
# (unit-state.sh), whether or not the renewal succeeded; a failed renewal still
# exits non-zero after that. --no-restart, which install.sh passes, renews only.
#
#   renew.sh [--no-restart]
set -euo pipefail

NO_RESTART=0
if [ "$#" -eq 1 ] && [ "$1" = --no-restart ]; then
  NO_RESTART=1
elif [ "$#" -ne 0 ]; then
  printf 'usage: renew.sh [--no-restart]\n' >&2
  exit 2
fi

# Literal paths, as in install.sh; ALCOVE_BROKER_INSTALL_ROOT prefixes them for
# scripts/broker-front.test.mjs.
ROOT="${ALCOVE_BROKER_INSTALL_ROOT:-}"
ETC="$ROOT/etc/alcove-broker"
UNIT_DIR="$ROOT/etc/systemd/system"
ENV_FILE="$ETC/broker.env"
ACME_HOME="$ETC/acme"
TLS="$ETC/tls"
DAYS="${ALCOVE_BROKER_RENEW_DAYS:-30}"

die() { printf 'ABORTING: %s\n' "$*" >&2; exit 1; }
log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }

# shellcheck source=unit-state.sh
. "$(dirname "$0")/unit-state.sh"

# The lock install.sh holds when it runs this script, on the descriptor it
# passes; opening the file again would wait on install.sh itself.
LOCK_FD="${ALCOVE_BROKER_LOCK_FD:-}"
if [ -z "$LOCK_FD" ]; then
  (umask 077 && : >> "$ETC/lock")
  exec 9>> "$ETC/lock"
  LOCK_FD=9
fi
if ! flock -n "$LOCK_FD"; then
  log "waiting for another install.sh or renew.sh run to finish"
  flock "$LOCK_FD"
fi

renew_certificate() {
  [ -f "$ENV_FILE" ] || die "no $ENV_FILE; copy broker.env.example there and set ALCOVE_BROKER_NAME"
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  local name="${ALCOVE_BROKER_NAME:-}"
  [ -n "$name" ] || die "ALCOVE_BROKER_NAME is unset in $ENV_FILE; refusing to guess a name"
  local acme_env="${ALCOVE_BROKER_ACME_ENV:-/etc/alcove-relay/acme.env}"

  [ -f "$acme_env" ] || die "no $acme_env; copy infra/relay/certs/env.example there at mode 600 and fill it in"
  # Plain source for this script's own reads: an export-all source here would
  # leave the provider credential in the environment of systemctl.
  # shellcheck disable=SC1090
  . "$acme_env"
  local email="${ALCOVE_RELAY_ACME_EMAIL:-}" provider="${ALCOVE_RELAY_DNS_PROVIDER:-cloudflare}"
  [ -n "$email" ] || die "ALCOVE_RELAY_ACME_EMAIL is unset in $acme_env"
  case "${ALCOVE_RELAY_ACME_CLIENT:-lego}" in
    lego) ;;
    *) die "ALCOVE_RELAY_ACME_CLIENT is '$ALCOVE_RELAY_ACME_CLIENT' in $acme_env; this script drives lego only" ;;
  esac
  command -v lego >/dev/null 2>&1 || die "lego is not installed; see Certificates in infra/relay/README.md"

  install -d -m 700 "$ACME_HOME"
  install -d -m 755 "$TLS"

  log "renewing the certificate for $name through $provider (no-op outside the window, renew-days $DAYS)"
  (
    set -a
    # shellcheck disable=SC1090
    . "$acme_env"
    set +a
    # shellcheck disable=SC2086
    lego run --accept-tos --email "$email" --dns "$provider" --domains "$name" \
      --path "$ACME_HOME" --renew-days "$DAYS" ${ALCOVE_BROKER_LEGO_EXTRA:-}
  ) || die "lego did not renew the certificate for $name; its output is above"
  local crt="$ACME_HOME/certificates/$name.crt" key="$ACME_HOME/certificates/$name.key"
  [ -s "$crt" ] && [ -s "$key" ] || die "lego reported success but left no certificate at $crt"

  if cmp -s "$crt" "$TLS/fullchain.pem" && cmp -s "$key" "$TLS/privkey.pem"; then
    log "the certificate is unchanged"
  else
    install -m 600 "$key" "$TLS/privkey.pem"
    install -m 644 "$crt" "$TLS/fullchain.pem"
    log "installed a new certificate"
  fi
}

if [ "$NO_RESTART" = 1 ]; then
  renew_certificate
  exit 0
fi

# In a subshell, so a failed renewal stops the renewal and not the restarts.
set +e
(
  set -e
  renew_certificate
)
RENEWED=$?
set -e
restart_stale_units
[ "$RENEWED" = 0 ] || exit "$RENEWED"
