# Sourced by install.sh and renew.sh, under the lock both take. A running unit
# whose inputs changed at or after its last start, or whose unit file systemd
# has not reloaded, is restarted; nothing records a restart to make later, so
# a run that dies first leaves the same state for the next run to find.
# Expects UNIT_DIR, ETC, TLS and log().

FRONT=alcove-broker-tls.service
BROKER=alcove-broker.service

# Microseconds since the epoch at which UNIT last became active, on the wall
# clock file mtimes use; 0 if it never did or the stamp does not parse, which
# makes every input count as newer.
start_us() {
  local stamp
  stamp="$(systemctl show -p ActiveEnterTimestamp --value --timestamp=us+utc "$1")"
  if [ -z "$stamp" ]; then
    echo 0
  else
    date -u -d "$stamp" +%s%6N 2>/dev/null || echo 0
  fi
}

# stale UNIT FILE...: systemd holds an outdated copy of UNIT's unit file, or a
# FILE was written at or after UNIT's last start.
stale() {
  local unit="$1" start file
  shift
  [ "$(systemctl show -p NeedDaemonReload --value "$unit")" != yes ] || return 0
  start="$(start_us "$unit")"
  for file in "$@"; do
    [ -e "$file" ] || continue
    [ "$(date -r "$file" +%s%6N)" -lt "$start" ] || return 0
  done
  return 1
}

front_stale() {
  stale "$FRONT" "$UNIT_DIR/$FRONT" "$ETC/front-image.env" "$ETC/nginx.conf" \
    "$TLS/fullchain.pem" "$TLS/privkey.pem"
}

# restart_stale_units [--reload]: run daemon-reload when a unit needs it (or
# always, with --reload), then restart the running broker and front if stale.
# A stopped unit is left stopped: it reads the current state when it starts.
restart_stale_units() {
  local broker=0 front=0 reload=0 unit front_start
  if systemctl is-active --quiet "$BROKER" && stale "$BROKER" "$UNIT_DIR/$BROKER"; then
    broker=1
  fi
  if systemctl is-active --quiet "$FRONT" && front_stale; then
    front=1
  fi
  [ "${1:-}" != --reload ] || reload=1
  for unit in "$BROKER" "$FRONT" alcove-broker-cert.service alcove-broker-cert.timer; do
    [ "$(systemctl show -p NeedDaemonReload --value "$unit")" != yes ] || reload=1
  done
  [ "$reload" = 0 ] || systemctl daemon-reload

  front_start="$(start_us "$FRONT")"
  if [ "$broker" = 1 ]; then
    log "restarting $BROKER onto its unit file"
    systemctl try-restart "$BROKER"
  fi
  # The front Requires= the broker, so restarting the broker restarts a
  # running front as well, which moves its start time.
  if [ "$front" = 1 ] && [ "$(start_us "$FRONT")" = "$front_start" ]; then
    log "restarting $FRONT onto its unit file, image, configuration and certificate"
    systemctl try-restart "$FRONT"
  fi
}
