#!/bin/bash
# Put the ACME client's certificate where the relay's 443 front and the
# registrar read it, owned by the account that runs this hook, root, and
# restart both when either file changed.
#
# The owner is required, not tidiness. The front's nginx master reads the key
# as root with every capability dropped, so it reads only a key root owns, and
# fails to start on any other; the registrar reads it through systemd, as root.
#
# Restart rather than reload: whether the front re-reads its certificate on a
# signal is a question nobody has driven against the real server, so this does
# the thing that certainly works. A restart drops every connection through 443,
# TURN allocations in flight among them, and renew.sh calls this hook daily
# whether or not the client renewed, so the restart runs only when the
# certificate or key differs from the deployed copy in content or owner. The
# comparison reads the files, not the ACME client's exit status or output, so it
# is the same for lego and acme.sh.
#
# A real Let's Encrypt certificate has been deployed through this script, on
# the 2026-09-03/04 live run (infra/relay/README.md, Design records and tests).
set -euo pipefail

ETC=/etc/alcove-relay
ENV_FILE="${ALCOVE_RELAY_ENV_FILE:-$ETC/relay.env}"
DEST="${ALCOVE_RELAY_CERT_DIR:-$ETC/certs}"

die() { printf 'ABORTING: %s\n' "$*" >&2; exit 1; }
log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }

[ -f "$ENV_FILE" ] || die "no $ENV_FILE; this host has not been installed as a relay"
# shellcheck disable=SC1090
. "$ENV_FILE"

SRC_CRT="${ALCOVE_RELAY_CERT_SOURCE:-}"
SRC_KEY="${ALCOVE_RELAY_KEY_SOURCE:-}"
[ -s "$SRC_CRT" ] || die "ALCOVE_RELAY_CERT_SOURCE names no certificate"
[ -s "$SRC_KEY" ] || die "ALCOVE_RELAY_KEY_SOURCE names no private key"

OWNER_UID="$(id -u)"
OWNER_GID="$(id -g)"

# GNU stat on the relay host; BSD stat, which has no -c, where its test suite runs
# on macOS.
if stat -c %u / >/dev/null 2>&1; then
  owner_uid() { stat -c %u "$1"; }
else
  owner_uid() { stat -f %u "$1"; }
fi
same_file() { [ -f "$2" ] && cmp -s "$1" "$2" && [ "$(owner_uid "$2")" = "$OWNER_UID" ]; }
CHANGED=yes
if same_file "$SRC_CRT" "$DEST/fullchain.pem" && same_file "$SRC_KEY" "$DEST/privkey.pem"; then
  CHANGED=
fi

install -d -m 755 "$DEST"
install -m 644 "$SRC_CRT" "$DEST/fullchain.pem"
install -m 600 "$SRC_KEY" "$DEST/privkey.pem"
chown "$OWNER_UID:$OWNER_GID" "$DEST/privkey.pem" "$DEST/fullchain.pem"
log "certificate deployed to $DEST, key owned by uid $OWNER_UID"

if [ -z "$CHANGED" ]; then
  if systemctl is-active --quiet alcove-relay-front.service; then
    log "certificate and key unchanged; alcove-relay-front.service left running"
  else
    log "certificate and key unchanged; alcove-relay-front.service is not running and was not started"
  fi
  exit 0
fi

# Nothing has started yet on a first install; install.sh starts it afterwards.
if systemctl is-active --quiet alcove-relay-front.service; then
  systemctl restart alcove-relay-front.service
  log "alcove-relay-front.service restarted onto the new certificate"
fi
# The registrar reads the same certificate at start; try-restart leaves a
# registrar that is not running stopped.
systemctl try-restart alcove-relay-registrar.service ||
  log "alcove-relay-registrar.service did not restart onto the new certificate; journalctl -u alcove-relay-registrar.service"
