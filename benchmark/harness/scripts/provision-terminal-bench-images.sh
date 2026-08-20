#!/usr/bin/env bash
# input:  pinned Terminal-Bench sources, vendor runtimes, Node/npm
# output: authentic tasks and immutable vendor or Cortex-smoke images
# pos:    Provisions pull-disabled Terminal-Bench 2.1 runtimes
# >>> If I am updated, update my header and folder CORTEX.md <<<

set -euo pipefail
shopt -s inherit_errexit

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPOSITORY_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
MANIFEST="${MANIFEST:-$SCRIPT_DIR/terminal-bench-2.1-images.json}"
TASKS_DIR="${TASKS_DIR:-$REPOSITORY_ROOT/benchmark/campaigns/tasks/terminal-bench-2.1}"
SOURCE_DIR="${SOURCE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/cortex-bench/terminal-bench-2.1}"
BUILD_ROOT="$(mktemp -d)"
WHEELHOUSE="${WHEELHOUSE:-${XDG_CACHE_HOME:-$HOME/.cache}/cortex-bench/verifier-wheels}"
PREFLIGHT_SCRIPT="$SCRIPT_DIR/vendor-runtime-preflight.js"
ACQUIRE=0
CAPTURE_DIGESTS=0
CORTEX_SMOKE=0
VENDORS=(pi claude-code codex)

cleanup() {
  rm -r "$BUILD_ROOT"
}
trap cleanup EXIT

usage() {
  cat <<'EOF'
Usage: provision-terminal-bench-images.sh [--acquire] [--capture-digests] [--vendor <name>] [--cortex-smoke]

Provision every task/vendor variant, one vendor's variants, or the Cortex smoke image.
The command builds with no network or pull and prints immutable image references.

Options:
  --acquire          Fetch missing pinned sources, images, and verifier wheels.
  --capture-digests  Bootstrap newly declared image digests without accepting them.
  --vendor           Build only pi, claude-code, or codex variants.
  --cortex-smoke     Build only the committed Cortex-compatible smoke image.
  -h, --help         Show this help.

Examples:
  benchmark/harness/scripts/provision-terminal-bench-images.sh
  benchmark/harness/scripts/provision-terminal-bench-images.sh --acquire
  benchmark/harness/scripts/provision-terminal-bench-images.sh --vendor codex
  benchmark/harness/scripts/provision-terminal-bench-images.sh --cortex-smoke
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --acquire) ACQUIRE=1 ;;
    --capture-digests) CAPTURE_DIGESTS=1 ;;
    --vendor)
      case "${2:-}" in
        pi|claude-code|codex) VENDORS=("$2"); shift ;;
        *) printf 'invalid --vendor: %s (valid values: pi, claude-code, codex)\n' "${2:-}" >&2; exit 2 ;;
      esac
      ;;
    --cortex-smoke) CORTEX_SMOKE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown argument: %s (valid options: --acquire, --capture-digests, --vendor, --cortex-smoke, --help, -h)\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

manifest() {
  node -e 'const v=require(process.argv[1]); console.log(JSON.stringify(eval(`v.${process.argv[2]}`)))' \
    "$MANIFEST" "$1"
}

json_text() {
  manifest "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)))'
}

resolve_input() {
  node -e 'const p=require("path"); console.log(p.resolve(p.dirname(process.argv[1]), process.argv[2]))' \
    "$MANIFEST" "$1"
}

runtime_field() {
  node -e 'console.log(require(process.argv[1]).vendors[process.argv[2]][process.argv[3]])' \
    "$RUNTIME_INPUTS" "$1" "$2"
}

require_file() {
  test -f "$1" || { printf 'required file is unavailable: %s\n' "$1" >&2; exit 1; }
}

verify() {
  local label="$1" actual="$2" expected="$3"
  test "$actual" = "$expected" || {
    printf '%s mismatch: expected %s, got %s\n' "$label" "$expected" "$actual" >&2
    exit 1
  }
}

tree_sha256() {
  tar --sort=name --mtime='UTC 1980-01-01' --owner=0 --group=0 --numeric-owner \
    --pax-option=delete=atime,delete=ctime -cf - -C "$1" . | sha256sum | cut -d' ' -f1
}

acquire_source() {
  local repository="$1" commit="$2"
  if [[ ! -d "$SOURCE_DIR/.git" ]]; then
    if [[ "$ACQUIRE" != 1 ]]; then
      printf 'pinned Terminal-Bench source is unavailable: %s\n' "$SOURCE_DIR" >&2
      exit 1
    fi
    git clone --filter=blob:none --no-checkout "$repository" "$SOURCE_DIR" >/dev/null
    git -C "$SOURCE_DIR" fetch --depth=1 origin "$commit" >/dev/null
    git -C "$SOURCE_DIR" checkout --detach "$commit" >/dev/null
  fi
  verify 'Terminal-Bench source commit' "$(git -C "$SOURCE_DIR" rev-parse HEAD)" "$commit"
}

stage_node() {
  local node_bin npm_root
  node_bin="${NODE_BIN:-$(readlink -f "$(command -v node)")}"
  npm_root="${NPM_ROOT:-$(dirname "$(dirname "$(readlink -f "$(command -v npm)")")")}"
  require_file "$node_bin"; require_file "$npm_root/package.json"
  verify 'node version' "$($node_bin --version)" "$(node -p 'require(process.argv[1]).node.version' "$RUNTIME_INPUTS")"
  verify 'node sha256' "$(sha256sum "$node_bin" | cut -d' ' -f1)" \
    "$(node -p 'require(process.argv[1]).node.sha256' "$RUNTIME_INPUTS")"
  verify 'npm tree sha256' "$(tree_sha256 "$npm_root")" \
    "$(node -p 'require(process.argv[1]).npm.tree_sha256' "$RUNTIME_INPUTS")"
  mkdir -p "$BUILD_ROOT/runtime/node/bin"
  install -m 0755 "$node_bin" "$BUILD_ROOT/runtime/node/bin/node"
}

stage_pi() {
  local root
  root="${PI_ROOT:-$(dirname "$(dirname "$(readlink -f "$(command -v pi)")")")}"
  require_file "$root/package.json"; require_file "$root/dist/cli.js"
  verify 'PI package' "$(node -p 'require(process.argv[1]).name' "$root/package.json")" \
    '@earendil-works/pi-coding-agent'
  verify 'PI package pin' "$(runtime_field pi package)" '@earendil-works/pi-coding-agent'
  verify 'PI version' "$(node -p 'require(process.argv[1]).version' "$root/package.json")" \
    "$(runtime_field pi version)"
  verify 'PI tree sha256' "$(tree_sha256 "$root")" "$(runtime_field pi tree_sha256)"
  cp -a "$root" "$BUILD_ROOT/runtime/vendors/pi"
}

stage_claude() {
  local binary
  binary="${CLAUDE_BIN:-$(readlink -f "$(command -v claude)")}"
  require_file "$binary"
  verify 'Claude platform' "$(runtime_field claude-code platform)" 'linux-x64'
  verify 'Claude sha256' "$(sha256sum "$binary" | cut -d' ' -f1)" \
    "$(runtime_field claude-code sha256)"
  verify 'Claude size' "$(stat -c '%s' "$binary")" "$(runtime_field claude-code size_bytes)"
  verify 'Claude version' "$($binary --version)" \
    "$(runtime_field claude-code version) (Claude Code)"
  mkdir -p "$BUILD_ROOT/runtime/vendors/claude-code"
  install -m 0755 "$binary" "$BUILD_ROOT/runtime/vendors/claude-code/claude"
}

stage_codex() {
  local root platform native
  root="${CODEX_ROOT:-$(dirname "$(dirname "$(readlink -f "$(command -v codex)")")")}"
  platform="$root/node_modules/@openai/codex-linux-x64/package.json"
  native="$root/node_modules/@openai/codex-linux-x64/$(runtime_field codex native_binary_path)"
  require_file "$root/package.json"; require_file "$root/bin/codex.js"
  require_file "$platform"; require_file "$native"
  verify 'Codex package' "$(node -p 'require(process.argv[1]).name' "$root/package.json")" \
    "$(runtime_field codex package)"
  verify 'Codex version' "$(node -p 'require(process.argv[1]).version' "$root/package.json")" \
    "$(runtime_field codex version)"
  verify 'Codex tree sha256' "$(tree_sha256 "$root")" "$(runtime_field codex tree_sha256)"
  verify 'Codex platform package' \
    "$(node -e 'const p=require(process.argv[1]); console.log(`${p.name}@${p.version}`)' "$platform")" \
    "$(runtime_field codex platform_package)"
  verify 'Codex native sha256' "$(sha256sum "$native" | cut -d' ' -f1)" \
    "$(runtime_field codex native_binary_sha256)"
  cp -a "$root" "$BUILD_ROOT/runtime/vendors/codex"
}

stage_runtimes() {
  verify 'runtime schema' "$(node -p 'require(process.argv[1]).schema_version' "$RUNTIME_INPUTS")" \
    'cortex-bench-vendor-runtime-inputs/2'
  stage_node
  mkdir -p "$BUILD_ROOT/runtime/vendors"
  if [[ "$CORTEX_SMOKE" == 1 ]]; then stage_pi; return; fi
  for vendor in "${VENDORS[@]}"; do
    case "$vendor" in
      pi) stage_pi ;;
      claude-code) stage_claude ;;
      codex) stage_codex ;;
    esac
    verify "$vendor manifest version" "$(json_text "vendors['$vendor'].version")" \
      "$(runtime_field "$vendor" version)"
  done
}

stage_verifier() {
  local python_version tree expected wheel requirement record
  local -a requirements=() wheels=()
  python_version="$(json_text 'verifier.python_version')"
  tree="$BUILD_ROOT/runtime/verifier/site-packages"
  mkdir -p "$tree"
  mapfile -t wheels < <(node -e 'for(const p of require(process.argv[1]).verifier.packages) console.log(`${p.filename}\t${p.url}\t${p.sha256}\t${p.requirement}`)' "$MANIFEST")
  for record in "${wheels[@]}"; do
    IFS=$'\t' read -r filename url digest requirement <<<"$record"
    wheel="$WHEELHOUSE/$filename"
    if [[ ! -f "$wheel" && "$ACQUIRE" == 1 ]]; then
      mkdir -p "$WHEELHOUSE"
      curl --fail --location --silent --show-error -o "$wheel" "$url"
    fi
    test -f "$wheel" || { printf 'pinned verifier wheel is unavailable: %s\n' "$wheel" >&2; exit 1; }
    verify "$filename sha256" "$(sha256sum "$wheel" | cut -d' ' -f1)" "$digest"
    requirements+=("$requirement")
  done
  uv pip install --offline --no-index --find-links "$WHEELHOUSE" \
    --python "$(uv python find --system "$python_version")" \
    --python-version "$python_version" --python-platform x86_64-manylinux_2_17 \
    --target "$tree" "${requirements[@]}" >/dev/null
  find "$tree" -type d -name __pycache__ -prune -exec rm -r {} +
  expected="${VERIFIER_TREE_SHA256:-$(json_text 'verifier.tree_sha256')}"
  verify 'verifier tree sha256' "$(tree_sha256 "$tree")" "$expected"
  write_verifier_wrappers
}

write_verifier_wrappers() {
  local bin="$BUILD_ROOT/runtime/verifier/bin"
  mkdir -p "$bin"
  cat > "$bin/uvx" <<'EOF'
#!/bin/sh
set -eu
while [ "$#" -gt 0 ]; do
  case "$1" in
    -p|-w) shift 2 ;;
    pytest) shift; PYTHONPATH=/opt/terminal-bench-verifier/site-packages exec python3 -m pytest "$@" ;;
    *) printf 'unsupported offline uvx argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done
EOF
  cat > "$bin/apt-get" <<'EOF'
#!/bin/sh
case "${1:-}" in
  update) exit 0 ;;
  install) shift; [ "${1:-}" = -y ] && shift; [ "$#" -eq 1 ] && [ "$1" = curl ] && exit 0 ;;
esac
printf 'offline apt-get supports only update and install -y curl\n' >&2
exit 2
EOF
  cat > "$bin/curl" <<'EOF'
#!/bin/sh
case "$*" in
  *https://astral.sh/uv/0.9.5/install.sh*)
    printf '%s\n' 'mkdir -p "$HOME/.local/bin"' \
      'ln -sf /opt/terminal-bench-verifier/bin/uvx "$HOME/.local/bin/uvx"' \
      'printf '\''export PATH="%s/.local/bin:$PATH"\\n'\'' "$HOME" > "$HOME/.local/bin/env"'
    ;;
  *) printf 'network curl is unavailable in the offline trial\n' >&2; exit 22 ;;
esac
EOF
  chmod 0755 "$bin/apt-get" "$bin/uvx" "$bin/curl"
}

verify_source_file() {
  local task_id="$1" relative="$2" expected="$3" path
  path="$SOURCE_DIR/tasks/$task_id/$relative"
  require_file "$path"
  verify "$task_id $relative sha256" "$(sha256sum "$path" | cut -d' ' -f1)" "$expected"
}

stage_task_directory() {
  local task_id="$1" vendor="$2" image_ref="$3" source_task target
  source_task="$SOURCE_DIR/tasks/$task_id"
  if [[ "$vendor" == cortex ]]; then target="$TASKS_DIR/$task_id"
  else target="$TASKS_DIR/$vendor/$task_id"
  fi
  mkdir -p "$target/tests"
  install -m 0644 "$source_task/instruction.md" "$target/instruction.md"
  install -m 0755 "$source_task/tests/test.sh" "$target/tests/test.sh"
  install -m 0644 "$source_task/tests/test_outputs.py" "$target/tests/test_outputs.py"
  awk -v image="$image_ref" '
    /^docker_image = / { print "docker_image = \"" image "\""; next }
    /^allow_internet = / { print "network_mode = \"public\"\nos = \"linux\""; next }
    { print }
  ' "$source_task/task.toml" > "$target/task.toml"
}

source_image_ref() {
  node -e 'const t=require(process.argv[1]).tasks[+process.argv[2]]; console.log(`${t.source_image_ref.split(":")[0]}@${t.source_image_digest}`)' "$MANIFEST" "$1"
}

ensure_source_image() {
  local image_ref="$1" expected_digest actual
  expected_digest="${image_ref##*@}"
  if ! docker image inspect "$image_ref" >/dev/null 2>&1; then
    if [[ "$ACQUIRE" == 1 ]]; then docker pull "$image_ref" >/dev/null
    else printf 'pinned source image is unavailable: %s\n' "$image_ref" >&2; exit 1
    fi
  fi
  actual="$(docker image inspect "$image_ref" --format '{{.Id}}')"
  verify 'source image digest' "$actual" "$expected_digest"
}

vendor_target() {
  case "$1" in
    pi) printf /opt/vendor-runtime/dist/cli.js ;;
    claude-code) printf /opt/vendor-runtime/claude ;;
    codex) printf /opt/vendor-runtime/bin/codex.js ;;
  esac
}

vendor_command() {
  case "$1" in pi) printf pi;; claude-code) printf claude;; codex) printf codex;; esac
}

write_dockerfile() {
  local source_image="$1" vendor="$2" context="$3" command target
  command="$(vendor_command "$vendor")"; target="$(vendor_target "$vendor")"
  mkdir -p "$context"
  cp -a "$BUILD_ROOT/runtime/node" "$context/node"
  cp -a "$BUILD_ROOT/runtime/verifier" "$context/verifier"
  cp -a "$BUILD_ROOT/runtime/vendors/$vendor" "$context/vendor-runtime"
  cat > "$context/Dockerfile" <<EOF
FROM $source_image
ARG SOURCE_DATE_EPOCH
COPY node /opt/node
COPY verifier /opt/terminal-bench-verifier
COPY vendor-runtime /opt/vendor-runtime
RUN ln -s /opt/node/bin/node /usr/local/bin/node \\
 && ln -s $target /usr/local/bin/$command \\
 && ln -s /opt/terminal-bench-verifier/bin/apt-get /usr/local/bin/apt-get \\
 && ln -s /opt/terminal-bench-verifier/bin/curl /usr/local/bin/curl \\
 && chmod +x $target
EOF
  find "$context" -exec touch -h -d '1980-01-01T00:00:00Z' {} +
}

inspect_final_image() {
  local image_tag="$1" expected_digest="$2" image_ref config
  image_ref="$(docker image inspect "$image_tag" --format '{{index .RepoDigests 0}}')"
  if [[ "$CAPTURE_DIGESTS" == 0 ]]; then
    verify "$image_tag digest" "${image_ref##*@}" "$expected_digest"
  fi
  config="$(docker image inspect "$image_ref" --format '{{json .Config}}')"
  node -e '
    const c=JSON.parse(process.argv[1]);
    const keys=(c.Env||[]).map(v=>v.split("=",1)[0]);
    if(JSON.stringify(keys)!==JSON.stringify(["PATH"])) throw Error(`unadmitted image environment: ${keys}`);
    if(c.Volumes && Object.keys(c.Volumes).length) throw Error("image declares volumes");
  ' "$config"
  printf '%s\n' "$image_ref"
}

runtime_preflight() {
  local vendor="$1" image_ref="$2" command
  command="$(vendor_command "$vendor")"
  docker run --rm --network none --pull never \
    --mount "type=bind,src=$PREFLIGHT_SCRIPT,dst=/tmp/vendor-runtime-preflight.js,ro" \
    --entrypoint /opt/node/bin/node "$image_ref" /tmp/vendor-runtime-preflight.js \
    --vendor "$vendor" --cli "/usr/local/bin/$command" >/dev/null
}

write_smoke_dockerfile() {
  local source_image="$1" context="$2" npm_root
  npm_root="${NPM_ROOT:-$(dirname "$(dirname "$(readlink -f "$(command -v npm)")")")}"
  mkdir -p "$context"
  cp -a "$BUILD_ROOT/runtime/node" "$context/node"
  cp -a "$npm_root" "$context/npm"
  cp -a "$BUILD_ROOT/runtime/vendors/pi" "$context/pi-agent"
  cp -a "$BUILD_ROOT/runtime/verifier" "$context/verifier"
  cat > "$context/Dockerfile" <<EOF
FROM $source_image
ARG SOURCE_DATE_EPOCH
COPY node /opt/node
COPY npm /opt/node/lib/node_modules/npm
COPY pi-agent /opt/pi-agent
COPY verifier /opt/terminal-bench-verifier
RUN ln -s /opt/node/bin/node /usr/local/bin/node \
 && ln -s ../lib/node_modules/npm/bin/npm-cli.js /opt/node/bin/npm \
 && ln -s /opt/node/bin/npm /usr/local/bin/npm \
 && ln -s /opt/pi-agent/dist/cli.js /usr/local/bin/pi \
 && ln -s /opt/terminal-bench-verifier/bin/apt-get /usr/local/bin/apt-get \
 && ln -s /opt/terminal-bench-verifier/bin/curl /usr/local/bin/curl \
 && chmod +x /opt/pi-agent/dist/cli.js
EOF
  find "$context" -exec touch -h -d '1980-01-01T00:00:00Z' {} +
}

smoke_preflight() {
  docker run --rm --network none --pull never --entrypoint /bin/bash "$1" -lc \
    'set -euo pipefail; for x in bash node npm pi pwd realpath ln chmod mkdir; do command -v "$x" >/dev/null; done; test "$(node --version)" = v22.19.0; test "$(npm --version)" = 10.9.3; test "$(pi --version)" = 0.82.1'
}

build_variant() {
  local index="$1" vendor="$2" task_id source_ref image_tag expected context archive image_ref
  task_id="$(node -e 'console.log(require(process.argv[1]).tasks[+process.argv[2]].task_id)' "$MANIFEST" "$index")"
  source_ref="$(source_image_ref "$index")"
  image_tag="$(node -e 'console.log(require(process.argv[1]).tasks[+process.argv[2]].variants[process.argv[3]].final_image_tag)' "$MANIFEST" "$index" "$vendor")"
  expected="$(node -e 'console.log(require(process.argv[1]).tasks[+process.argv[2]].variants[process.argv[3]].final_image_digest)' "$MANIFEST" "$index" "$vendor")"
  context="$BUILD_ROOT/build/$task_id/$vendor"
  write_dockerfile "$source_ref" "$vendor" "$context"
  archive="$BUILD_ROOT/$task_id-$vendor.tar"
  docker buildx build --network none --pull=false --no-cache --provenance=false \
    --build-arg "SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH" \
    --output "type=oci,name=$image_tag,dest=$archive,rewrite-timestamp=true" \
    "$context" >/dev/null
  docker load --input "$archive" >/dev/null
  image_ref="$(inspect_final_image "$image_tag" "$expected")"
  runtime_preflight "$vendor" "$image_ref"
  stage_task_directory "$task_id" "$vendor" "$image_ref"
  printf '{"task_id":%s,"vendor":%s,"task_path":%s,"image_ref":%s}' \
    "$(json_string "$task_id")" "$(json_string "$vendor")" \
    "$(json_string "$TASKS_DIR/$vendor/$task_id")" "$(json_string "$image_ref")"
}

build_cortex_smoke() {
  local task_id index source_ref image_tag expected context archive image_ref
  task_id="$(json_text 'cortex_smoke.task_id')"
  index="$(node -e 'const m=require(process.argv[1]); console.log(m.tasks.findIndex(t=>t.task_id===process.argv[2]))' "$MANIFEST" "$task_id")"
  test "$index" -ge 0 || { printf 'Cortex smoke task is absent: %s\n' "$task_id" >&2; exit 1; }
  source_ref="$(source_image_ref "$index")"
  ensure_source_image "$source_ref"
  image_tag="$(json_text 'cortex_smoke.final_image_tag')"
  expected="$(json_text 'cortex_smoke.final_image_digest')"
  context="$BUILD_ROOT/build/$task_id/cortex-smoke"
  write_smoke_dockerfile "$source_ref" "$context"
  archive="$BUILD_ROOT/$task_id-cortex-smoke.tar"
  docker buildx build --network none --pull=false --no-cache --provenance=false \
    --build-arg "SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH" \
    --output "type=oci,name=$image_tag,dest=$archive,rewrite-timestamp=true" \
    "$context" >/dev/null
  docker load --input "$archive" >/dev/null
  image_ref="$(inspect_final_image "$image_tag" "$expected")"
  smoke_preflight "$image_ref"
  stage_task_directory "$task_id" cortex "$image_ref"
  printf '{"ok":true,"task_id":%s,"image_ref":%s,"image_digest":%s}\n' \
    "$(json_string "$task_id")" "$(json_string "$image_ref")" "$(json_string "${image_ref##*@}")"
}

json_string() {
  printf '%s' "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(s)))'
}

require_file "$MANIFEST"
require_file "$PREFLIGHT_SCRIPT"
verify 'manifest schema' "$(json_text 'schema_version')" 'cortex-terminal-bench-images/2'
SOURCE_REPOSITORY="$(json_text 'source.repository')"
SOURCE_COMMIT="$(json_text 'source.commit')"
SOURCE_DATE_EPOCH="$(json_text 'build_epoch')"
export SOURCE_DATE_EPOCH
acquire_source "$SOURCE_REPOSITORY" "$SOURCE_COMMIT"
RUNTIME_INPUTS="$(resolve_input "$(json_text 'runtime_inputs')")"
require_file "$RUNTIME_INPUTS"
stage_runtimes
stage_verifier
find "$BUILD_ROOT/runtime" -exec touch -h -d '1980-01-01T00:00:00Z' {} +
mkdir -p "$TASKS_DIR"
if [[ "$CORTEX_SMOKE" == 1 ]]; then
  smoke_task="$(json_text 'cortex_smoke.task_id')"
  smoke_index="$(node -e 'const m=require(process.argv[1]); console.log(m.tasks.findIndex(t=>t.task_id===process.argv[2]))' "$MANIFEST" "$smoke_task")"
  while IFS=$'\t' read -r relative digest; do verify_source_file "$smoke_task" "$relative" "$digest"; done \
    < <(node -e 'const t=require(process.argv[1]).tasks[+process.argv[2]]; for(const [p,h] of Object.entries(t.source_files)) console.log(`${p}\t${h}`)' "$MANIFEST" "$smoke_index")
  build_cortex_smoke
  exit 0
fi
TASK_COUNT="$(node -p 'require(process.argv[1]).tasks.length' "$MANIFEST")"
RESULTS=()
for ((index = 0; index < TASK_COUNT; index++)); do
  task_id="$(node -e 'console.log(require(process.argv[1]).tasks[+process.argv[2]].task_id)' "$MANIFEST" "$index")"
  while IFS=$'\t' read -r relative digest; do verify_source_file "$task_id" "$relative" "$digest"; done \
    < <(node -e 'const t=require(process.argv[1]).tasks[+process.argv[2]]; for(const [p,h] of Object.entries(t.source_files)) console.log(`${p}\t${h}`)' "$MANIFEST" "$index")
  source_ref="$(source_image_ref "$index")"
  ensure_source_image "$source_ref"
  for vendor in "${VENDORS[@]}"; do RESULTS+=("$(build_variant "$index" "$vendor")"); done
done
printf '{"ok":true,"source_commit":%s,"variants":[' "$(json_string "$SOURCE_COMMIT")"
printf '%s' "${RESULTS[0]}"
for ((index = 1; index < ${#RESULTS[@]}; index++)); do printf ',%s' "${RESULTS[$index]}"; done
printf ']}\n'
