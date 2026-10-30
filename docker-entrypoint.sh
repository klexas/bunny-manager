#!/bin/sh
# Hosts like ZimaOS/CasaOS start containers as root with root-owned bind mounts.
# Fix ownership of /data, then drop privileges to PUID:PGID (default 1000:1000).
set -e

mkdir -p /data/workspace

if [ "$(id -u)" = "0" ]; then
  PUID="${PUID:-1000}"
  PGID="${PGID:-1000}"
  chown -R "$PUID:$PGID" /data 2>/dev/null || echo "warning: could not chown /data" >&2
  exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups -- "$@"
fi

exec "$@"
