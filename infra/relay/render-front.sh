#!/bin/bash
# Print front.conf.tmpl with this host's routes written into its maps, for
# install.sh to check and write over /etc/alcove-relay/front.conf.
#
# A route sends one TLS server name to one port on 127.0.0.1: the registrar's
# name (ALCOVE_RELAY_REGISTRAR_NAME) to the registrar's front port
# (ALCOVE_RELAY_REGISTRAR_FRONT_PORT), with the PROXY header naming the
# client, and each name=port pair in ALCOVE_RELAY_FRONT_ROUTES to its port,
# through the front's route hop. Every other connection goes to the front's
# TURN server and on to coturn. A route never names another host, so the front
# reaches nothing but this host's own loopback services.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${ALCOVE_RELAY_ENV_FILE:-/etc/alcove-relay/relay.env}"
TMPL="${ALCOVE_RELAY_FRONT_TEMPLATE:-$HERE/front.conf.tmpl}"

die() { printf 'ABORTING: %s\n' "$*" >&2; exit 1; }
# Not ${1,,}: the tests run this under macOS's bash 3.2, which lacks it.
lowercase() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

[ -f "$ENV_FILE" ] || die "no $ENV_FILE; copy relay.env.example, fill it in, and run install.sh"
# shellcheck disable=SC1090
. "$ENV_FILE"

# nginx's map matches server names whatever their case, so every name is
# compared here in lowercase, without the one trailing dot that makes a DNS
# name absolute.
REALM="${ALCOVE_RELAY_REALM:-}"
REALM="${REALM%.}"
REALM="$(lowercase "$REALM")"
[ -n "$REALM" ] || die "ALCOVE_RELAY_REALM is unset in $ENV_FILE; refusing to guess a realm"

ROUTES=()
ROUTE_HOPS=()
REGISTRAR_ROUTES=()
SEEN=" $REALM "
# Each loopback port a route, the registrar, the front's own servers or coturn
# takes, and what takes it: two services cannot both listen on one. The first
# two are the ports front.conf.tmpl's TURN server and route hop listen on, the
# third coturn's tcp-proxy-port in turnserver.conf.tmpl.
TURN_PORT=5347
HOP_PORT=5348
COTURN_PORT=5350
PORT_NUMBERS=("$TURN_PORT" "$HOP_PORT" "$COTURN_PORT")
PORT_OWNERS=("the front's TURN server" "the front's route hop" "coturn")
claim_port() {
  local name="$1" port="$2" source="$3" i
  for i in ${PORT_NUMBERS[@]+"${!PORT_NUMBERS[@]}"}; do
    [ "${PORT_NUMBERS[$i]}" != "$port" ] \
      || die "$source routes $name to port $port, which ${PORT_OWNERS[$i]} also uses; give each its own port"
  done
  PORT_NUMBERS+=("$port")
  PORT_OWNERS+=("$name")
}
# The fourth argument picks the route: "registrar" for the registrar's, from
# 443 straight to its port, anything else through the route hop.
add_route() {
  local name="${1%.}" port="$2" source="$3" map="${4:-}"
  # Lowercase DNS names only, so a value cannot end the map entry it is
  # written into and one name has one spelling.
  [[ "$name" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] \
    || die "$source names '$name', which is not a lowercase DNS name"
  case "$name" in
    default|include|hostnames|volatile)
      die "$source names '$name', which nginx's map reads as a keyword rather than a server name" ;;
  esac
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
  if [ "$map" = registrar ]; then
    REGISTRAR_ROUTES+=("    $name 127.0.0.1:$port;")
  else
    ROUTE_HOPS+=("    $name 127.0.0.1:$HOP_PORT;")
    ROUTES+=("    $name 127.0.0.1:$port;")
  fi
}

# The registrar listens on its port on every address wherever the host holds
# its token, or has a name, so that port is taken either way; with a name it
# also listens on its front port on loopback.
REGISTRAR_NAME="${ALCOVE_RELAY_REGISTRAR_NAME:-}"
REGISTRAR_NAME="${REGISTRAR_NAME%.}"
REGISTRAR_NAME="$(lowercase "$REGISTRAR_NAME")"
REGISTRAR_PORT="${ALCOVE_RELAY_REGISTRAR_PORT:-8443}"
REGISTRAR_FRONT_PORT="${ALCOVE_RELAY_REGISTRAR_FRONT_PORT:-8445}"
REGISTRAR_TOKEN_FILE="${ALCOVE_RELAY_REGISTRAR_TOKEN_FILE:-/etc/alcove-relay/registrar-token}"
if [ -n "$REGISTRAR_NAME" ] || [ -f "$REGISTRAR_TOKEN_FILE" ]; then
  [[ "$REGISTRAR_PORT" =~ ^[1-9][0-9]{0,4}$ ]] && [ "$REGISTRAR_PORT" -le 65535 ] \
    || die "ALCOVE_RELAY_REGISTRAR_PORT is '$REGISTRAR_PORT', which is not a port number"
  claim_port "the registrar (ALCOVE_RELAY_REGISTRAR_PORT)" "$REGISTRAR_PORT" ALCOVE_RELAY_REGISTRAR_PORT
fi
if [ -n "$REGISTRAR_NAME" ]; then
  [ "$REGISTRAR_FRONT_PORT" != "$REGISTRAR_PORT" ] \
    || die "ALCOVE_RELAY_REGISTRAR_FRONT_PORT is $REGISTRAR_FRONT_PORT, the registrar's own port (ALCOVE_RELAY_REGISTRAR_PORT); give it another"
  add_route "$REGISTRAR_NAME" "$REGISTRAR_FRONT_PORT" ALCOVE_RELAY_REGISTRAR_NAME registrar
fi
read -r -a PAIRS <<< "${ALCOVE_RELAY_FRONT_ROUTES:-}"
for pair in ${PAIRS[@]+"${PAIRS[@]}"}; do
  case "$pair" in
    *=*) add_route "${pair%%=*}" "${pair#*=}" ALCOVE_RELAY_FRONT_ROUTES ;;
    *) die "ALCOVE_RELAY_FRONT_ROUTES holds '$pair'; write each route as name=port" ;;
  esac
done

FOUND=0
FOUND_HOPS=0
FOUND_REGISTRAR=0
while IFS= read -r line || [ -n "$line" ]; do
  if [ "$line" = "    __ROUTES__" ]; then
    FOUND=1
    [ "${#ROUTES[@]}" -eq 0 ] || printf '%s\n' "${ROUTES[@]}"
  elif [ "$line" = "    __ROUTE_HOPS__" ]; then
    FOUND_HOPS=1
    [ "${#ROUTE_HOPS[@]}" -eq 0 ] || printf '%s\n' "${ROUTE_HOPS[@]}"
  elif [ "$line" = "    __REGISTRAR_ROUTE__" ]; then
    FOUND_REGISTRAR=1
    [ "${#REGISTRAR_ROUTES[@]}" -eq 0 ] || printf '%s\n' "${REGISTRAR_ROUTES[@]}"
  else
    printf '%s\n' "$line"
  fi
done < "$TMPL"
[ "$FOUND" = 1 ] || die "$TMPL has no __ROUTES__ line for the routes"
[ "$FOUND_HOPS" = 1 ] || die "$TMPL has no __ROUTE_HOPS__ line for the routes' way to the route hop"
[ "$FOUND_REGISTRAR" = 1 ] || die "$TMPL has no __REGISTRAR_ROUTE__ line for the registrar's route"
