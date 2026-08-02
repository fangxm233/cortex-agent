#!/bin/sh
# input:  Claude print-mode argv and one stream-json user message
# output: deterministic streams delegated to the offline Node fixture
# pos:    Executable Claude shim for container integration
# >>> If I am updated, update my header and folder CORTEX.md <<<

set -eu
exec node "$(dirname "$0")/fake_claude.mjs" "$@"
