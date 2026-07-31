# input:  helper binary, run token, workspace, root mode
# output: escaped double-fork tree and readiness marker
# pos:    Builds the hostile shell and env-isolation process chain
# >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

set -eu

helper="$1"
token="$2"
workspace="$3"
mode="$4"

/bin/sh -c '
  /usr/bin/env -i PATH=/usr/bin:/bin /usr/bin/setsid "$1" "$2" "$3"
' fixture-shell "$helper" "$token" "$workspace"

while [ ! -f "$workspace/ready" ]; do
  /bin/sleep 0.01
done

case "$mode" in
  normal)
    exit 0
    ;;
  exit42)
    exit 42
    ;;
  stay)
    while :; do /bin/sleep 1; done
    ;;
  *)
    printf 'unknown root mode: %s\n' "$mode" >&2
    exit 64
    ;;
esac
