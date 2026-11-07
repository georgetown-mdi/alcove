#!/bin/bash
# Publish the registrar's and the WebSocket relay's counts to CloudWatch, for
# the relay's alarms (README.md, Monitoring).
#
#   publish-metrics.sh [--heartbeat]
#
# The registrar writes each count since its start to its counters file
# (README.md, The registrar, What it counts), and the WebSocket relay writes
# its own (README.md, The WebSocket relay). A run publishes how much each
# count rose since the last publish, under the namespace Alcove/Relay in
# ALCOVE_RELAY_METRICS_REGION, then records the counts it published. A count
# that did not rise is not published. The first run that reads a file records
# its counts and publishes none, so counts from before the install do not land
# in one sum. A failed publish records nothing, so the next run publishes the
# same rise.
#
# The registrar's file is read strictly: a malformed one stops the run. The
# WebSocket relay's never does: a count it lacks, or a record of its counts
# that lacks one, is passed over with a line naming the file, and the rest are
# published, so a file an older relay wrote, or none, holds nothing up.
#
# The first run of each UTC day that reads the registrar's counts also
# publishes one heartbeat datapoint, in the same aws call as any rise; another
# run where no count rose starts no aws process. --heartbeat publishes one
# heartbeat and nothing else, recording nothing: install.sh's test publish.
set -euo pipefail

ENV_FILE="${ALCOVE_RELAY_ENV_FILE:-/etc/alcove-relay/relay.env}"
COUNTERS_FILE="${ALCOVE_RELAY_COUNTERS_FILE:-/var/lib/alcove-relay/registrar-counters}"
WEBSOCKET_COUNTERS_FILE="${ALCOVE_RELAY_WEBSOCKET_COUNTERS_FILE:-/var/lib/alcove-relay-websocket/counters}"
STATE_FILE="${ALCOVE_RELAY_METRICS_STATE_FILE:-/var/lib/alcove-relay-metrics/published}"
WEBSOCKET_STATE_FILE="$STATE_FILE-websocket"
# The instance role's PutMetricData permission names this namespace
# (aws/provision.md, The instance role).
NAMESPACE=Alcove/Relay
COUNTS=(tokenless_enrollments rate_limit_refusals client_cap_refusals tokenless_ceiling_refusals busy_refusals)
WEBSOCKET_COUNTS=(websocket_pairing_cap_refusals websocket_upgrade_cap_refusals)
HEARTBEAT_DATUM="MetricName=publisher_heartbeat,Value=1,Unit=Count"

die() { printf 'publish-metrics: %s\n' "$*" >&2; exit 1; }
note() { printf 'publish-metrics: %s\n' "$*" >&2; }

HEARTBEAT_ONLY=0
if [ "$#" -eq 1 ] && [ "$1" = --heartbeat ]; then
  HEARTBEAT_ONLY=1
elif [ "$#" -ne 0 ]; then
  printf 'usage: publish-metrics.sh [--heartbeat]\n' >&2
  exit 2
fi

[ -f "$ENV_FILE" ] || die "no $ENV_FILE"
# shellcheck disable=SC1090
. "$ENV_FILE"
[ -n "${ALCOVE_RELAY_METRICS_REGION:-}" ] \
  || die "ALCOVE_RELAY_METRICS_REGION is unset in $ENV_FILE; set it to the region the relay's alarms are in"

if [ "$HEARTBEAT_ONLY" = 1 ]; then
  command -v aws >/dev/null 2>&1 \
    || die "no aws command on PATH, so nothing can be published; install the AWS CLI version 2, or leave ALCOVE_RELAY_METRICS_REGION unset"
  aws cloudwatch put-metric-data --region "$ALCOVE_RELAY_METRICS_REGION" \
    --namespace "$NAMESPACE" --metric-data "$HEARTBEAT_DATUM" \
    || die "CloudWatch refused or did not answer a test publish to $NAMESPACE in $ALCOVE_RELAY_METRICS_REGION; check the instance role's permission (aws/provision.md, The instance role)"
  printf 'publish-metrics: published a heartbeat to %s in %s\n' "$NAMESPACE" "$ALCOVE_RELAY_METRICS_REGION" >&2
  exit 0
fi

REGISTRAR_READ=1
if [ ! -f "$COUNTERS_FILE" ]; then
  note "no $COUNTERS_FILE, so the registrar has written no counts; none of its counts are published"
  REGISTRAR_READ=0
fi

# field <text> <name> <pattern> <file> <what the value must be>: the value of
# the one name=value line in a file's text. A missing, repeated or malformed
# line stops the run naming the file and the field, never the value.
field() {
  local text="$1" name="$2" pattern="$3" source="$4" expected="$5" lines value
  lines="$(printf '%s\n' "$text" | grep -c "^$name=" || true)"
  [ "$lines" = 1 ] || die "$source has $lines lines for $name, not 1"
  value="$(printf '%s\n' "$text" | sed -n "s/^$name=//p")"
  [[ "$value" =~ $pattern ]] || die "$source has a $name that is not $expected"
  printf '%s' "$value"
}

# optional_field <text> <name> <pattern>: the value of the one name=value line
# in a file's text, or nothing where that line is missing, repeated or
# malformed. It never stops the run.
optional_field() {
  local text="$1" name="$2" pattern="$3" lines value
  lines="$(printf '%s\n' "$text" | grep -c "^$name=" || true)"
  [ "$lines" = 1 ] || return 0
  value="$(printf '%s\n' "$text" | sed -n "s/^$name=//p")"
  if [[ "$value" =~ $pattern ]]; then printf '%s' "$value"; fi
  return 0
}

STARTED_PATTERN='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
COUNT_PATTERN='^[0-9]{1,18}$'
HEARTBEAT_PATTERN='^([0-9]{4}-[0-9]{2}-[0-9]{2})?$'
TODAY="$(date -u +%F)"

DATA=()
SUMMARY=""
# The UTC day of the last heartbeat published, empty before the first.
HEARTBEAT=""

record() {
  local dir tmp
  dir="$(dirname "$STATE_FILE")"
  mkdir -p "$dir"
  tmp="$(mktemp "$dir/.published.XXXXXX")"
  {
    printf 'started=%s\n' "$STARTED"
    for i in "${!COUNTS[@]}"; do printf '%s=%s\n' "${COUNTS[$i]}" "${NOW[$i]}"; done
    printf 'heartbeat=%s\n' "$HEARTBEAT"
  } > "$tmp"
  mv "$tmp" "$STATE_FILE"
}

if [ "$REGISTRAR_READ" = 1 ]; then
  # One read, so every field comes from the same version of a file the
  # registrar replaces whole.
  CURRENT="$(head -c 4096 "$COUNTERS_FILE")"
  STARTED="$(field "$CURRENT" started "$STARTED_PATTERN" "$COUNTERS_FILE" "a UTC time")"
  # NOW[i] is the count named COUNTS[i]: bash 3.2, the test platform's, has no
  # associative arrays.
  NOW=()
  for name in "${COUNTS[@]}"; do
    NOW+=("$(field "$CURRENT" "$name" "$COUNT_PATTERN" "$COUNTERS_FILE" "a whole number")")
  done

  if [ ! -f "$STATE_FILE" ]; then
    record
    note "recorded the counts since $STARTED; later rises are published"
  else
    LAST="$(head -c 4096 "$STATE_FILE")"
    REMEDY="delete it, and the next run records the counts again"
    LAST_STARTED="$(field "$LAST" started "$STARTED_PATTERN" "$STATE_FILE" "a UTC time; $REMEDY")"
    HEARTBEAT="$(field "$LAST" heartbeat "$HEARTBEAT_PATTERN" "$STATE_FILE" "a UTC date; $REMEDY")"
    for i in "${!COUNTS[@]}"; do
      name="${COUNTS[$i]}"
      last=0
      # A changed start means the registrar restarted and its counts began again at 0.
      if [ "$LAST_STARTED" = "$STARTED" ]; then
        last="$(field "$LAST" "$name" "$COUNT_PATTERN" "$STATE_FILE" "a whole number; $REMEDY")"
      fi
      now="${NOW[$i]}"
      if [ "$((10#$now))" -lt "$((10#$last))" ]; then
        last=0
      fi
      rise=$((10#$now - 10#$last))
      if [ "$rise" -gt 0 ]; then
        DATA+=("MetricName=$name,Value=$rise,Unit=Count")
        SUMMARY="$SUMMARY $name=$rise"
      fi
    done
    if [ "${#DATA[@]}" -eq 0 ] && [ "$LAST_STARTED" != "$STARTED" ]; then
      record
    fi
  fi
fi

# The WebSocket relay's counts, with a record of their own beside the
# registrar's. WEBSOCKET_NOW[i] is the count named WEBSOCKET_COUNTS[i], empty
# where the file lacks it; an empty count in the record is taken afresh.
WEBSOCKET_STARTED=""
WEBSOCKET_NOW=()
WEBSOCKET_RECORD=0

record_websocket() {
  local dir tmp
  dir="$(dirname "$WEBSOCKET_STATE_FILE")"
  mkdir -p "$dir"
  tmp="$(mktemp "$dir/.published-websocket.XXXXXX")"
  {
    printf 'started=%s\n' "$WEBSOCKET_STARTED"
    for i in "${!WEBSOCKET_COUNTS[@]}"; do
      printf '%s=%s\n' "${WEBSOCKET_COUNTS[$i]}" "${WEBSOCKET_NOW[$i]}"
    done
  } > "$tmp"
  mv "$tmp" "$WEBSOCKET_STATE_FILE"
}

if [ -f "$WEBSOCKET_COUNTERS_FILE" ]; then
  WEBSOCKET_READABLE=1
  WEBSOCKET_CURRENT="$(head -c 4096 "$WEBSOCKET_COUNTERS_FILE" 2>/dev/null)" || WEBSOCKET_READABLE=0
  if [ "$WEBSOCKET_READABLE" = 1 ]; then
    WEBSOCKET_STARTED="$(optional_field "$WEBSOCKET_CURRENT" started "$STARTED_PATTERN")"
  fi
  if [ "$WEBSOCKET_READABLE" = 0 ]; then
    note "$WEBSOCKET_COUNTERS_FILE could not be read, so none of its counts are published"
  elif [ -z "$WEBSOCKET_STARTED" ]; then
    note "$WEBSOCKET_COUNTERS_FILE has no single started line holding a UTC time, so none of its counts are published"
  else
    WEBSOCKET_LAST=""
    if [ -f "$WEBSOCKET_STATE_FILE" ]; then
      WEBSOCKET_LAST="$(head -c 4096 "$WEBSOCKET_STATE_FILE")"
    fi
    LAST_WEBSOCKET_STARTED="$(optional_field "$WEBSOCKET_LAST" started "$STARTED_PATTERN")"
    if [ "$LAST_WEBSOCKET_STARTED" != "$WEBSOCKET_STARTED" ]; then
      WEBSOCKET_RECORD=1
    fi
    for name in "${WEBSOCKET_COUNTS[@]}"; do
      now="$(optional_field "$WEBSOCKET_CURRENT" "$name" "$COUNT_PATTERN")"
      WEBSOCKET_NOW+=("$now")
      if [ -z "$now" ]; then
        note "$WEBSOCKET_COUNTERS_FILE has no single $name line holding a whole number, so that count is not published"
        continue
      fi
      # With no record of the relay's counts, they are recorded, not published.
      [ -n "$LAST_WEBSOCKET_STARTED" ] || continue
      last=0
      # A changed start means the relay restarted and its counts began again at 0.
      if [ "$LAST_WEBSOCKET_STARTED" = "$WEBSOCKET_STARTED" ]; then
        last="$(optional_field "$WEBSOCKET_LAST" "$name" "$COUNT_PATTERN")"
        if [ -z "$last" ]; then
          WEBSOCKET_RECORD=1
          continue
        fi
      fi
      if [ "$((10#$now))" -lt "$((10#$last))" ]; then
        last=0
      fi
      rise=$((10#$now - 10#$last))
      if [ "$rise" -gt 0 ]; then
        DATA+=("MetricName=$name,Value=$rise,Unit=Count")
        SUMMARY="$SUMMARY $name=$rise"
      fi
    done
    if [ -z "$LAST_WEBSOCKET_STARTED" ]; then
      note "recorded the WebSocket relay's counts since $WEBSOCKET_STARTED; later rises are published"
    fi
  fi
elif [ -n "${ALCOVE_RELAY_WEBSOCKET_NAME:-}" ]; then
  note "no $WEBSOCKET_COUNTERS_FILE, so the WebSocket relay has written no counts; none of its counts are published"
fi

if [ "$REGISTRAR_READ" = 1 ] && [ "$HEARTBEAT" != "$TODAY" ]; then
  DATA+=("$HEARTBEAT_DATUM")
  SUMMARY="$SUMMARY heartbeat"
fi

if [ "${#DATA[@]}" -eq 0 ]; then
  if [ "$WEBSOCKET_RECORD" = 1 ]; then
    record_websocket
  fi
  exit 0
fi

aws cloudwatch put-metric-data --region "$ALCOVE_RELAY_METRICS_REGION" \
  --namespace "$NAMESPACE" --metric-data "${DATA[@]}" \
  || die "CloudWatch refused or did not answer the publish of$SUMMARY; the next run publishes it again"
if [ "$REGISTRAR_READ" = 1 ]; then
  HEARTBEAT="$TODAY"
  record
fi
if [ -n "$WEBSOCKET_STARTED" ]; then
  record_websocket
fi
note "published$SUMMARY to $NAMESPACE in $ALCOVE_RELAY_METRICS_REGION"
