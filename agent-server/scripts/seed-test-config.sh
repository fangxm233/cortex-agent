#!/usr/bin/env bash
# input:  Initialized CORTEX_HOME path
# output: Test-compatible machine and Claude/PI profile configuration
# pos:    Full-suite fixture seeding after cortex init
# >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
# Usage: bash scripts/seed-test-config.sh <CORTEX_HOME>
#
# Overwrites:
#   $CORTEX_HOME/config/machines.json  → generic testbox entry
#   $CORTEX_HOME/config/profiles.json  → minimal profile set

set -euo pipefail

CORTEX_HOME="${1:?Usage: $0 <CORTEX_HOME>}"
CONFIG_DIR="$CORTEX_HOME/config"
mkdir -p "$CONFIG_DIR"

# ── machines.json ──────────────────────────────────────────────

cat > "$CONFIG_DIR/machines.json" <<'MACHINES'
{"testbox": {"gpuCount": 2, "cortexPath": "CORTEX_HOME_PLACEHOLDER"}}
MACHINES

# Replace placeholder with actual path (sed -i differs between Linux/macOS)
sed -i "s|CORTEX_HOME_PLACEHOLDER|$CORTEX_HOME|g" "$CONFIG_DIR/machines.json"

# ── profiles.json ──────────────────────────────────────────────

cat > "$CONFIG_DIR/profiles.json" <<'PROFILES'
{
  "defaultProfile": "plan",
  "profiles": {
    "plan": {
      "model": "claude-sonnet-4-6",
      "backend": "claude",
      "mode": "plan",
      "fallback": [
        { "model": "claude-sonnet-4-6", "backend": "claude", "mode": "api" },
        { "model": "claude-sonnet-4-6", "backend": "claude", "mode": "plan" }
      ]
    },
    "execute": {
      "model": "claude-sonnet-4-6",
      "backend": "pi",
      "provider": "anthropic",
      "mode": "plan",
      "fallback": [
        { "model": "claude-sonnet-4-6", "backend": "claude", "mode": "plan" }
      ]
    },
    "scan":    { "model": "claude-sonnet-4-6", "backend": "claude", "mode": "plan" },
    "qa":      { "model": "claude-sonnet-4-6", "backend": "claude", "mode": "plan" }
  }
}
PROFILES

echo "[seed-test-config] machines.json → $CONFIG_DIR/machines.json"
echo "[seed-test-config] profiles.json → $CONFIG_DIR/profiles.json"
