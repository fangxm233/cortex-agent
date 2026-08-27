#!/usr/bin/env bash
# input:  pinned Terminal-Bench sources, vendor runtimes, Node/npm
# output: role-safe tasks and immutable runtime image refs
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
STAGE_ROOT=""
VENDOR_CHOSEN=0
VENDORS=(pi claude-code codex)

cleanup() {
  rm -r "$BUILD_ROOT"
}
trap cleanup EXIT

usage() {
  cat <<'EOF'
Usage: provision-terminal-bench-images.sh [--acquire] [--capture-digests] [--vendor <name>] [--cortex-smoke]
       provision-terminal-bench-images.sh --stage-runtimes <dir> [--acquire]

Provision every task/vendor variant, one vendor's variants, or the Cortex smoke image.
The command builds with no network or pull and prints immutable image references.

`--stage-runtimes` builds no image at all. It verifies the same pinned runtimes against the same
manifest and lays them out as the durable read-only roots a campaign's `runtimes:` block names, so
an arm can be measured on an unmodified upstream task image instead of one baked to hold the same
tree. It prints each staged root with its tree sha256.

Options:
  --acquire          Fetch missing pinned sources, images, and verifier wheels.
  --capture-digests  Bootstrap newly declared image digests without accepting them.
  --vendor           Build only pi, claude-code, or codex variants.
  --cortex-smoke     Build only the committed Cortex-compatible smoke image.
  --stage-runtimes   Stage the pinned runtimes into <dir> for mounting, and build nothing.
  -h, --help         Show this help.

Examples:
  benchmark/harness/scripts/provision-terminal-bench-images.sh
  benchmark/harness/scripts/provision-terminal-bench-images.sh --acquire
  benchmark/harness/scripts/provision-terminal-bench-images.sh --vendor codex
  benchmark/harness/scripts/provision-terminal-bench-images.sh --cortex-smoke
  benchmark/harness/scripts/provision-terminal-bench-images.sh --stage-runtimes /var/tmp/cortex-bench/runtimes
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --acquire) ACQUIRE=1 ;;
    --capture-digests) CAPTURE_DIGESTS=1 ;;
    --vendor)
      case "${2:-}" in
        pi|claude-code|codex) VENDORS=("$2"); VENDOR_CHOSEN=1; shift ;;
        *) printf 'invalid --vendor: %s (valid values: pi, claude-code, codex)\n' "${2:-}" >&2; exit 2 ;;
      esac
      ;;
    --cortex-smoke) CORTEX_SMOKE=1 ;;
    --stage-runtimes)
      STAGE_ROOT="${2:-}"
      test -n "$STAGE_ROOT" || { printf -- '--stage-runtimes requires a directory\n' >&2; exit 2; }
      shift
      ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown argument: %s (valid options: --acquire, --capture-digests, --vendor, --cortex-smoke, --stage-runtimes, --help, -h)\n' "$1" >&2; exit 2 ;;
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

# WITHIN one host only. The digest covers tar's header bytes as well as the file bytes, and GNU
# tar changed those between 1.34 and 1.35 -- two hosts holding byte-identical trees print
# different digests. Every comparison this script makes is host-local (a staged tree against a
# committed pin captured on the same kind of host), so that is sound here. Do not use a printed
# `tree_sha256` to decide whether two machines hold the same runtime; compare file content.
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
  stage_verifier_python
  write_verifier_wrappers
}

# Stage a relocatable interpreter for the 25 task images that ship none.
stage_verifier_python() {
  local python_version source root dest
  python_version="$(json_text 'verifier.python_version')"
  # It has to be a uv-MANAGED build. The host's system python is linked against this host's
  # library paths and is not relocatable into a task image; uv's are python-build-standalone
  # builds, which are relocatable and target glibc 2.17, older than any image in this corpus.
  source="$(uv python find --managed-python "$python_version" 2>/dev/null || true)"
  if [[ -z "$source" && "$ACQUIRE" == 1 ]]; then
    uv python install "$python_version" >/dev/null
    source="$(uv python find --managed-python "$python_version")"
  fi
  test -n "$source" || {
    printf 'no uv-managed CPython %s to stage; re-run with --acquire\n' "$python_version" >&2
    exit 1
  }
  root="$(cd "$(dirname "$source")/.." && pwd)"
  test -x "$root/bin/python3" || {
    printf 'staged interpreter root has no bin/python3: %s\n' "$root" >&2; exit 1
  }
  dest="$BUILD_ROOT/runtime/verifier/python"
  rm -rf "$dest"
  mkdir -p "$dest"
  cp -a "$root/." "$dest/"
  find "$dest" -type d -name __pycache__ -prune -exec rm -r {} +
  "$dest/bin/python3" -c 'import sys; sys.exit(0)' || {
    printf 'staged interpreter does not run: %s\n' "$dest/bin/python3" >&2; exit 1
  }
}

write_verifier_wrappers() {
  local bin="$BUILD_ROOT/runtime/verifier/bin"
  mkdir -p "$bin"
  # The image's own python3 comes first, and the bundled interpreter is only a fallback. That
  # order is the whole point: a task whose tests `import numpy` or build a C extension against
  # `/usr/local/include/python3.13` needs the interpreter those packages were installed for, and
  # substituting ours would break tests that work today. But 25 of the 89 task images ship no
  # python at all, and there this shim died with `exec: python3: not found` -- 116 trials across
  # the two 2026-08-27 segments scored 0 because the VERIFIER could not start, not because the
  # agent failed. An image with no python also has no image-installed python packages to import,
  # so the fallback is safe exactly where it is needed.
  cat > "$bin/uvx" <<'EOF'
#!/bin/sh
set -eu
while [ "$#" -gt 0 ]; do
  case "$1" in
    -p|-w) shift 2 ;;
    pytest)
      shift
      if command -v python3 >/dev/null 2>&1; then
        interpreter=python3
      else
        interpreter=/opt/terminal-bench-verifier/python/bin/python3
      fi
      PYTHONPATH=/opt/terminal-bench-verifier/site-packages exec "$interpreter" -m pytest "$@"
      ;;
    *) printf 'unsupported offline uvx argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done
EOF
  # An install request for a package the image already carries is a no-op for real apt-get, and
  # refusing it was simply wrong: `sam-cell-seg` asks for git and ships git, `extract-elf` asks for
  # gcc and ships gcc. Those trials scored 0 on a verifier that stopped before running a single
  # test. This asks dpkg what is actually installed and only refuses what is genuinely absent --
  # naming it, so the log says which package the offline trial could not supply instead of
  # repeating a fixed sentence about curl.
  cat > "$bin/apt-get" <<'EOF'
#!/bin/sh
case "${1:-}" in
  update) exit 0 ;;
  install)
    shift
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -y|-q|-qq|--yes|--quiet|--no-install-recommends) shift ;;
        *) break ;;
      esac
    done
    missing=''
    for package in "$@"; do
      # curl is served by the shim beside this one, whatever the image holds.
      [ "$package" = curl ] && continue
      if command -v dpkg >/dev/null 2>&1 && dpkg -s "$package" >/dev/null 2>&1; then
        continue
      fi
      missing="$missing $package"
    done
    [ -z "$missing" ] && exit 0
    printf 'offline apt-get cannot install:%s\n' "$missing" >&2
    exit 2
    ;;
esac
printf 'offline apt-get supports only update and install\n' >&2
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

stage_mounted_npm() {
  # A baked image installs npm into the Node prefix at build time (see write_smoke_dockerfile).
  # A mounted Node root is read-only at trial time, so the same layout has to exist before the
  # mount does: npm under the prefix, and the two relative links a Node distribution ships. A
  # Cortex arm needs `npm ls --offline` to find its own installed bundle, so this is not optional
  # for the arm that mounts Node.
  local npm_root
  npm_root="${NPM_ROOT:-$(dirname "$(dirname "$(readlink -f "$(command -v npm)")")")}"
  mkdir -p "$STAGE_ROOT/node/lib/node_modules"
  cp -a "$npm_root" "$STAGE_ROOT/node/lib/node_modules/npm"
  ln -sfn ../lib/node_modules/npm/bin/npm-cli.js "$STAGE_ROOT/node/bin/npm"
  ln -sfn ../lib/node_modules/npm/bin/npx-cli.js "$STAGE_ROOT/node/bin/npx"
  find "$STAGE_ROOT/node" -exec touch -h -d '1980-01-01T00:00:00Z' {} +
}

publish_staged_runtimes() {
  # The mount layout the harness admits: one name, one root, matching
  # `launcher/runtime_mounts.py::RUNTIME_TARGETS`. A staged root is replaced wholesale rather than
  # merged, so a re-stage after a version bump cannot leave the previous tree half in place.
  local name source records=()
  mkdir -p "$STAGE_ROOT"
  for name in node "${VENDORS[@]}" verifier; do
    case "$name" in
      node) source="$BUILD_ROOT/runtime/node" ;;
      verifier) source="$BUILD_ROOT/runtime/verifier" ;;
      claude-code) continue ;;
      *) source="$BUILD_ROOT/runtime/vendors/$name" ;;
    esac
    test -d "$source" || continue
    rm -rf "${STAGE_ROOT:?}/$name"
    cp -a "$source" "$STAGE_ROOT/$name"
    if [[ "$name" == node ]]; then stage_mounted_npm; fi
    records+=("$(printf '{"name":%s,"root":%s,"tree_sha256":%s}' \
      "$(json_string "$name")" "$(json_string "$STAGE_ROOT/$name")" \
      "$(json_string "$(tree_sha256 "$STAGE_ROOT/$name")")")")
  done
  printf '{"ok":true,"stage_root":%s,"runtimes":[' "$(json_string "$STAGE_ROOT")"
  printf '%s' "${records[0]}"
  for ((index = 1; index < ${#records[@]}; index++)); do printf ',%s' "${records[$index]}"; done
  printf ']}\n'
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

build_legacy_task() {
  local index="$1" task_id source_ref image_tag expected context archive image_ref
  task_id="$(node -e 'console.log(require(process.argv[1]).tasks[+process.argv[2]].task_id)' "$MANIFEST" "$index")"
  source_ref="$(source_image_ref "$index")"
  image_tag="$(task_image_tag "$index")"
  expected="$(task_image_digest "$index")"
  context="$BUILD_ROOT/build/$task_id/pi"
  write_dockerfile "$source_ref" pi "$context"
  archive="$BUILD_ROOT/$task_id-pi.tar"
  docker buildx build --network none --pull=false --no-cache --provenance=false \
    --build-arg "SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH" \
    --output "type=oci,name=$image_tag,dest=$archive,rewrite-timestamp=true" \
    "$context" >/dev/null
  docker load --input "$archive" >/dev/null
  image_ref="$(inspect_final_image "$image_tag" "$expected")"
  runtime_preflight pi "$image_ref"
  stage_task_directory "$task_id" cortex "$image_ref"
  printf '{"task_id":%s,"task_path":%s,"image_ref":%s}' \
    "$(json_string "$task_id")" \
    "$(json_string "$TASKS_DIR/$task_id")" "$(json_string "$image_ref")"
}

build_variant() {
  local index="$1" vendor="$2" task_id source_ref image_tag expected context archive image_ref
  task_id="$(node -e 'console.log(require(process.argv[1]).tasks[+process.argv[2]].task_id)' "$MANIFEST" "$index")"
  source_ref="$(source_image_ref "$index")"
  image_tag="$(task_image_tag "$index" "$vendor")"
  expected="$(task_image_digest "$index" "$vendor")"
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

manifest_schema() {
  json_text 'schema_version'
}

task_image_tag() {
  local index="$1" vendor="${2:-}"
  if [[ "$MANIFEST_SCHEMA" == 'cortex-terminal-bench-images/1' ]]; then
    node -e 'console.log(require(process.argv[1]).tasks[+process.argv[2]].final_image_tag)' "$MANIFEST" "$index"
  else
    node -e 'console.log(require(process.argv[1]).tasks[+process.argv[2]].variants[process.argv[3]].final_image_tag)' "$MANIFEST" "$index" "$vendor"
  fi
}

task_image_digest() {
  local index="$1" vendor="${2:-}"
  if [[ "$MANIFEST_SCHEMA" == 'cortex-terminal-bench-images/1' ]]; then
    node -e 'console.log(require(process.argv[1]).tasks[+process.argv[2]].final_image_digest)' "$MANIFEST" "$index"
  else
    node -e 'console.log(require(process.argv[1]).tasks[+process.argv[2]].variants[process.argv[3]].final_image_digest)' "$MANIFEST" "$index" "$vendor"
  fi
}

validate_manifest_tags() {
  node - "$MANIFEST" <<'EOF'
const manifest = require(process.argv[2]);
const schema = manifest.schema_version;
const errors = [];
const seen = new Map();
const repo = 'cortex-terminal-bench-2.1';

function fail(message) {
  errors.push(message);
}

function expectTag(owner, actual, expected) {
  if (actual !== expected) {
    fail(`${owner} final_image_tag must be ${JSON.stringify(expected)}; got ${JSON.stringify(actual)}`);
  }
  const previous = seen.get(actual);
  if (previous) {
    fail(`final_image_tag ${JSON.stringify(actual)} is reused by ${previous} and ${owner}`);
  } else {
    seen.set(actual, owner);
  }
}

if (schema === 'cortex-terminal-bench-images/1') {
  const version = manifest.vendors?.pi?.version ?? '0.82.1';
  for (const task of manifest.tasks ?? []) {
    expectTag(
      `schema /1 task ${task.task_id}`,
      task.final_image_tag,
      `${repo}:${task.task_id}-cortex-pi-${version}`,
    );
  }
} else if (schema === 'cortex-terminal-bench-images/2') {
  const vendors = manifest.vendors ?? {};
  for (const task of manifest.tasks ?? []) {
    for (const [vendor, metadata] of Object.entries(vendors)) {
      const variant = task.variants?.[vendor];
      if (!variant) {
        fail(`schema /2 task ${task.task_id} is missing variants.${vendor}`);
        continue;
      }
      const role = vendor === 'pi' ? 'vendor-pi' : vendor;
      expectTag(
        `schema /2 task ${task.task_id} vendor ${vendor}`,
        variant.final_image_tag,
        `${repo}:${task.task_id}-${role}-${metadata.version}`,
      );
    }
  }
  const smoke = manifest.cortex_smoke;
  if (smoke?.final_image_tag) {
    const previous = seen.get(smoke.final_image_tag);
    if (previous) {
      fail(`final_image_tag ${JSON.stringify(smoke.final_image_tag)} is reused by ${previous} and cortex_smoke`);
    }
  }
} else {
  fail(`manifest schema must be cortex-terminal-bench-images/1 or /2; got ${JSON.stringify(schema)}`);
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
EOF
}

require_file "$MANIFEST"
require_file "$PREFLIGHT_SCRIPT"
MANIFEST_SCHEMA="$(manifest_schema)"
validate_manifest_tags
case "$MANIFEST_SCHEMA" in
  cortex-terminal-bench-images/1|cortex-terminal-bench-images/2) ;;
  *) printf 'manifest schema must be cortex-terminal-bench-images/1 or /2; got %s\n' "$MANIFEST_SCHEMA" >&2; exit 1 ;;
esac
if [[ "$MANIFEST_SCHEMA" == 'cortex-terminal-bench-images/1' ]]; then
  if [[ "$CORTEX_SMOKE" == 1 ]]; then
    printf '--cortex-smoke requires a cortex-terminal-bench-images/2 manifest\n' >&2
    exit 1
  fi
  if [[ ${#VENDORS[@]} -ne 3 ]]; then
    printf '--vendor requires a cortex-terminal-bench-images/2 manifest\n' >&2
    exit 1
  fi
fi
SOURCE_REPOSITORY="$(json_text 'source.repository')"
SOURCE_COMMIT="$(json_text 'source.commit')"
SOURCE_DATE_EPOCH="$(json_text 'build_epoch')"
export SOURCE_DATE_EPOCH
RUNTIME_INPUTS="$(resolve_input "$(json_text 'runtime_inputs')")"
require_file "$RUNTIME_INPUTS"
if [[ -n "$STAGE_ROOT" ]]; then
  # No image is built, so the pinned Terminal-Bench source tree is not needed and not fetched.
  # Claude Code is a single binary rather than a mountable tree and has no admitted mount target,
  # so it is not staged unless it was asked for by name.
  if [[ "$VENDOR_CHOSEN" != 1 ]]; then VENDORS=(pi codex); fi
  stage_runtimes
  stage_verifier
  find "$BUILD_ROOT/runtime" -exec touch -h -d '1980-01-01T00:00:00Z' {} +
  publish_staged_runtimes
  exit 0
fi
acquire_source "$SOURCE_REPOSITORY" "$SOURCE_COMMIT"
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
  if [[ "$MANIFEST_SCHEMA" == 'cortex-terminal-bench-images/1' ]]; then
    RESULTS+=("$(build_legacy_task "$index")")
  else
    for vendor in "${VENDORS[@]}"; do RESULTS+=("$(build_variant "$index" "$vendor")"); done
  fi
done
if [[ "$MANIFEST_SCHEMA" == 'cortex-terminal-bench-images/1' ]]; then
  printf '{"ok":true,"source_commit":%s,"tasks":[' "$(json_string "$SOURCE_COMMIT")"
else
  printf '{"ok":true,"source_commit":%s,"variants":[' "$(json_string "$SOURCE_COMMIT")"
fi
printf '%s' "${RESULTS[0]}"
for ((index = 1; index < ${#RESULTS[@]}; index++)); do printf ',%s' "${RESULTS[$index]}"; done
printf ']}\n'
