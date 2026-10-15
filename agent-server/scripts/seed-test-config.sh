#!/usr/bin/env bash
# Usage: bash scripts/seed-test-config.sh <CORTEX_HOME>
#
# Overwrites:
#   $CORTEX_HOME/config/machines.json  → generic testbox entry
#   $CORTEX_HOME/config/models.json    → default selection and favorites

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

# ── models.json ────────────────────────────────────────────────

cat > "$CONFIG_DIR/models.json" <<'MODELS'
{
  "default": { "backend": "claude", "provider": null, "model": "claude-sonnet-4-6", "thinking": null, "mode": "plan" },
  "favorites": [
    { "backend": "claude", "provider": null, "model": "claude-sonnet-4-6" },
    { "backend": "pi", "provider": "anthropic", "model": "claude-sonnet-4-6" }
  ]
}
MODELS

echo "[seed-test-config] machines.json → $CONFIG_DIR/machines.json"
echo "[seed-test-config] models.json → $CONFIG_DIR/models.json"
