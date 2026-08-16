#!/bin/bash
# input:  script-relative checkout, public remote, sync tracking ref
# output: fetched commits cherry-picked onto the current checkout
# pos:    Synchronizes public/main changes into the private main branch
# >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
LOG_FILE="/tmp/cortex-sync-pull.log"
TRACKING_REF="refs/sync/public-last"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

cd "$REPO_DIR"

# Guard: skip if working tree is dirty
if ! git diff-index --quiet HEAD --; then
  log "SKIP: working tree is dirty"
  exit 0
fi

# Guard: skip if in the middle of a rebase
if [ -d ".git/rebase-merge" ] || [ -d ".git/rebase-apply" ]; then
  log "SKIP: rebase in progress"
  exit 0
fi

# Fetch from public remote
log "Fetching from public remote..."
if ! git fetch public 2>&1 | tee -a "$LOG_FILE"; then
  log "ERROR: git fetch public failed"
  exit 1
fi

# Determine the baseline: if tracking ref exists, use it; otherwise initialize
# to public/main to skip all historical commits (already reflected in main's state).
if git rev-parse --verify "$TRACKING_REF" >/dev/null 2>&1; then
  BASELINE=$(git rev-parse "$TRACKING_REF")
else
  BASELINE=$(git rev-parse public/main)
  git update-ref "$TRACKING_REF" "$BASELINE"
  log "First run: tracking ref set to public/main ($(git rev-parse --short $BASELINE)), skipping historical commits"
  log "OK: nothing new to sync"
  exit 0
fi

# Find commits on public/main newer than tracking ref
NEW_COMMITS=$(git log --oneline --reverse "${BASELINE}..public/main" 2>/dev/null || true)

if [ -z "$NEW_COMMITS" ]; then
  log "OK: no new commits since $(git rev-parse --short $BASELINE)"
  exit 0
fi

log "Found new commits on public/main since $(git rev-parse --short $BASELINE):"
echo "$NEW_COMMITS" | tee -a "$LOG_FILE"

# Switch to main
CURRENT_BRANCH=$(git branch --show-current)
if [ "$CURRENT_BRANCH" != "main" ]; then
  git checkout main 2>/dev/null || { log "ERROR: could not checkout main"; exit 1; }
fi

# Cherry-pick each new commit from public/main to main
FAILED=0
COUNT=0
LAST_SUCCESSFUL="$BASELINE"

while IFS= read -r line; do
  HASH=$(echo "$line" | awk '{print $1}')
  MSG=$(echo "$line" | cut -d' ' -f2-)
  log "Cherry-picking $HASH: $MSG"

  if git cherry-pick "$HASH" 2>&1 | tee -a "$LOG_FILE"; then
    COUNT=$((COUNT + 1))
    LAST_SUCCESSFUL="$HASH"
    log "OK: cherry-picked $HASH"
  else
    if git diff --cached --quiet 2>/dev/null; then
      log "SKIP: commit $HASH already applied"
      git cherry-pick --skip 2>/dev/null || git cherry-pick --abort 2>/dev/null || true
      LAST_SUCCESSFUL="$HASH"
    else
      FAILED=$((FAILED + 1))
      log "CONFLICT: cherry-pick failed for $HASH — aborting"
      git cherry-pick --abort 2>/dev/null || true
    fi
  fi
done <<< "$NEW_COMMITS"

# Advance tracking ref
git update-ref "$TRACKING_REF" "$LAST_SUCCESSFUL"
log "Advanced tracking ref to $(git rev-parse --short $LAST_SUCCESSFUL)"

# Return to original branch
if [ "$CURRENT_BRANCH" != "main" ]; then
  git checkout "$CURRENT_BRANCH" 2>/dev/null || true
fi

log "Sync complete: $COUNT cherry-picked, $FAILED failed"
if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
