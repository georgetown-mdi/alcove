#!/bin/bash
# Print nginx.conf.tmpl with the broker's name substituted, for install.sh to
# compare against and write over /etc/alcove-broker/nginx.conf.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${ALCOVE_BROKER_ENV_FILE:-/etc/alcove-broker/broker.env}"
TMPL="${ALCOVE_BROKER_TEMPLATE:-$HERE/nginx.conf.tmpl}"

die() { printf 'ABORTING: %s\n' "$*" >&2; exit 1; }

[ -f "$ENV_FILE" ] || die "no $ENV_FILE; copy broker.env.example there and set ALCOVE_BROKER_NAME"
# shellcheck disable=SC1090
. "$ENV_FILE"
NAME="${ALCOVE_BROKER_NAME:-}"
[ -n "$NAME" ] || die "ALCOVE_BROKER_NAME is unset in $ENV_FILE; refusing to guess a name"
# A DNS name only, so the value cannot end the directive it is written into.
[[ "$NAME" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] \
  || die "ALCOVE_BROKER_NAME in $ENV_FILE is not a DNS name"

sed "s/__ALCOVE_BROKER_NAME__/$NAME/g" "$TMPL"
