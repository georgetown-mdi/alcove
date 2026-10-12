#!/bin/bash
# Print front.conf.tmpl with this host's routes written into its map, for
# install.sh to check and write over /etc/alcove-relay/front.conf.
#
# A route sends one TLS server name to one port on 127.0.0.1: the registrar's
# name (ALCOVE_RELAY_REGISTRAR_NAME) to the registrar's port, and each
# name=port pair in ALCOVE_RELAY_FRONT_ROUTES to its port. Every other
# connection goes to coturn. A route never names another host, so the front
# reaches nothing but this host's own loopback services.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${ALCOVE_RELAY_ENV_FILE:-/etc/alcove-relay/relay.env}"
TMPL="${ALCOVE_RELAY_FRONT_TEMPLATE:-$HERE/front.conf.tmpl}"

die() { printf 'ABORTING: %s\n' "$*" >&2; exit 1; }

[ -f "$ENV_FILE" ] || die "no $ENV_FILE; copy relay.env.example, fill it in, and run install.sh"
# shellcheck disable=SC1090
. "$ENV_FILE"

REALM="${ALCOVE_RELAY_REALM:-}"
[ -n "$REALM" ] || die "ALCOVE_RELAY_REALM is unset in $ENV_FILE; refusing to guess a realm"

ROUTES=()
SEEN=" $REALM "
# Each loopback port a route or the registrar takes, and what takes it: two
# services cannot both listen on one.
PORT_NUMBERS=()
PORT_OWNERS=()
claim_port() {
  local name="$1" port="$2" source="$3" i
  for i in ${PORT_NUMBERS[@]+"${!PORT_NUMBERS[@]}"}; do
    [ "${PORT_NUMBERS[$i]}" != "$port" ] \
      || die "$source routes $name to port $port, which ${PORT_OWNERS[$i]} also uses; give each its own port"
  done
  PORT_NUMBERS+=("$port")
  PORT_OWNERS+=("$name")
}
add_route() {
  local name="$1" port="$2" source="$3"
  # Lowercase DNS names only, so a value cannot end the map entry it is
  # written into and one name has one spelling.
  [[ "$name" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] \
    || die "$source names '$name', which is not a lowercase DNS name"
  [[ "$port" =~ ^[1-9][0-9]{0,4}$ ]] && [ "$port" -le 65535 ] \
    || die "$source routes $name to '$port', which is not a port number"
  [ "$port" != 443 ] || die "$source routes $name to port 443, the front's own"
  if [ "$name" = "$REALM" ]; then
    die "$source routes the realm $REALM elsewhere; the realm's name is coturn's"
  fi
  case "$SEEN" in
    *" $name "*) die "$source routes $name, which another route already claims" ;;
  esac
  SEEN="$SEEN$name "
  claim_port "$name" "$port" "$source"
  ROUTES+=("    $name 127.0.0.1:$port;")
}

# The registrar listens on its port on every address wherever the host holds
# its token, so that port is taken whether or not the registrar has a name.
REGISTRAR_NAME="${ALCOVE_RELAY_REGISTRAR_NAME:-}"
REGISTRAR_PORT="${ALCOVE_RELAY_REGISTRAR_PORT:-8443}"
REGISTRAR_TOKEN_FILE="${ALCOVE_RELAY_REGISTRAR_TOKEN_FILE:-/etc/alcove-relay/registrar-token}"
if [ -n "$REGISTRAR_NAME" ]; then
  add_route "$REGISTRAR_NAME" "$REGISTRAR_PORT" ALCOVE_RELAY_REGISTRAR_NAME
elif [ -f "$REGISTRAR_TOKEN_FILE" ]; then
  PORT_NUMBERS+=("$REGISTRAR_PORT")
  PORT_OWNERS+=("the registrar (ALCOVE_RELAY_REGISTRAR_PORT)")
fi
read -r -a PAIRS <<< "${ALCOVE_RELAY_FRONT_ROUTES:-}"
for pair in ${PAIRS[@]+"${PAIRS[@]}"}; do
  case "$pair" in
    *=*) add_route "${pair%%=*}" "${pair#*=}" ALCOVE_RELAY_FRONT_ROUTES ;;
    *) die "ALCOVE_RELAY_FRONT_ROUTES holds '$pair'; write each route as name=port" ;;
  esac
done

FOUND=0
while IFS= read -r line || [ -n "$line" ]; do
  if [ "$line" = "    __ROUTES__" ]; then
    FOUND=1
    [ "${#ROUTES[@]}" -eq 0 ] || printf '%s\n' "${ROUTES[@]}"
  else
    printf '%s\n' "$line"
  fi
done < "$TMPL"
[ "$FOUND" = 1 ] || die "$TMPL has no __ROUTES__ line for the routes"
