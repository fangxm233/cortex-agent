#!/usr/bin/env bash
# input:  pinned Terminal-Bench sources and local Node/npm/PI inputs
# output: authentic admitted tasks and immutable local runtime images
# pos:    Provisions pull-disabled Terminal-Bench 2.1 task images
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
ACQUIRE=0

cleanup() {
  rm -r "$BUILD_ROOT"
}
trap cleanup EXIT

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'EOF'
Usage: provision-terminal-bench-images.sh

Provision every task declared in terminal-bench-2.1-images.json. The command
acquires only digest-pinned base images, emits admitted task directories, and
prints a JSON result containing immutable final image references.

Options:
  --acquire   Fetch missing pinned sources, images, and verifier wheels.
  -h, --help  Show this help.

Examples:
  benchmark/harness/scripts/provision-terminal-bench-images.sh
  benchmark/harness/scripts/provision-terminal-bench-images.sh --acquire
EOF
  exit 0
fi
if [[ "${1:-}" == "--acquire" ]]; then ACQUIRE=1; shift; fi
if [[ $# -ne 0 ]]; then
  printf 'unknown argument: %s (valid options: --acquire, --help, -h)\n' "$1" >&2
  exit 2
fi

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

stage_runtime() {
  local runtime_inputs="$1" node_bin npm_root pi_root
  node_bin="${NODE_BIN:-$(readlink -f "$(command -v node)")}"
  npm_root="${NPM_ROOT:-$(dirname "$(dirname "$(readlink -f "$(command -v npm)")")")}"
  pi_root="${PI_ROOT:-$(dirname "$(dirname "$(readlink -f "$(command -v pi)")")")}"
  require_file "$node_bin"; require_file "$npm_root/package.json"; require_file "$pi_root/package.json"
  verify 'node version' "$($node_bin --version)" "$(node -p 'require(process.argv[1]).node.version' "$runtime_inputs")"
  verify 'node sha256' "$(sha256sum "$node_bin" | cut -d' ' -f1)" "$(node -p 'require(process.argv[1]).node.sha256' "$runtime_inputs")"
  verify 'npm tree sha256' "$(tree_sha256 "$npm_root")" "$(node -p 'require(process.argv[1]).npm.tree_sha256' "$runtime_inputs")"
  verify 'PI version' "$(node -p 'require(process.argv[1]).version' "$pi_root/package.json")" '0.82.1'
  verify 'PI tree sha256' "$(tree_sha256 "$pi_root")" "$(node -p 'require(process.argv[1]).pi.tree_sha256' "$runtime_inputs")"
  mkdir -p "$BUILD_ROOT/runtime/node/bin" "$BUILD_ROOT/runtime/node/lib/node_modules"
  install -m 0755 "$node_bin" "$BUILD_ROOT/runtime/node/bin/node"
  cp -a "$npm_root" "$BUILD_ROOT/runtime/node/lib/node_modules/npm"
  ln -s ../lib/node_modules/npm/bin/npm-cli.js "$BUILD_ROOT/runtime/node/bin/npm"
  cp -a "$pi_root" "$BUILD_ROOT/runtime/pi-agent"
}

stage_verifier() {
  local python_version tree expected wheel requirement
  local -a requirements=()
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
  write_uvx_wrapper "$bin/uvx"
  write_apt_wrapper "$bin/apt-get"
  write_curl_wrapper "$bin/curl"
  chmod 0755 "$bin/apt-get" "$bin/uvx" "$bin/curl"
}

write_uvx_wrapper() {
  cat > "$1" <<'EOF'
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
}

write_apt_wrapper() {
  cat > "$1" <<'EOF'
#!/bin/sh
case "${1:-}" in
  update) exit 0 ;;
  install) shift; [ "${1:-}" = -y ] && shift; [ "$#" -eq 1 ] && [ "$1" = curl ] && exit 0 ;;
esac
printf 'offline apt-get supports only update and install -y curl\n' >&2
exit 2
EOF
}

write_curl_wrapper() {
  cat > "$1" <<'EOF'
#!/bin/sh
case "$*" in
  *https://astral.sh/uv/0.9.5/install.sh*)
    cat <<'INSTALL'
mkdir -p "$HOME/.local/bin"
ln -sf /opt/terminal-bench-verifier/bin/uvx "$HOME/.local/bin/uvx"
printf 'export PATH="%s/.local/bin:$PATH"\n' "$HOME" > "$HOME/.local/bin/env"
INSTALL
    ;;
  *) printf 'network curl is unavailable in the offline trial\n' >&2; exit 22 ;;
esac
EOF
}

verify_source_file() {
  local task_id="$1" relative="$2" expected="$3" path
  path="$SOURCE_DIR/tasks/$task_id/$relative"
  require_file "$path"
  verify "$task_id $relative sha256" "$(sha256sum "$path" | cut -d' ' -f1)" "$expected"
}

stage_task_directory() {
  local task_id="$1" image_ref="$2" source_task="$SOURCE_DIR/tasks/$task_id" target
  target="$TASKS_DIR/$task_id"
  mkdir -p "$target/tests"
  install -m 0644 "$source_task/instruction.md" "$target/instruction.md"
  install -m 0755 "$source_task/tests/test.sh" "$target/tests/test.sh"
  install -m 0644 "$source_task/tests/test_outputs.py" "$target/tests/test_outputs.py"
  awk -v image="$image_ref" '
    /^docker_image = / { print "docker_image = \"" image "\""; next }
    /^allow_internet = / { print "network_mode = \"allowlist\"\nallowed_hosts = []\nos = \"linux\""; next }
    { print }
  ' "$source_task/task.toml" > "$target/task.toml"
}

normalize_context() {
  find "$BUILD_ROOT/runtime" -exec touch -h -d '1980-01-01T00:00:00Z' {} +
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

write_dockerfile() {
  local source_image="$1" context="$2"
  mkdir -p "$context"
  cp -a "$BUILD_ROOT/runtime/." "$context/"
  cat > "$context/Dockerfile" <<EOF
FROM $source_image
ARG SOURCE_DATE_EPOCH
COPY node /opt/node
COPY pi-agent /opt/pi-agent
COPY verifier /opt/terminal-bench-verifier
RUN ln -s /opt/node/bin/node /usr/local/bin/node \\
 && ln -s /opt/node/bin/npm /usr/local/bin/npm \\
 && ln -s /opt/pi-agent/dist/cli.js /usr/local/bin/pi \\
 && ln -s /opt/terminal-bench-verifier/bin/apt-get /usr/local/bin/apt-get \\
 && ln -s /opt/terminal-bench-verifier/bin/curl /usr/local/bin/curl \\
 && chmod +x /opt/pi-agent/dist/cli.js
EOF
  find "$context" -exec touch -h -d '1980-01-01T00:00:00Z' {} +
}

inspect_final_image() {
  local image_tag="$1" expected_digest="$2" image_ref config
  image_ref="$(docker image inspect "$image_tag" --format '{{index .RepoDigests 0}}')"
  verify "$image_tag digest" "${image_ref##*@}" "$expected_digest"
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
  local image_ref="$1"
  docker run --rm --network none --pull never --entrypoint /bin/sh "$image_ref" -lc \
    'node --version >/dev/null && npm --version >/dev/null && test "$(pi --version)" = 0.82.1 && python3 -c "import sys; sys.path.insert(0, \"/opt/terminal-bench-verifier/site-packages\"); import pytest"'
}

build_task() {
  local index="$1" task_id source_ref image_tag expected_digest context image_ref
  task_id="$(node -e 'console.log(require(process.argv[1]).tasks[+process.argv[2]].task_id)' "$MANIFEST" "$index")"
  source_ref="$(source_image_ref "$index")"
  image_tag="$(node -e 'console.log(require(process.argv[1]).tasks[+process.argv[2]].final_image_tag)' "$MANIFEST" "$index")"
  expected_digest="$(node -e 'console.log(require(process.argv[1]).tasks[+process.argv[2]].final_image_digest)' "$MANIFEST" "$index")"
  ensure_source_image "$source_ref"
  context="$BUILD_ROOT/$task_id"
  write_dockerfile "$source_ref" "$context"
  local archive="$BUILD_ROOT/$task_id.tar"
  docker buildx build --network none --pull=false --no-cache --provenance=false \
    --build-arg "SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH" \
    --output "type=oci,name=$image_tag,dest=$archive,rewrite-timestamp=true" \
    "$context" >/dev/null
  docker load --input "$archive" >/dev/null
  image_ref="$(inspect_final_image "$image_tag" "$expected_digest")"
  runtime_preflight "$image_ref"
  stage_task_directory "$task_id" "$image_ref"
  printf '{"task_id":%s,"task_path":%s,"image_ref":%s}' \
    "$(printf '%s' "$task_id" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(s)))')" \
    "$(printf '%s' "$TASKS_DIR/$task_id" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(s)))')" \
    "$(printf '%s' "$image_ref" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(s)))')"
}

require_file "$MANIFEST"
verify 'manifest schema' "$(json_text 'schema_version')" 'cortex-terminal-bench-images/1'
SOURCE_REPOSITORY="$(json_text 'source.repository')"
SOURCE_COMMIT="$(json_text 'source.commit')"
SOURCE_DATE_EPOCH="$(json_text 'build_epoch')"
export SOURCE_DATE_EPOCH
acquire_source "$SOURCE_REPOSITORY" "$SOURCE_COMMIT"
RUNTIME_INPUTS="$(resolve_input "$(json_text 'runtime_inputs')")"
require_file "$RUNTIME_INPUTS"
stage_runtime "$RUNTIME_INPUTS"
stage_verifier
normalize_context
mkdir -p "$TASKS_DIR"
TASK_COUNT="$(node -p 'require(process.argv[1]).tasks.length' "$MANIFEST")"
RESULTS=()
for ((index = 0; index < TASK_COUNT; index++)); do
  task_id="$(node -e 'console.log(require(process.argv[1]).tasks[+process.argv[2]].task_id)' "$MANIFEST" "$index")"
  while IFS=$'\t' read -r relative digest; do verify_source_file "$task_id" "$relative" "$digest"; done \
    < <(node -e 'const t=require(process.argv[1]).tasks[+process.argv[2]]; for(const [p,h] of Object.entries(t.source_files)) console.log(`${p}\t${h}`)' "$MANIFEST" "$index")
  RESULTS+=("$(build_task "$index")")
done
printf '{"ok":true,"source_commit":%s,"tasks":[' "$(printf '%s' "$SOURCE_COMMIT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(s)))')"
printf '%s' "${RESULTS[0]}"
for ((index = 1; index < ${#RESULTS[@]}; index++)); do printf ',%s' "${RESULTS[$index]}"; done
printf ']}\n'
