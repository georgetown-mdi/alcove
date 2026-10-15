#!/bin/bash
# Install the Alcove standing relay on this host. Idempotent: run it again after
# an edit to the template, the unit, or the Dockerfile and it converges.
#
#   install.sh [--skip-verify]
#
# What it does, in order: adds /swapfile where it is not set up, installs
# a container runtime, builds the 443 front's image and checks its
# configuration with nginx -t, builds the relay's image,
# creates the data directory that holds the per-exchange secrets table, installs
# the scripts under /opt, obtains a certificate if none is present, renders
# coturn's configuration, installs the units and the three timers, on Amazon
# Linux 2023 the OS update timer too, and starts the relay, the front,
# and the registrar where the host holds its token. It then runs verify.sh,
# which is the only step that says whether the result carries an exchange.
#
# The runtime is podman where the distribution carries it and docker where it
# does not, and that decides one thing: which file defines alcove-relay.service.
# Everything else -- the image, its flags and mounts, the uid probe, the
# certificate hook, the timers, the registrar -- is the same on either.
#
# It refuses to run without /etc/alcove-relay/relay.env, which names the realm.
# Nothing here defaults to a hostname: a realm that does not match what
# mint-credential.sh signs against fails every credential, quietly, at the point
# an exchange needs the relay.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# Both paths are literals here and in the unit files, which cannot read a
# variable this script was given: a configurable root would move the scripts and
# leave the units pointing at the old one, splitting the install in half.
ETC=/etc/alcove-relay
LIBEXEC=/opt/alcove-relay
ENV_FILE="${ALCOVE_RELAY_ENV_FILE:-$ETC/relay.env}"
IMAGE="${ALCOVE_RELAY_IMAGE:-localhost/alcove-relay:installed}"
QUADLET_DIR=/etc/containers/systemd
UNIT_DIR=/etc/systemd/system

SKIP_VERIFY=0
for arg in "$@"; do
  case "$arg" in
    --skip-verify) SKIP_VERIFY=1 ;;
    *) printf 'usage: install.sh [--skip-verify]\n' >&2; exit 2 ;;
  esac
done

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
die() { printf '[%s] ABORTING: %s\n' "$(date -u +%FT%TZ)" "$*" >&2; exit 1; }

# Write a value this script derived back into the env file the other scripts and
# the timers read. A hand-edited file need not end in a newline, and an append
# onto one would land on the end of whatever the operator typed last. Both values
# written this way come from a fixed alphabet -- a uid's digits, a runtime name
# out of a two-value case -- so neither carries a character the sed reads as
# syntax.
record_env_value() {
  if grep -q "^$1=" "$ENV_FILE"; then
    sed -i "s/^$1=.*/$1=$2/" "$ENV_FILE"
  else
    if [ -s "$ENV_FILE" ] && [ -n "$(tail -c 1 "$ENV_FILE")" ]; then
      printf '\n' >> "$ENV_FILE"
    fi
    printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"
  fi
}

[ "$(id -u)" = 0 ] || die "install.sh writes under /etc and /opt; run it as root"

[ -f "$ENV_FILE" ] || die "no $ENV_FILE. Copy relay.env.example there, set the realm, and run again"
# shellcheck disable=SC1090
. "$ENV_FILE"
[ -n "${ALCOVE_RELAY_REALM:-}" ] || die "ALCOVE_RELAY_REALM is unset in $ENV_FILE; refusing to guess a realm"
log "installing the relay for realm $ALCOVE_RELAY_REALM"

# Checked here rather than at the certificate step, which is past the package
# install and the image build: a missing provider credential is the one failure
# this script can see coming.
if [ ! -s "$ETC/certs/fullchain.pem" ] && [ ! -f "${ALCOVE_RELAY_ACME_ENV:-$ETC/acme.env}" ]; then
  die "no certificate and no ${ALCOVE_RELAY_ACME_ENV:-$ETC/acme.env}. Copy certs/env.example there at mode 600 and fill in the DNS provider credential"
fi
"$HERE/render-front.sh" > /dev/null \
  || die "the front's routes in $ENV_FILE are refused (above); nothing was installed or restarted"

# --- the swapfile -------------------------------------------------------------
# Disk swap below the distribution's own (zram on Amazon Linux 2023, at priority
# 100, fills first), added before this script's dnf and image builds and the OS
# update timer: on a 412 MB instance dnf without it ran out of memory and the
# OOM killer took the relay and the broker. vm.swappiness is left as found.
# A measured working choice: 1024 MB peaked at 328 MB used on a 412 MB t4g.nano.
SWAPFILE_SMALL_MB=1024
SWAPFILE_LARGE_MB=2048
# Each leaves at least 1.5 GB of / free for dnf's downloads.
SWAPFILE_SMALL_MIN_FREE_MB=2560
SWAPFILE_LARGE_MIN_FREE_MB=4096
# A hand-edited fstab need not end in a newline, and an append onto one would
# land on the end of whatever the operator typed last.
add_swapfile_to_fstab() {
  if [ -s /etc/fstab ] && [ -n "$(tail -c 1 /etc/fstab)" ]; then
    printf '\n' >> /etc/fstab
  fi
  printf '/swapfile none swap defaults,pri=10 0 0\n' >> /etc/fstab
  log "swap: added /swapfile to /etc/fstab: $1"
}
if [ -e /swapfile ] || grep -qs '^/swapfile[[:space:]]' /etc/fstab; then
  SWAPFILE_LINE="$(swapon --show=NAME,TYPE,SIZE,USED,PRIO --noheadings 2>/dev/null | awk '$1 == "/swapfile"' || true)"
  if [ -n "$SWAPFILE_LINE" ]; then
    if grep -qs '^/swapfile[[:space:]]' /etc/fstab; then
      log "swap: keeping /swapfile: $SWAPFILE_LINE"
    else
      add_swapfile_to_fstab "$SWAPFILE_LINE"
    fi
  else
    log "WARNING: /swapfile exists or /etc/fstab names it, but it is not in use as swap; check it with swapon --show and /etc/fstab"
  fi
else
  ROOT_FREE_MB="$(df -BM --output=avail / | tail -1 | tr -dc 0-9 || true)"
  SWAPFILE_MB=
  if [ -z "$ROOT_FREE_MB" ]; then
    log "WARNING: could not read the free space on /, so no swapfile was added; on a host with under 1 GB of memory the daily OS update can run out of memory. Check df / and run install.sh again"
  elif [ "$ROOT_FREE_MB" -ge "$SWAPFILE_LARGE_MIN_FREE_MB" ]; then
    SWAPFILE_MB=$SWAPFILE_LARGE_MB
  elif [ "$ROOT_FREE_MB" -ge "$SWAPFILE_SMALL_MIN_FREE_MB" ]; then
    SWAPFILE_MB=$SWAPFILE_SMALL_MB
  else
    log "WARNING: / has ${ROOT_FREE_MB} MB free, under the ${SWAPFILE_SMALL_MIN_FREE_MB} MB a ${SWAPFILE_SMALL_MB} MB swapfile needs, so none was added; on a host with under 1 GB of memory the daily OS update can run out of memory. Free space on / and run install.sh again"
  fi
  if [ -n "$SWAPFILE_MB" ]; then
    log "adding a ${SWAPFILE_MB} MB swapfile at /swapfile (${ROOT_FREE_MB} MB free on /)"
    SWAPFILE_STATUS=0
    if fallocate -l "${SWAPFILE_MB}M" /swapfile && chmod 600 /swapfile && mkswap /swapfile > /dev/null; then
      if ! swapon -p 10 /swapfile; then
        # Some filesystems refuse a swapfile with unwritten extents.
        log "swapon refused the fallocated file; writing it out with dd instead"
        rm -f /swapfile
        { dd if=/dev/zero of=/swapfile bs=1M count="$SWAPFILE_MB" oflag=direct status=none \
            && chmod 600 /swapfile && mkswap /swapfile > /dev/null && swapon -p 10 /swapfile; } \
          || SWAPFILE_STATUS=$?
      fi
    else
      SWAPFILE_STATUS=1
    fi
    if [ "$SWAPFILE_STATUS" = 0 ]; then
      add_swapfile_to_fstab "$(swapon --show=NAME,TYPE,SIZE,USED,PRIO --noheadings | awk '$1 == "/swapfile"')"
    else
      rm -f /swapfile
      log "WARNING: /swapfile could not be made swap (above), so none was added; on a host with under 1 GB of memory the daily OS update can run out of memory. Fix the cause above, or add swap by hand, and run install.sh again"
    fi
  fi
fi

# --- the container runtime --------------------------------------------------
# podman where the distribution carries it, docker where it does not. Measured on
# the Amazon Linux 2023 arm64 AMI aws/provision.md prescribes: `dnf install
# podman` fails with no match there -- AL2023 publishes no podman package and no
# EPEL -- while `dnf install docker` installs Docker Engine.
#
# A runtime already on the host wins over one dnf could add, so a converge run
# never moves a running relay from one supervisor to the other. The value this
# script records in the env file is read back on the next run and pins it.
RUNTIME="${ALCOVE_RELAY_RUNTIME:-}"
if [ -z "$RUNTIME" ]; then
  if command -v podman >/dev/null 2>&1; then
    RUNTIME=podman
  elif command -v docker >/dev/null 2>&1; then
    RUNTIME=docker
  else
    log "no container runtime on this host; asking dnf for podman"
    if dnf -y install podman; then
      RUNTIME=podman
    else
      log "dnf has no podman on this distribution; installing docker instead"
      dnf -y install docker \
        || die "this host has neither podman nor docker and dnf could install neither; install one by hand and run again, or set ALCOVE_RELAY_RUNTIME in $ENV_FILE"
      RUNTIME=docker
    fi
  fi
fi
case "$RUNTIME" in
  podman|docker) ;;
  *) die "ALCOVE_RELAY_RUNTIME is '$RUNTIME'; this reference drives podman or docker" ;;
esac
command -v "$RUNTIME" >/dev/null 2>&1 || die "the runtime is $RUNTIME, which is not on PATH"
log "container runtime: $RUNTIME"
# verify.sh runs the same image on the same runtime, from a timer that does no
# detection of its own.
record_env_value ALCOVE_RELAY_RUNTIME "$RUNTIME"

if [ "$RUNTIME" = docker ]; then
  # podman needs no daemon. docker's has to be up for the build below, and
  # alcove-relay-docker.service requires it besides.
  systemctl enable --now docker.service \
    || die "docker.service did not enable and start, so nothing can build or run the relay image; journalctl -u docker.service"
  # systemd takes an absolute path in ExecStart, and alcove-relay-docker.service
  # carries the path the distribution package uses. Caught here rather than at
  # the first start, which reports it as a unit that cannot locate an executable.
  DOCKER_BIN="$(command -v docker)"
  [ "$DOCKER_BIN" = /usr/bin/docker ] \
    || die "docker is at $DOCKER_BIN and alcove-relay-docker.service names /usr/bin/docker; point its ExecStart lines at $DOCKER_BIN and run again"
fi

# --- the 443 front ------------------------------------------------------------
# Built and checked by nginx -t before anything coturn runs from changes: the
# turnserver.conf rendered below moves coturn onto loopback, so a front that
# fails after it would leave nothing on 443 at coturn's next restart. A failure
# here leaves the scripts in $LIBEXEC, turnserver.conf, the units and the
# running services as they were.
FRONT_IMAGE=localhost/alcove-relay-front:installed
log "building $FRONT_IMAGE from the pinned base in $HERE/front/Dockerfile"
case "$RUNTIME" in
  podman) podman build --pull=newer -t "$FRONT_IMAGE" "$HERE/front" ;;
  docker) docker build --pull -t "$FRONT_IMAGE" "$HERE/front" ;;
esac \
  || die "the front's image did not build; nothing coturn runs from was changed. Fix the cause above and run again"
install -d -m 700 "$ETC"
FRONT_CONF="$ETC/front.conf"
FRONT_CANDIDATE="$(mktemp "$FRONT_CONF.XXXXXX")"
trap 'rm -f "$FRONT_CANDIDATE"' EXIT
"$HERE/render-front.sh" > "$FRONT_CANDIDATE" \
  || die "the front's routes in $ENV_FILE are refused (above); nothing coturn runs from was changed"
chmod 644 "$FRONT_CANDIDATE"
"$RUNTIME" run --rm --network host --read-only --tmpfs /tmp \
  -v "$FRONT_CANDIDATE:/etc/nginx/nginx.conf:ro" \
  --entrypoint nginx "$FRONT_IMAGE" -t \
  || die "the rendered front configuration fails nginx -t; $FRONT_CONF, coturn's configuration and the running services are unchanged. Fix front.conf.tmpl or the routes in $ENV_FILE and run again"
mv "$FRONT_CANDIDATE" "$FRONT_CONF"
trap - EXIT

command -v openssl >/dev/null 2>&1 || dnf -y install openssl
command -v curl >/dev/null 2>&1 || dnf -y install curl

# --- python3 ------------------------------------------------------------------
# relay_table.py, which every key script, the sweep, and the registrar write the
# secrets table through, runs on the distribution's python3 and its sqlite3
# module; Amazon Linux 2023 ships both.
command -v python3 >/dev/null 2>&1 || dnf -y install python3
[ -x /usr/bin/python3 ] \
  || die "the sweep and registrar units run /usr/bin/python3, which this host does not have; install python3 3.9 or later there and run again"
/usr/bin/python3 -c 'import sqlite3' \
  || die "/usr/bin/python3 has no sqlite3 module, which relay_table.py writes the secrets table with; install the distribution's python3 with its standard library and run again"

# --- the registrar ------------------------------------------------------------
# Optional: a host holding the relay-owner token runs the registrar (README.md,
# The registrar).
REGISTRAR_TOKEN_FILE="$ETC/registrar-token"
REGISTRAR=0
if [ -f "$REGISTRAR_TOKEN_FILE" ]; then
  REGISTRAR=1
  chmod 600 "$REGISTRAR_TOKEN_FILE"
fi

# --- the static secret ------------------------------------------------------
# Optional, and never minted here: a host that holds one keeps it, beside the
# per-exchange secrets table, until the operator deletes it (README.md,
# Per-exchange keys).
SECRET_FILE="${ALCOVE_RELAY_SECRET_FILE:-$ETC/static-auth-secret}"
install -d -m 755 "$ETC/certs"
if [ -f "$SECRET_FILE" ]; then
  log "keeping the static authentication secret at $SECRET_FILE"
  chmod 600 "$SECRET_FILE"
fi

# --- the image --------------------------------------------------------------
log "building $IMAGE from the pinned base in $HERE/Dockerfile"
# The one runtime invocation whose spelling differs: podman takes --pull=newer,
# while docker's --pull is a boolean that rejects that value before it reaches
# the daemon (measured against the docker CLI: exit 125, `invalid argument
# "newer" for "--pull" flag`).
case "$RUNTIME" in
  podman) podman build --pull=newer -t "$IMAGE" "$HERE" ;;
  docker) docker build --pull -t "$IMAGE" "$HERE" ;;
esac

# The account the image runs as, asked of the image rather than assumed: the ACME
# deploy hook has to hand it a readable private key, and the measurement record
# has coturn falling back to its defaults on a key it cannot read
# (docs/notes/webrtc-relay-deployment.md).
IMAGE_UID="$("$RUNTIME" run --rm --entrypoint id "$IMAGE" -u | tr -d '[:space:]')"
case "$IMAGE_UID" in
  ''|*[!0-9]*) die "could not read the image's uid; got '$IMAGE_UID'" ;;
esac
IMAGE_GID="$("$RUNTIME" run --rm --entrypoint id "$IMAGE" -g | tr -d '[:space:]')"
case "$IMAGE_GID" in
  ''|*[!0-9]*) die "could not read the image's gid; got '$IMAGE_GID'" ;;
esac
log "the image runs as uid $IMAGE_UID, gid $IMAGE_GID"
record_env_value ALCOVE_RELAY_IMAGE_UID "$IMAGE_UID"
record_env_value ALCOVE_RELAY_IMAGE_GID "$IMAGE_GID"

# --- the secrets table ------------------------------------------------------
# coturn creates the table's SQLite file at its first start and reads it as the
# image's account. relay_table.py writes it as that same account -- the sweep
# and registrar units run as it, and a key script run as root drops to it -- not
# as another account in the image's group: SQLite's writer creates its journal
# beside the file, and coturn, reading, must be able to roll back a journal a
# failed write left, so the file, its journal, and the directory would all need
# group write, which coturn does not give the file it creates. So the directory
# is that account's alone, and the units run as its uid and gid.
install -d -m 700 -o "$IMAGE_UID" -g "$IMAGE_GID" /var/lib/alcove-relay

# --- the scripts this host runs ---------------------------------------------
install -d -m 755 "$LIBEXEC" "$LIBEXEC/aws" "$LIBEXEC/certs"
install -m 755 "$HERE/render-config.sh" "$HERE/verify.sh" "$HERE/mint-credential.sh" \
  "$HERE/register-exchange.sh" "$HERE/revoke-exchange.sh" "$HERE/sweep-exchanges.sh" \
  "$HERE/import-legacy-mapping.sh" "$HERE/registrar.py" "$HERE/render-front.sh" "$LIBEXEC/"
install -m 644 "$HERE/turnserver.conf.tmpl" "$HERE/front.conf.tmpl" "$HERE/exchange-keys.sh" \
  "$HERE/relay_table.py" "$LIBEXEC/"
install -m 755 "$HERE/aws/external-ip.sh" "$LIBEXEC/aws/"
install -m 755 "$HERE/certs/renew.sh" "$HERE/certs/deploy-hook.sh" "$LIBEXEC/certs/"

# --- the certificate --------------------------------------------------------
if [ ! -s "$ETC/certs/fullchain.pem" ] || [ ! -s "$ETC/certs/privkey.pem" ]; then
  log "no certificate yet; obtaining one by DNS-01"
  "$LIBEXEC/certs/renew.sh" || die "certificate issuance failed; see Certificates in infra/relay/README.md"
else
  # A re-run with a certificate already here skips renew.sh, and the deploy hook
  # with it, so nothing else re-owns the key to the uid probed above. A rebuilt
  # image that moved that uid would hand coturn a key it cannot read, which it
  # answers by falling back to its defaults rather than failing
  # (docs/notes/webrtc-relay-deployment.md): the relay starts, and the first
  # symptom is a party that cannot gather a relay candidate.
  log "certificate already present; re-owning it to uid $IMAGE_UID"
  chown "$IMAGE_UID" "$ETC/certs" "$ETC/certs/fullchain.pem" "$ETC/certs/privkey.pem" \
    || die "could not give uid $IMAGE_UID the certificate in $ETC/certs; coturn would start on defaults rather than fail"
fi

# --- the configuration ------------------------------------------------------
"$LIBEXEC/render-config.sh"

# --- units ------------------------------------------------------------------
# One service name whichever runtime this is: certs/deploy-hook.sh restarts
# alcove-relay.service by name and alcove-relay-verify.service requires it, so
# only the file that defines it differs.
for service in alcove-relay alcove-relay-front; do
  if [ "$RUNTIME" = podman ]; then
    install -d -m 755 "$QUADLET_DIR"
    install -m 644 "$HERE/$service.container" "$QUADLET_DIR/"
    STALE_UNIT="$UNIT_DIR/$service.service"
  else
    install -m 644 "$HERE/$service-docker.service" "$UNIT_DIR/$service.service"
    STALE_UNIT="$QUADLET_DIR/$service.container"
  fi
  # A unit left by an install on the other runtime would supervise a second
  # container on the same ports, and a plain unit of this name shadows the
  # Quadlet generator's output besides.
  if [ -e "$STALE_UNIT" ]; then
    log "removing $STALE_UNIT, left by an install on the other runtime"
    systemctl stop "$service.service" || true
    # A plain unit (the docker shape) was `systemctl enable`d at install time
    # and so left a multi-user.target.wants symlink; a Quadlet unit (the podman
    # shape) is generator-provided and was never enabled this way, so disabling
    # it fails with nothing to disable. Tolerated the same way either shape
    # answers, so a docker-to-podman switch does not leave that symlink
    # dangling.
    systemctl disable "$service.service" 2>/dev/null || true
    rm -f "$STALE_UNIT"
  fi
done
# The daily units take their lock inside /run/alcove-maintenance, which only
# root can enter; the directory must exist before any of them runs.
install -d -m 755 /etc/tmpfiles.d
install -m 644 "$HERE/../tmpfiles.d/alcove-maintenance.conf" /etc/tmpfiles.d/alcove-maintenance.conf
systemd-tmpfiles --create /etc/tmpfiles.d/alcove-maintenance.conf \
  || die "systemd-tmpfiles could not create /run/alcove-maintenance, the directory the daily units take their lock in; run systemd-tmpfiles --create /etc/tmpfiles.d/alcove-maintenance.conf to see why"
install -m 644 "$HERE/certs/alcove-relay-cert.service" "$HERE/certs/alcove-relay-cert.timer" "$UNIT_DIR/"
install -m 644 "$HERE/alcove-relay-verify.service" "$HERE/alcove-relay-verify.timer" "$UNIT_DIR/"
install -m 644 "$HERE/alcove-relay-sweep.timer" "$UNIT_DIR/"
# The update unit passes --releasever=latest, a release name Amazon Linux 2023's
# versioned repositories define, so it is installed only there; elsewhere the
# distribution's own automatic updates are the operator's to set up.
OS_UPDATES=0
if [ -r /etc/os-release ] && (. /etc/os-release && [ "${ID:-}" = amzn ] && [ "${VERSION_ID:-}" = 2023 ]); then
  OS_UPDATES=1
  install -m 644 "$HERE/alcove-relay-os-update.service" "$HERE/alcove-relay-os-update.timer" "$UNIT_DIR/"
fi
# The two units that run as the image's account, with its uid and gid filled in.
for unit in alcove-relay-sweep.service alcove-relay-registrar.service; do
  sed -e "s/__ALCOVE_RELAY_IMAGE_UID__/$IMAGE_UID/g" -e "s/__ALCOVE_RELAY_IMAGE_GID__/$IMAGE_GID/g" \
    "$HERE/$unit" > "$UNIT_DIR/$unit.tmp"
  chmod 644 "$UNIT_DIR/$unit.tmp"
  mv "$UNIT_DIR/$unit.tmp" "$UNIT_DIR/$unit"
done

JOURNALD_DROPIN=/etc/systemd/journald.conf.d/alcove-relay.conf
JOURNALD_CHANGED=0
if ! cmp -s "$HERE/journald-alcove-relay.conf" "$JOURNALD_DROPIN"; then
  install -d -m 755 /etc/systemd/journald.conf.d
  install -m 644 "$HERE/journald-alcove-relay.conf" "$JOURNALD_DROPIN"
  JOURNALD_CHANGED=1
fi

systemctl daemon-reload || die "systemctl daemon-reload failed, so systemd has not read the relay's unit; check systemd-analyze verify and run again"
if [ "$JOURNALD_CHANGED" = 1 ]; then
  log "restarting systemd-journald to apply $JOURNALD_DROPIN"
  systemctl restart systemd-journald.service \
    || die "systemd-journald did not restart, so the journal retention in $JOURNALD_DROPIN is not in effect; see journalctl -u systemd-journald.service, then run systemctl restart systemd-journald.service"
fi
systemctl enable --now alcove-relay-cert.timer \
  || die "alcove-relay-cert.timer did not start; the certificate would expire unrenewed. journalctl -u alcove-relay-cert.timer"
systemctl enable --now alcove-relay-verify.timer \
  || die "alcove-relay-verify.timer did not start; nothing would notice a relay that stopped allocating. journalctl -u alcove-relay-verify.timer"
systemctl enable --now alcove-relay-sweep.timer \
  || die "alcove-relay-sweep.timer did not start; lapsed exchange keys would stay registered. journalctl -u alcove-relay-sweep.timer"

if [ "$OS_UPDATES" = 1 ]; then
  systemctl enable --now alcove-relay-os-update.timer \
    || die "alcove-relay-os-update.timer did not start; this host would take no OS updates. journalctl -u alcove-relay-os-update.timer"
  log "OS updates install daily at 08:30 UTC; see The daily schedule in infra/relay/README.md"
else
  systemctl disable --now alcove-relay-os-update.timer 2>/dev/null || true
  log "WARNING: not Amazon Linux 2023, so no automatic OS updates are set up; configure the distribution's own"
fi

if [ "$RUNTIME" = docker ]; then
  # A Quadlet-generated service is enabled by the unit's own [Install] section at
  # generation time. A plain unit file is not enabled by being installed, and a
  # host that rebooted without this would come up with no relay.
  systemctl enable alcove-relay.service alcove-relay-front.service \
    || die "alcove-relay.service and alcove-relay-front.service could not be enabled; the relay would not come back after a reboot"
fi
# coturn first: on a host where an earlier install had coturn on 443, its
# restart onto loopback frees the port the front then binds.
systemctl restart alcove-relay.service \
  || die "alcove-relay.service did not start; journalctl -u alcove-relay.service carries coturn's own output"
log "alcove-relay.service started"
systemctl restart alcove-relay-front.service \
  || die "alcove-relay-front.service did not start, so nothing answers on 443; journalctl -u alcove-relay-front.service, and ss -ltnp 'sport = :443' for another listener on the port"
log "alcove-relay-front.service started on 443"

# An install from before the mapping moved into the secrets table kept it as a
# text file under /etc, holding every key in plaintext; its exchanges are
# carried into the table once coturn has created it, and the file is deleted
# once the table, read back, accounts for every row.
if [ -f "$ETC/exchange-keys" ] || [ -f "$ETC/exchange-keys.imported" ]; then
  for _ in $(seq 30); do
    [ -f /var/lib/alcove-relay/turndb ] && break
    sleep 1
  done
  LEGACY_STATUS=0
  "$LIBEXEC/import-legacy-mapping.sh" < /dev/null || LEGACY_STATUS=$?
  case "$LEGACY_STATUS" in
    0) log "the secrets table accounts for every row of the legacy mapping, and the mapping is deleted" ;;
    4) log "WARNING: the legacy mapping under $ETC is kept, holding keys in plaintext, until the table accounts for it; see the message above" ;;
    *) die "the legacy mapping under $ETC could not be carried into the secrets table and is kept unchanged; an exchange it names cannot be revoked by id until it is. Fix the cause above and run install.sh again" ;;
  esac
fi

if [ "$REGISTRAR" = 1 ]; then
  systemctl enable alcove-relay-registrar.service \
    || die "alcove-relay-registrar.service could not be enabled; the registrar would not come back after a reboot"
  systemctl restart alcove-relay-registrar.service \
    || die "alcove-relay-registrar.service did not start; journalctl -u alcove-relay-registrar.service"
  if [ -n "${ALCOVE_RELAY_REGISTRAR_NAME:-}" ]; then
    log "alcove-relay-registrar.service started on port ${ALCOVE_RELAY_REGISTRAR_PORT:-8443}, and on 443 as $ALCOVE_RELAY_REGISTRAR_NAME through the front"
  else
    log "alcove-relay-registrar.service started on port ${ALCOVE_RELAY_REGISTRAR_PORT:-8443}; set ALCOVE_RELAY_REGISTRAR_NAME to reach it on 443"
  fi
else
  systemctl disable --now alcove-relay-registrar.service 2>/dev/null || true
  log "no $REGISTRAR_TOKEN_FILE, so the registrar is not running"
fi

if [ "$SKIP_VERIFY" = 1 ]; then
  log "--skip-verify: nothing has confirmed this relay carries an allocation"
  exit 0
fi

log "verifying"
# EC2 does not hairpin an instance's traffic back to its own Elastic IP:
# verify.sh's TCP probes get connection-refused when run on the relay box
# against the public name, even while the relay serves correctly to everyone
# else. Measured on the relay instance 2026-09-03. render-config.sh already
# derived this host's private address from ALCOVE_RELAY_EXTERNAL_IP_HELPER to
# render relay-ip=; read it back from there rather than asking the helper
# again. The front listens on every address, so the probes reach it there.
CONF="${ALCOVE_RELAY_CONF:-$ETC/turnserver.conf}"
PRIVATE_IP="$(sed -n 's/^relay-ip=//p' "$CONF" | head -1)"
[ -n "$PRIVATE_IP" ] || die "could not read relay-ip from $CONF; render-config.sh should have written it"
ALCOVE_RELAY_VERIFY_CONNECT="$PRIVATE_IP" "$LIBEXEC/verify.sh"
