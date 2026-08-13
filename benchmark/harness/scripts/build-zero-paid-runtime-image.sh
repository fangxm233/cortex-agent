#!/usr/bin/env bash
# input:  pinned Debian image and local Node/npm/PI runtimes
# output: digest-pinned offline benchmark runtime image
# pos:    Builds the ZERO-PAID campaign task runtime
# >>> If I am updated, update my header and folder CORTEX.md <<<

set -euo pipefail

BASE_IMAGE="${BASE_IMAGE:-debian@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNTIME_INPUTS="${RUNTIME_INPUTS:-$SCRIPT_DIR/zero-paid-runtime-inputs.json}"
PI_VERSION="$(node -p "require(process.argv[1]).pi.version" "$RUNTIME_INPUTS")"
IMAGE_TAG="${IMAGE_TAG:-cortex-bench-zero-paid-runtime:pi-${PI_VERSION}}"
NODE_BIN="${NODE_BIN:-$(readlink -f "$(command -v node)")}"
NPM_CLI="$(readlink -f "$(command -v npm)")"
NPM_ROOT="${NPM_ROOT:-$(dirname "$(dirname "$NPM_CLI")")}"
PI_ROOT="${PI_ROOT:-$(dirname "$(dirname "$(readlink -f "$(command -v pi)")")")}"
BUILD_ROOT="$(mktemp -d)"

cleanup() {
  rm -r "$BUILD_ROOT"
}
trap cleanup EXIT

require_file() {
  test -f "$1" || { printf 'required file is unavailable: %s\n' "$1" >&2; exit 1; }
}

require_file "$RUNTIME_INPUTS"
require_file "$NODE_BIN"
require_file "$NPM_ROOT/bin/npm-cli.js"
require_file "$NPM_ROOT/package.json"
require_file "$PI_ROOT/dist/cli.js"
require_file "$PI_ROOT/package.json"

manifest() {
  node -p "require(process.argv[1]).$1" "$RUNTIME_INPUTS"
}

tree_sha256() {
  tar --sort=name --mtime='UTC 1980-01-01' --owner=0 --group=0 --numeric-owner \
    --pax-option=delete=atime,delete=ctime -cf - -C "$1" . | sha256sum | cut -d' ' -f1
}

verify() {
  local label="$1" actual="$2" expected="$3"
  test "$actual" = "$expected" || {
    printf '%s mismatch: expected %s, got %s\n' "$label" "$expected" "$actual" >&2
    exit 1
  }
}

verify 'runtime schema' "$(manifest schema_version)" 'cortex-bench-zero-paid-runtime-inputs/1'
verify 'node version' "$($NODE_BIN --version)" "$(manifest node.version)"
verify 'node sha256' "$(sha256sum "$NODE_BIN" | cut -d' ' -f1)" "$(manifest node.sha256)"
verify 'npm version' "$(node -p "require(process.argv[1]).version" "$NPM_ROOT/package.json")" \
  "$(manifest npm.version)"
verify 'npm tree sha256' "$(tree_sha256 "$NPM_ROOT")" "$(manifest npm.tree_sha256)"
verify 'PI version' "$(node -p "require(process.argv[1]).version" "$PI_ROOT/package.json")" \
  "$PI_VERSION"
verify 'PI tree sha256' "$(tree_sha256 "$PI_ROOT")" "$(manifest pi.tree_sha256)"

mkdir -p "$BUILD_ROOT/node-runtime/bin" "$BUILD_ROOT/node-runtime/lib/node_modules"
install -m 0755 "$NODE_BIN" "$BUILD_ROOT/node-runtime/bin/node"
cp -a "$NPM_ROOT" "$BUILD_ROOT/node-runtime/lib/node_modules/npm"
ln -s ../lib/node_modules/npm/bin/npm-cli.js "$BUILD_ROOT/node-runtime/bin/npm"
cp -a "$PI_ROOT" "$BUILD_ROOT/pi-agent"

cat > "$BUILD_ROOT/Dockerfile" <<EOF
FROM $BASE_IMAGE
COPY node-runtime /opt/node
COPY pi-agent /opt/pi-agent
RUN ln -s /opt/node/bin/node /usr/local/bin/node \\
 && ln -s /opt/node/bin/npm /usr/local/bin/npm \\
 && ln -s /opt/pi-agent/dist/cli.js /usr/local/bin/pi \\
 && chmod +x /opt/pi-agent/dist/cli.js \\
 && mkdir -p /app
WORKDIR /app
EOF

docker build --network none --pull=false --provenance=false --tag "$IMAGE_TAG" "$BUILD_ROOT" >/dev/null
IMAGE_REF="$(docker image inspect "$IMAGE_TAG" --format '{{index .RepoDigests 0}}')"
IMAGE_DIGEST="${IMAGE_REF##*@}"
test -n "$IMAGE_REF" && test "$IMAGE_REF" != '<no value>'
case "$IMAGE_DIGEST" in
  sha256:????????????????????????????????????????????????????????????????) ;;
  *) printf 'built image has no sha256 repo digest: %s\n' "$IMAGE_REF" >&2; exit 1 ;;
esac

docker run --rm --network none --pull never --entrypoint /bin/sh "$IMAGE_REF" -lc \
  "node --version >/dev/null && npm --version >/dev/null && test \"\$(pi --version)\" = '$PI_VERSION'"

printf 'pi_version=%s\n' "$PI_VERSION"
printf 'image_ref=%s\n' "$IMAGE_REF"
printf 'image_digest=%s\n' "$IMAGE_DIGEST"
