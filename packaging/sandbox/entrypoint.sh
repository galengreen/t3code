#!/bin/sh
# Starts the sandbox's T3 server, and nothing else, so a sandbox answers as
# soon as the server does. Repositories arrive later through t3-sandbox-clone.
#
# Env:
#   T3_SANDBOX_LABEL   the environment's name
#   T3_ENVIRONMENT_ID  environment id chosen by the host, adopted on first start
#   T3_HOST            address the server binds (default: 0.0.0.0)
set -eu

# The server reports PRETTY_HOSTNAME from /etc/machine-info as its name.
if [ -n "${T3_SANDBOX_LABEL:-}" ]; then
  printf 'PRETTY_HOSTNAME="%s"\n' "$(printf '%s' "$T3_SANDBOX_LABEL" | tr -d '"')" \
    | sudo tee /etc/machine-info >/dev/null
fi

# The host records the id so it can match the sandbox to its threads while it
# sleeps. The server keeps whatever id it finds, so only a fresh home is seeded.
if [ -n "${T3_ENVIRONMENT_ID:-}" ] && [ ! -s "$HOME/.t3/userdata/environment-id" ]; then
  mkdir -p "$HOME/.t3/userdata"
  printf '%s\n' "$T3_ENVIRONMENT_ID" > "$HOME/.t3/userdata/environment-id"
fi

# On Fly, the server suspends its own machine when idle through the Machines
# API socket, which only root may use until opened up.
if [ -S /.fly/api ]; then
  sudo chmod a+rw /.fly/api
fi

# A clone does not survive a reboot, so neither does its keep-awake marker.
rm -f "$HOME/.t3/preparing.pid"

mkdir -p "$HOME/work"
cd "$HOME/work"
exec t3 serve --host "${T3_HOST:-0.0.0.0}" --port 7777 --no-browser
