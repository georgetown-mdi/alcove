#!/bin/bash
# Publish the registrar's counts to CloudWatch, for the relay's alarms
# (README.md, Monitoring).
#
#   publish-metrics.sh [--heartbeat]
#
# The registrar writes each count since its start to the counters file
# (README.md, The registrar, What it counts). A run publishes how much each
# count rose since the last publish, under the namespace Alcove/Relay in
# ALCOVE_RELAY_METRICS_REGION, then records the counts it published. A count
# that did not rise is not published. The first run records the counts and
# publishes none, so counts from before the install do not land in one sum.
# A failed publish records nothing, so the next run publishes the same rise.
#
# The first run of each UTC day that reads the counts also publishes one
# heartbeat datapoint, in the same aws call as any rise; another run where no
# count rose starts no aws process. --heartbeat publishes one heartbeat and
# nothing else, recording nothing: install.sh's test publish.
set -euo pipefail

ENV_FILE="${ALCOVE_RELAY_ENV_FILE:-/etc/alcove-relay/relay.env}"
COUNTERS_FILE="${ALCOVE_RELAY_COUNTERS_FILE:-/var/lib/alcove-relay/registrar-counters}"
STATE_FILE="${ALCOVE_RELAY_METRICS_STATE_FILE:-/var/lib/alcove-relay-metrics/published}"
# The instance role's PutMetricData permission names this namespace
# (aws/provision.md, The instance role).
NAMESPACE=Alcove/Relay
COUNTS=(tokenless_enrollments rate_limit_refusals client_cap_refusals tokenless_ceiling_refusals)
HEARTBEAT_DATUM="MetricName=publisher_heartbeat,Value=1,Unit=Count"

die() { printf 'publish-metrics: %s\n' "$*" >&2; exit 1; }

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

if [ ! -f "$COUNTERS_FILE" ]; then
  printf 'publish-metrics: no %s, so the registrar has written no counts; nothing to publish\n' "$COUNTERS_FILE" >&2
  exit 0
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

STARTED_PATTERN='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
COUNT_PATTERN='^[0-9]{1,18}$'
HEARTBEAT_PATTERN='^([0-9]{4}-[0-9]{2}-[0-9]{2})?$'
TODAY="$(date -u +%F)"

# One read, so every field comes from the same version of a file the registrar
# replaces whole.
CURRENT="$(head -c 4096 "$COUNTERS_FILE")"
STARTED="$(field "$CURRENT" started "$STARTED_PATTERN" "$COUNTERS_FILE" "a UTC time")"
declare -A NOW
for name in "${COUNTS[@]}"; do
  NOW[$name]="$(field "$CURRENT" "$name" "$COUNT_PATTERN" "$COUNTERS_FILE" "a whole number")"
done

# The UTC day of the last heartbeat published, empty before the first.
HEARTBEAT=""

record() {
  local dir tmp
  dir="$(dirname "$STATE_FILE")"
  mkdir -p "$dir"
  tmp="$(mktemp "$dir/.published.XXXXXX")"
  {
    printf 'started=%s\n' "$STARTED"
    for name in "${COUNTS[@]}"; do printf '%s=%s\n' "$name" "${NOW[$name]}"; done
    printf 'heartbeat=%s\n' "$HEARTBEAT"
  } > "$tmp"
  mv "$tmp" "$STATE_FILE"
}

DATA=()
SUMMARY=""
if [ ! -f "$STATE_FILE" ]; then
  record
  printf 'publish-metrics: recorded the counts since %s; later rises are published\n' "$STARTED" >&2
else
  LAST="$(head -c 4096 "$STATE_FILE")"
  REMEDY="delete it, and the next run records the counts again"
  LAST_STARTED="$(field "$LAST" started "$STARTED_PATTERN" "$STATE_FILE" "a UTC time; $REMEDY")"
  HEARTBEAT="$(field "$LAST" heartbeat "$HEARTBEAT_PATTERN" "$STATE_FILE" "a UTC date; $REMEDY")"
  for name in "${COUNTS[@]}"; do
    last=0
    # A changed start means the registrar restarted and its counts began again at 0.
    if [ "$LAST_STARTED" = "$STARTED" ]; then
      last="$(field "$LAST" "$name" "$COUNT_PATTERN" "$STATE_FILE" "a whole number; $REMEDY")"
    fi
    now="${NOW[$name]}"
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

if [ "$HEARTBEAT" != "$TODAY" ]; then
  DATA+=("$HEARTBEAT_DATUM")
  SUMMARY="$SUMMARY heartbeat"
fi

if [ "${#DATA[@]}" -eq 0 ]; then
  exit 0
fi

aws cloudwatch put-metric-data --region "$ALCOVE_RELAY_METRICS_REGION" \
  --namespace "$NAMESPACE" --metric-data "${DATA[@]}" \
  || die "CloudWatch refused or did not answer the publish of$SUMMARY; the next run publishes it again"
HEARTBEAT="$TODAY"
record
printf 'publish-metrics: published%s to %s in %s\n' "$SUMMARY" "$NAMESPACE" "$ALCOVE_RELAY_METRICS_REGION" >&2
