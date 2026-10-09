# Sourced by install.sh and renew.sh, under the lock both take. A running unit
# whose inputs changed at or after its last start, or whose unit file systemd
# has not reloaded, is restarted; nothing records a restart to make later, so
# a run that dies first leaves the same state for the next run to find.
# Expects UNIT_DIR, ETC, TLS and log().

FRONT=alcove-broker-tls.service
BROKER=alcove-broker.service
TIMER=alcove-broker-cert.timer

# go_live STAGED TARGET [STAGED TARGET...]: rename each staged file over its
# target, then set every target's mtime to a clock read after the last rename.
# The kernel stamps a write from a coarse clock, up to a tick before the write,
# so only an explicit stamp taken after the rename makes a unit that started
# before any target went live count as stale.
go_live() {
  local targets=()
  while [ "$#" -ge 2 ]; do
    mv -f "$1" "$2"
    targets+=("$2")
    shift 2
  done
  touch -m -d "@$(date +%s.%N)" "${targets[@]}"
}

# Microseconds since the epoch, from date's %s%N. Not %6N: uutils date, the
# date on Ubuntu 26.04, drops a fraction's leading zeros before cutting it to
# six digits, so 0.024 s comes out as 0.240 s.
ns_to_us() { local ns="$1"; echo "${ns%???}"; }

# Microseconds since the epoch at which UNIT last became active, on the wall
# clock file mtimes use; 0 if it never did or the stamp does not parse, which
# makes every input count as newer.
start_us() {
  local stamp ns
  stamp="$(systemctl show -p ActiveEnterTimestamp --value --timestamp=us+utc "$1")"
  if [ -z "$stamp" ]; then
    echo 0
  elif ns="$(date -u -d "$stamp" +%s%N 2>/dev/null)"; then
    ns_to_us "$ns"
  else
    echo 0
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
    [ "$(ns_to_us "$(date -r "$file" +%s%N)")" -lt "$start" ] || return 0
  done
  return 1
}

front_stale() {
  stale "$FRONT" "$UNIT_DIR/$FRONT" "$ETC/front-image.env" "$ETC/nginx.conf" \
    "$TLS/fullchain.pem" "$TLS/privkey.pem"
}

# restart_stale_units [--install]: run daemon-reload when a unit needs it (or
# always, under --install), then restart the running broker and front if
# stale, and under --install the renewal timer too: renew.sh runs as the
# service that timer starts. Each restart is decided before the reload, which
# clears NeedDaemonReload. A stopped unit is left stopped: it reads the
# current state when it starts.
restart_stale_units() {
  local broker=0 front=0 timer=0 reload=0 unit front_start
  if systemctl is-active --quiet "$BROKER" && stale "$BROKER" "$UNIT_DIR/$BROKER"; then
    broker=1
  fi
  if systemctl is-active --quiet "$FRONT" && front_stale; then
    front=1
  fi
  if [ "${1:-}" = --install ]; then
    reload=1
    if systemctl is-active --quiet "$TIMER" && stale "$TIMER" "$UNIT_DIR/$TIMER"; then
      timer=1
    fi
  fi
  for unit in "$BROKER" "$FRONT" alcove-broker-cert.service "$TIMER"; do
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
  if [ "$timer" = 1 ]; then
    log "restarting $TIMER onto its unit file"
    systemctl try-restart "$TIMER"
  fi
}
