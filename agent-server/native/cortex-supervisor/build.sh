# input:  GCC, static glibc, supervisor C sources
# output: static binary and schema-versioned build manifest
# pos:    Reproducible root-free supervisor build entry point
# >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

set -euo pipefail

root="$(cd "$(dirname "$0")" && pwd)"
build_dir="$root/build"
dist_dir="$root/dist"
binary="$dist_dir/cortex-supervisor"
manifest="$dist_dir/build-manifest.json"
source_files=(
  build.sh
  src/cli.c
  src/cli.h
  src/main.c
  src/process-tree.c
  src/process-tree.h
  src/protocol.c
  src/protocol.h
  src/supervisor.c
  src/supervisor.h
)
source_units=(
  "$root/src/cli.c"
  "$root/src/main.c"
  "$root/src/process-tree.c"
  "$root/src/protocol.c"
  "$root/src/supervisor.c"
)

mkdir -p "$build_dir" "$dist_dir"
temporary_binary="$build_dir/cortex-supervisor.tmp"
gcc -D_GNU_SOURCE -std=c11 -O2 -Wall -Wextra -Werror -static \
  -I"$root/src" "${source_units[@]}" -o "$temporary_binary"

ldd_output="$(ldd "$temporary_binary" 2>&1 || true)"
if [[ "$ldd_output" != *"not a dynamic executable"* ]]; then
  printf 'Static-link verification failed: %s\n' "$ldd_output" >&2
  exit 1
fi
mv "$temporary_binary" "$binary"

inventory=""
for file in "${source_files[@]}"; do
  digest="$(sha256sum "$root/$file" | cut -d' ' -f1)"
  inventory+="$digest  $file"$'\n'
done
source_sha256="$(printf '%s' "$inventory" | sha256sum | cut -d' ' -f1)"
binary_sha256="$(sha256sum "$binary" | cut -d' ' -f1)"
target_arch="$(uname -m)"
target_triple="$(gcc -dumpmachine)"
compiler="gcc $(gcc -dumpfullversion -dumpversion)"
libc_version="$(getconf GNU_LIBC_VERSION | awk '{print $2}')"

temporary_manifest="$build_dir/build-manifest.json.tmp"
{
  printf '{\n'
  printf '  "schema_version": "cortex-supervisor-build/1",\n'
  printf '  "artifact": "dist/cortex-supervisor",\n'
  printf '  "source_files": [\n'
  for index in "${!source_files[@]}"; do
    suffix=','
    if [[ "$index" -eq "$((${#source_files[@]} - 1))" ]]; then suffix=''; fi
    printf '    "%s"%s\n' "${source_files[$index]}" "$suffix"
  done
  printf '  ],\n'
  printf '  "source_sha256": "%s",\n' "$source_sha256"
  printf '  "binary_sha256": "%s",\n' "$binary_sha256"
  printf '  "target_arch": "%s",\n' "$target_arch"
  printf '  "target_triple": "%s",\n' "$target_triple"
  printf '  "compiler": "%s",\n' "$compiler"
  printf '  "libc": { "name": "glibc", "version": "%s", "linkage": "static" }\n' "$libc_version"
  printf '}\n'
} > "$temporary_manifest"
mv "$temporary_manifest" "$manifest"

printf 'Built %s\nManifest %s\n' "$binary" "$manifest"
