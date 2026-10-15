#!/bin/bash
# Run one daily job of the relay host under the host's maintenance lock, so no
# two daily jobs, and no daily job and a host hand-off, run at once (README.md,
# The daily schedule). Every daily job's unit runs its command through this
# script; the relay's, the broker's and the host pull's install scripts each
# put a copy beside their own scripts.
#
#   maintenance-lock.sh <maximum seconds> <command> [<argument>...]
#
# It waits up to two hours for the lock. When the lock is still held then, it
# logs that the job did not run and exits 0, so the next day's run goes ahead
# as usual. Holding the lock, it runs the command with TERM sent 30 seconds
# before the maximum and KILL at it. The command does not inherit the lock's
# descriptor, so a process it leaves behind does not hold the lock.
set -uo pipefail

# ALCOVE_MAINTENANCE_LOCK moves the lock for scripts/relay-host-schedule.test.mjs.
LOCK="${ALCOVE_MAINTENANCE_LOCK:-/run/lock/alcove-maintenance.lock}"
WAIT_DEFAULT=7200
KILL_AFTER_DEFAULT=30

# Prints the override when it is a positive integer no larger than the default,
# and the default otherwise.
lowered() {
  if [[ "$1" =~ ^[1-9][0-9]{0,8}$ ]] && [ "$1" -le "$2" ]; then printf '%s' "$1"; else printf '%s' "$2"; fi
}
WAIT="$(lowered "${ALCOVE_MAINTENANCE_LOCK_WAIT:-}" "$WAIT_DEFAULT")"
KILL_AFTER="$(lowered "${ALCOVE_MAINTENANCE_KILL_AFTER:-}" "$KILL_AFTER_DEFAULT")"

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }

if [ "$#" -lt 2 ] || ! [[ "$1" =~ ^[1-9][0-9]{0,8}$ ]] || [ "$1" -le "$KILL_AFTER" ]; then
  printf 'usage: maintenance-lock.sh <maximum seconds, above %s> <command> [<argument>...]\n' "$KILL_AFTER" >&2
  exit 2
fi
MAX="$1"
shift
JOB="$(basename "$1")"

command -v flock >/dev/null 2>&1 || { log "flock is not installed; it comes with util-linux"; exit 1; }
command -v timeout >/dev/null 2>&1 || { log "timeout is not installed; it comes with coreutils"; exit 1; }

exec 9>> "$LOCK" || { log "could not open $LOCK; $JOB did not run"; exit 1; }
if ! flock -w "$WAIT" 9; then
  log "$JOB did not run: $LOCK was held for $WAIT seconds, by a host hand-off or another daily job. The next scheduled run goes ahead."
  exit 0
fi

status=0
timeout -k "$KILL_AFTER" "$((MAX - KILL_AFTER))" "$@" 9>&- || status=$?
if [ "$status" = 124 ] || [ "$status" = 137 ]; then
  log "$JOB was stopped at its maximum run time of $MAX seconds"
fi
exit "$status"
