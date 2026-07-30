#!/usr/bin/env bash
#
# Build a signed Android release APK (single ABI, ~arm64) for Cortex.
#
# What it automates
# ─────────────────
#   1. Loads machine-specific toolchain paths + the release keystore (path/alias/passwords) from a
#      config file OUTSIDE the repo (default: ~/.cortex/config/android-release.env) — no secrets here.
#   2. Builds the web SPA and stages connect.html (the OTA seed embeds web/dist at Rust compile time).
#   3. Runs `tauri android init` only when gen/android is absent (it is gitignored + regenerated on a
#      fresh checkout; init WIPES any signing wiring, hence steps 4-5 re-apply it every run).
#   4. Writes gen/android/app/keystore.properties from the loaded keystore vars.
#   5. Restores release signingConfig wiring when the generated Gradle template omits it, then
#      verifies the release build points at the configured keystore.
#   6. Builds the signed release APK and prints + verifies it.
#
# Usage:  desktop/scripts/android-release.sh [--init] [--target <abi>]
#   --init          force `tauri android init` even if gen/android exists (after a tauri.conf change)
#   --target <abi>  Rust target ABI (default: aarch64). Drop to build all ABIs by passing "all".
#
set -euo pipefail

TARGET="aarch64"
FORCE_INIT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --init) FORCE_INIT=1; shift ;;
    --target) TARGET="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# ── Locate repo + config ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="$(cd "$DESKTOP_DIR/.." && pwd)"
CONF="${CORTEX_ANDROID_ENV:-$HOME/.cortex/config/android-release.env}"

if [ ! -f "$CONF" ]; then
  echo "error: config not found: $CONF" >&2
  echo "  create it with JAVA_HOME/ANDROID_HOME/NDK_HOME + CORTEX_ANDROID_KEYSTORE/KEY_ALIAS/STORE_PASS/KEY_PASS" >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$CONF"

: "${JAVA_HOME:?set JAVA_HOME in $CONF}"
: "${ANDROID_HOME:?set ANDROID_HOME in $CONF}"
: "${NDK_HOME:?set NDK_HOME in $CONF}"
: "${CORTEX_ANDROID_KEYSTORE:?set CORTEX_ANDROID_KEYSTORE in $CONF}"
: "${CORTEX_ANDROID_KEY_ALIAS:?set CORTEX_ANDROID_KEY_ALIAS in $CONF}"
: "${CORTEX_ANDROID_STORE_PASS:?set CORTEX_ANDROID_STORE_PASS in $CONF}"
: "${CORTEX_ANDROID_KEY_PASS:?set CORTEX_ANDROID_KEY_PASS in $CONF}"

if [ ! -f "$CORTEX_ANDROID_KEYSTORE" ]; then
  echo "error: keystore not found: $CORTEX_ANDROID_KEYSTORE" >&2
  exit 1
fi

export ANDROID_NDK_HOME="${ANDROID_NDK_HOME:-$NDK_HOME}"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmake/3.22.1/bin:$PATH"

cd "$DESKTOP_DIR"
GEN_APP="src-tauri/gen/android/app"

echo "=== 1/5  build web SPA + stage connect.html ==="
pnpm --filter '@cortex-agent/web...' build
npm run copy-connect

if [ "$FORCE_INIT" = "1" ] || [ ! -d "src-tauri/gen/android" ]; then
  echo "=== 2/5  tauri android init (regenerates gen/) ==="
  npx tauri android init
else
  echo "=== 2/5  gen/android exists — skipping init (pass --init to force) ==="
fi

echo "=== 2.5  apply Cortex 25c launcher icons (init ships the green placeholder) ==="
bash "$SCRIPT_DIR/gen-android-icons.sh"

echo "=== 3/5  write keystore.properties ==="
# storeFile is read by build.gradle.kts via file(...) relative to the app module, so use an
# absolute path to be location-independent.
cat > "$GEN_APP/keystore.properties" <<EOF
storeFile=$CORTEX_ANDROID_KEYSTORE
storePassword=$CORTEX_ANDROID_STORE_PASS
keyAlias=$CORTEX_ANDROID_KEY_ALIAS
keyPassword=$CORTEX_ANDROID_KEY_PASS
EOF

echo "=== 4/5  ensure release signingConfig is wired ==="
GRADLE="$GEN_APP/build.gradle.kts"
if ! grep -q 'create("release")' "$GRADLE" || ! grep -q 'signingConfig = signingConfigs.getByName("release")' "$GRADLE"; then
  node - "$GRADLE" <<'NODE'
const fs = require('fs');
const gradlePath = process.argv[2];
let source = fs.readFileSync(gradlePath, 'utf8');
const androidMarker = 'android {\n';
const releaseMarker = '        getByName("release") {\n';
if (!source.includes(androidMarker) || !source.includes(releaseMarker)) {
  throw new Error(`unsupported generated Gradle layout: ${gradlePath}`);
}
const signing = `val keystoreProperties = Properties().apply {
    val propFile = file("keystore.properties")
    propFile.inputStream().use { load(it) }
}

android {
    signingConfigs {
        create("release") {
            keyAlias = keystoreProperties.getProperty("keyAlias")
            keyPassword = keystoreProperties.getProperty("keyPassword")
            storeFile = file(keystoreProperties.getProperty("storeFile"))
            storePassword = keystoreProperties.getProperty("storePassword")
        }
    }
`;
source = source.replace(androidMarker, signing);
source = source.replace(
  releaseMarker,
  `${releaseMarker}            signingConfig = signingConfigs.getByName("release")\n`,
);
fs.writeFileSync(gradlePath, source);
NODE
fi
if ! grep -q 'create("release")' "$GRADLE" || ! grep -q 'signingConfig = signingConfigs.getByName("release")' "$GRADLE"; then
  echo "error: failed to wire release signingConfig in $GRADLE" >&2
  exit 1
fi

echo "=== 5/5  build signed release APK (target: $TARGET) ==="
if [ "$TARGET" = "all" ]; then
  npx tauri android build --apk
else
  npx tauri android build --apk --target "$TARGET"
fi

APK="$(find src-tauri/gen/android/app/build/outputs/apk -path '*release*' -name '*.apk' -printf '%T@ %p\n' | sort -rn | head -1 | cut -d' ' -f2-)"
if [ -z "$APK" ]; then
  echo "error: no release APK found under build/outputs/apk" >&2
  exit 1
fi

echo
echo "APK: $DESKTOP_DIR/$APK"
ls -la "$APK"
echo "=== signature ==="
APKSIGNER="$(find "$ANDROID_HOME/build-tools" -name apksigner | sort -V | tail -1)"
"$APKSIGNER" verify --print-certs "$APK" | grep -E 'Signer|Verified' || true
