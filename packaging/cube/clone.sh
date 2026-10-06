#!/bin/sh
# Clones a repository into ~/work and adds it as a project of the running
# server. Returns at once and finishes in the background, so the host is not
# held for the length of a clone; clients see the project when it is done.
# Output goes to ~/.t3/clone-<name>.log. While it runs, its process id is in
# ~/.t3/preparing.pid, which keeps the cube from sleeping mid-clone.
#
# Usage: t3-cube-clone <git url>
set -eu
url="$1"
name="$(basename "$url" .git)"
dest="$HOME/work/$name"

if [ "${T3_CUBE_CLONE_DETACHED:-}" != 1 ]; then
  mkdir -p "$HOME/work" "$HOME/.t3"
  T3_CUBE_CLONE_DETACHED=1 setsid "$0" "$url" \
    > "$HOME/.t3/clone-$name.log" 2>&1 < /dev/null &
  exit 0
fi

echo $$ > "$HOME/.t3/preparing.pid"
trap 'rm -f "$HOME/.t3/preparing.pid"' EXIT
[ -d "$dest/.git" ] || git clone --depth 50 "$url" "$dest"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  t3 project add "$dest" && exit 0
  sleep 1
done
exit 1
