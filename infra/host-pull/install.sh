#!/bin/bash
# Install the host pull: pull.sh, workflow-runs.mjs and the relay's
# maintenance-lock.sh under /opt/alcove-host-pull, and its service and timer.
# It enables nothing, and neither the relay's nor the broker's install.sh runs
# it (README.md, Install).
#
#   install.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# Literal paths: the service names /opt/alcove-host-pull/pull.sh.
# ALCOVE_HOST_PULL_INSTALL_ROOT prefixes them for scripts/host-pull.test.mjs.
ROOT="${ALCOVE_HOST_PULL_INSTALL_ROOT:-}"
LIBEXEC="$ROOT/opt/alcove-host-pull"
UNIT_DIR="$ROOT/etc/systemd/system"

[ "$#" -eq 0 ] || { printf 'usage: install.sh\n' >&2; exit 2; }

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
die() { printf '[%s] ABORTING: %s\n' "$(date -u +%FT%TZ)" "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "install.sh writes under /opt and /etc; run it as root"

# Each file is renamed into place, so a pull.sh that is running keeps reading
# the copy it started from.
install -d -m 755 "$LIBEXEC" "$UNIT_DIR"
for path in "$HERE/pull.sh" "$HERE/workflow-runs.mjs" "$HERE/../relay/maintenance-lock.sh"; do
  file="$(basename "$path")"
  install -m 755 "$path" "$LIBEXEC/.$file.new"
  mv -f "$LIBEXEC/.$file.new" "$LIBEXEC/$file"
done
for unit in alcove-host-pull.service alcove-host-pull.timer; do
  install -m 644 "$HERE/$unit" "$UNIT_DIR/.$unit.new"
  mv -f "$UNIT_DIR/.$unit.new" "$UNIT_DIR/$unit"
done
systemctl daemon-reload
systemctl try-restart alcove-host-pull.timer
log "installed; the timer runs only once enabled: systemctl enable --now alcove-host-pull.timer"
