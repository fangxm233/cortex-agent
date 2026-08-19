#!/usr/bin/env bash
# input:  pinned Debian image and one local vendor runtime
# output: digest-pinned offline single-vendor runtime image
# pos:    Builds one isolated benchmark vendor runtime
# >>> If I am updated, update my header and folder CORTEX.md <<<

set -euo pipefail

BASE_IMAGE="${BASE_IMAGE:-debian@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNTIME_INPUTS="${RUNTIME_INPUTS:-$SCRIPT_DIR/zero-paid-runtime-inputs.json}"
PREFLIGHT_SCRIPT="$SCRIPT_DIR/vendor-runtime-preflight.js"
VENDOR="${VENDOR:-pi}"
NODE_BIN="${NODE_BIN:-$(readlink -f "$(command -v node)")}"
NPM_CLI="$(readlink -f "$(command -v npm)")"
NPM_ROOT="${NPM_ROOT:-$(dirname "$(dirname "$NPM_CLI")")}"
PI_ROOT="${PI_ROOT:-}"
CLAUDE_BIN="${CLAUDE_BIN:-}"
CODEX_ROOT="${CODEX_ROOT:-}"
BUILD_ROOT="$(mktemp -d)"

cleanup() {
  rm -r "$BUILD_ROOT"
}
trap cleanup EXIT

require_file() {
  test -f "$1" || { printf 'required file is unavailable: %s\n' "$1" >&2; exit 1; }
}

manifest() {
  node -p "require(process.argv[1]).$1" "$RUNTIME_INPUTS"
}

vendor_field() {
  node -e 'console.log(require(process.argv[1]).vendors[process.argv[2]][process.argv[3]])' \
    "$RUNTIME_INPUTS" "$VENDOR" "$1"
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

verify_common_runtime() {
  verify 'runtime schema' "$(manifest schema_version)" 'cortex-bench-vendor-runtime-inputs/2'
  verify 'node version' "$($NODE_BIN --version)" "$(manifest node.version)"
  verify 'node sha256' "$(sha256sum "$NODE_BIN" | cut -d' ' -f1)" "$(manifest node.sha256)"
  verify 'npm version' "$(node -p 'require(process.argv[1]).version' "$NPM_ROOT/package.json")" \
    "$(manifest npm.version)"
  verify 'npm tree sha256' "$(tree_sha256 "$NPM_ROOT")" "$(manifest npm.tree_sha256)"
}

stage_node() {
  mkdir -p "$BUILD_ROOT/node-runtime/bin"
  install -m 0755 "$NODE_BIN" "$BUILD_ROOT/node-runtime/bin/node"
}

stage_pi() {
  local root="${PI_ROOT:-$(dirname "$(dirname "$(readlink -f "$(command -v pi)")")")}"
  require_file "$root/package.json"
  require_file "$root/dist/cli.js"
  verify 'PI package' "$(node -p 'require(process.argv[1]).name' "$root/package.json")" \
    '@earendil-works/pi-coding-agent'
  verify 'PI package pin' "$(vendor_field package)" '@earendil-works/pi-coding-agent'
  verify 'PI version' "$(node -p 'require(process.argv[1]).version' "$root/package.json")" \
    "$(vendor_field version)"
  verify 'PI tree sha256' "$(tree_sha256 "$root")" "$(vendor_field tree_sha256)"
  cp -a "$root" "$BUILD_ROOT/vendor-runtime"
}

stage_claude() {
  local binary="${CLAUDE_BIN:-$(readlink -f "$(command -v claude)")}"
  require_file "$binary"
  verify 'Claude platform' "$(vendor_field platform)" 'linux-x64'
  verify 'Claude sha256' "$(sha256sum "$binary" | cut -d' ' -f1)" "$(vendor_field sha256)"
  verify 'Claude size' "$(stat -c '%s' "$binary")" "$(vendor_field size_bytes)"
  verify 'Claude version' "$($binary --version)" "$(vendor_field version) (Claude Code)"
  mkdir -p "$BUILD_ROOT/vendor-runtime"
  install -m 0755 "$binary" "$BUILD_ROOT/vendor-runtime/claude"
}

stage_codex() {
  local root platform native
  root="${CODEX_ROOT:-$(dirname "$(dirname "$(readlink -f "$(command -v codex)")")")}"
  platform="$root/node_modules/@openai/codex-linux-x64/package.json"
  native="$root/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/codex/codex"
  require_file "$root/package.json"; require_file "$root/bin/codex.js"
  require_file "$platform"; require_file "$native"
  verify 'Codex package' "$(node -p 'require(process.argv[1]).name' "$root/package.json")" \
    "$(vendor_field package)"
  verify 'Codex version' "$(node -p 'require(process.argv[1]).version' "$root/package.json")" \
    "$(vendor_field version)"
  verify 'Codex tree sha256' "$(tree_sha256 "$root")" "$(vendor_field tree_sha256)"
  verify 'Codex platform package' \
    "$(node -e 'const p=require(process.argv[1]); console.log(`${p.name}@${p.version}`)' "$platform")" \
    "$(vendor_field platform_package)"
  verify 'Codex native sha256' "$(sha256sum "$native" | cut -d' ' -f1)" \
    "$(vendor_field native_binary_sha256)"
  cp -a "$root" "$BUILD_ROOT/vendor-runtime"
}

stage_vendor() {
  case "$VENDOR" in
    pi) stage_pi ;;
    claude-code) stage_claude ;;
    codex) stage_codex ;;
    *) printf 'invalid VENDOR: %s (valid values: pi, claude-code, codex)\n' "$VENDOR" >&2; exit 2 ;;
  esac
}

write_dockerfile() {
  local command
  command="$(command_for_vendor)"
  cat > "$BUILD_ROOT/Dockerfile" <<EOF
FROM $BASE_IMAGE
COPY node-runtime /opt/node
COPY vendor-runtime /opt/vendor-runtime
RUN ln -s /opt/node/bin/node /usr/local/bin/node \\
 && ln -s $(target_for_vendor) /usr/local/bin/$command \\
 && chmod +x $(target_for_vendor) \\
 && mkdir -p /app
WORKDIR /app
EOF
}

command_for_vendor() {
  case "$VENDOR" in pi) printf pi;; claude-code) printf claude;; codex) printf codex;; esac
}

target_for_vendor() {
  case "$VENDOR" in
    pi) printf /opt/vendor-runtime/dist/cli.js ;;
    claude-code) printf /opt/vendor-runtime/claude ;;
    codex) printf /opt/vendor-runtime/bin/codex.js ;;
  esac
}

runtime_preflight() {
  local image_ref="$1" command
  command="$(command_for_vendor)"
  docker run --rm --network none --pull never \
    --mount "type=bind,src=$PREFLIGHT_SCRIPT,dst=/tmp/vendor-runtime-preflight.js,ro" \
    --entrypoint /opt/node/bin/node "$image_ref" /tmp/vendor-runtime-preflight.js \
    --vendor "$VENDOR" --cli "/usr/local/bin/$command" >/dev/null
}

require_file "$RUNTIME_INPUTS"
require_file "$PREFLIGHT_SCRIPT"
require_file "$NODE_BIN"
require_file "$NPM_ROOT/package.json"
verify_common_runtime
stage_node
stage_vendor
VENDOR_VERSION="$(vendor_field version)"
IMAGE_TAG="${IMAGE_TAG:-cortex-bench-zero-paid-runtime:$VENDOR-$VENDOR_VERSION}"
write_dockerfile
docker build --network none --pull=false --provenance=false --tag "$IMAGE_TAG" "$BUILD_ROOT" >/dev/null
IMAGE_REF="$(docker image inspect "$IMAGE_TAG" --format '{{index .RepoDigests 0}}')"
IMAGE_DIGEST="${IMAGE_REF##*@}"
test -n "$IMAGE_REF" && test "$IMAGE_REF" != '<no value>'
case "$IMAGE_DIGEST" in
  sha256:????????????????????????????????????????????????????????????????) ;;
  *) printf 'built image has no sha256 repo digest: %s\n' "$IMAGE_REF" >&2; exit 1 ;;
esac
runtime_preflight "$IMAGE_REF"
printf 'vendor=%s\n' "$VENDOR"
printf 'vendor_version=%s\n' "$VENDOR_VERSION"
printf 'image_ref=%s\n' "$IMAGE_REF"
printf 'image_digest=%s\n' "$IMAGE_DIGEST"
