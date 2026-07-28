#!/usr/bin/env bash
# Seed CORTEX_HOME with test-compatible machines.json and profiles.json.
# Run after `cortex init` to make the directory ready for the test suite.
#
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
