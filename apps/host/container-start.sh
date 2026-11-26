#!/bin/sh
set -eu
# Windows ACL-private binds can appear as mode 0777 inside the container.
source=/run/along-identity-keyring-source.json
if [ -f "$source" ]; then
  umask 077
  cp "$source" /run/along-identity-keyring.json
  chmod 600 /run/along-identity-keyring.json
fi
exec /app/host/bin/along-host "$@"
